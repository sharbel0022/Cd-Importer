import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { ffmpegPath } from "../ffmpeg";
import { AppError } from "../errors";
import { EXTENSIONS, type MediaInfo } from "./types";

export async function ffmpeg(args: string[], signal: AbortSignal, timeout = 600_000, onDiagnostic?: (block: string) => void): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ ffmpegPath(), ["-nostdin", "-hide_banner", "-y", "-threads", "2", ...args], { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = ""; let expired = false;
    const cancel = () => child.kill("SIGKILL"); signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { expired = true; cancel(); }, timeout);
    child.stderr.on("data", (b: Buffer) => { const block = b.toString(); onDiagnostic?.(block); diagnostic = (diagnostic + block).slice(-48000); });
    child.on("error", () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(new AppError("FFmpeg kunde inte startas. Kontrollera installationen.", 503)); });
    child.on("close", (code) => {
      clearTimeout(timer); signal.removeEventListener("abort", cancel);
      if (signal.aborted) reject(signal.reason);
      else if (expired) reject(new AppError("Mediebearbetningen överskred tidsgränsen.", 504));
      else if (code !== 0) reject(new AppError("FFmpeg kunde inte läsa eller bearbeta filen. Kontrollera format och ljudspår.", 422));
      else resolve(diagnostic);
    });
  });
}
export function inputArgs(file: string, extension = path.extname(file).slice(1)): string[] {
  const demuxer = EXTENSIONS[extension];
  if (!demuxer) throw new AppError("Filformatet stöds inte.", 415);
  return ["-protocol_whitelist", "file,pipe", "-f", demuxer, "-i", file];
}
export async function inspect(file: string, signal: AbortSignal, extension?: string): Promise<Omit<MediaInfo, "waveform">> {
  const diagnostic = await ffmpeg([...inputArgs(file, extension), "-t", "0", "-map", "0:a:0", "-f", "null", "-"], signal, 30_000);
  const d = diagnostic.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const a = diagnostic.match(/Audio:.*?,\s*(\d+) Hz,\s*([^,\r\n]+)/);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : NaN;
  if (!(duration > 0 && Number.isFinite(duration)) || !a) throw new AppError("Filen måste ha ett läsbart ljudspår och en känd längd.", 422);
  const channels = a[2].includes("stereo") ? 2 : a[2].includes("mono") ? 1 : Number(a[2].match(/(\d+) channels/)?.[1]) || (a[2].includes("5.1") ? 6 : a[2].includes("7.1") ? 8 : 1);
  return { duration, sampleRate: Number(a[1]), channels, video: /Stream #.*Video:/.test(diagnostic) };
}
export async function normalize(file: string, output: string, signal: AbortSignal, limit: number, extension?: string) {
  await ffmpeg([...inputArgs(file, extension), "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", String(limit + 1), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-map_metadata", "-1", output], signal);
}
export async function chunk(file: string, output: string, start: number, duration: number, signal: AbortSignal) {
  await ffmpeg(["-ss", String(start), ...inputArgs(file), "-t", String(duration), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output], signal);
}
export async function silenceBoundaries(file: string, signal: AbortSignal): Promise<number[]> {
  const result: number[] = []; let start: number | undefined; let pending = "";
  const consume = (line: string) => {
    for (const match of line.matchAll(/silence_(start|end):\s*(\d+(?:\.\d+)?)/gu)) {
      if (match[1] === "start") start = Number(match[2]);
      else if (start !== undefined) { if (result.length < 25_000) result.push((start + Number(match[2])) / 2); start = undefined; }
    }
  };
  // Parse while FFmpeg runs, so early pauses are not lost from its bounded
  // diagnostic tail. 25k boundaries cover the two-hour upload limit at 300 ms.
  await ffmpeg([...inputArgs(file), "-af", "silencedetect=noise=-35dB:d=0.3", "-f", "null", "-"], signal, 600_000, (block) => {
    const lines = (pending + block).split(/[\r\n]/u); pending = lines.pop()!.slice(-4096);
    for (const line of lines) consume(line);
  });
  consume(pending);
  return result;
}
export async function waveform(file: string, _dir: string, signal: AbortSignal, timelineDuration?: number) {
  const f = await open(file, "r"); const header = Buffer.alloc(4096); let start = 0; let sampleCount = 0;
  try {
    await f.read(header, 0, header.length, 0);
    for (let offset = 12; offset + 8 <= header.length;) {
      const size = header.readUInt32LE(offset + 4);
      if (header.toString("ascii", offset, offset + 4) === "data") { start = offset + 8; sampleCount = Math.floor(size / 2); break; }
      offset += 8 + size + size % 2;
    }
  } finally { await f.close(); }
  if (!start || !sampleCount) throw new AppError("Normaliserat ljud saknar PCM-data.", 422);
  const timelineSamples = Math.max(sampleCount, Math.round((timelineDuration || 0) * 16000));
  const result = new Array<number>(Math.min(1000, timelineSamples)).fill(0); let position = 0;
  for await (const block of createReadStream(file, { start, end: start + sampleCount * 2 - 1, signal })) {
    const bytes = block as Buffer;
    for (let n = 0; n + 1 < bytes.length; n += 2) { const bin = Math.min(result.length - 1, Math.floor(position++ / timelineSamples * result.length)); result[bin] = Math.max(result[bin], Math.abs(bytes.readInt16LE(n)) / 32768); }
  }
  return result;
}
export async function speechDuration(file: string, signal: AbortSignal) {
  const result = await ffmpeg([...inputArgs(file), "-af", "astats=metadata=0:reset=0", "-f", "null", "-"], signal, 120000);
  const levels = [...result.matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?|-inf)/g)].map((m) => Number(m[1]));
  if (!levels.length || levels.every((v) => !Number.isFinite(v) || v < -65)) throw new AppError("TTS-ljudet är tyst eller saknar hörbart tal. Jobbet stoppades.", 502);
  return (await inspect(file, signal)).duration;
}
export async function trimSpeech(file: string, signal: AbortSignal) {
  const output = `${file}.trim.wav`;
  // Trim only the two outer edges. Keep 80 ms around speech; internal pauses
  // and quiet consonants are retained. Reversal avoids deleting inner pauses.
  const edge = "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-55dB:start_silence=0.08";
  await ffmpeg([...inputArgs(file), "-af", `${edge},areverse,${edge},areverse`, "-c:a", "pcm_s16le", output], signal);
  return output;
}
// Sparse float PCM, absolute sample positions: no accumulated concat drift.
export async function createTimeline(file: string, duration: number) {
  const f = await open(file, "w"); try { await f.truncate(Math.ceil(duration * 24000) * 4); } finally { await f.close(); }
}
export class SpeechWindowError extends AppError {
  constructor(public readonly overflowMs: number) { super("Genererat tal ryms inte utan överlappning eller avklippning. Justera text eller tidsstämplar.", 422); }
}
export async function placeSpeech(timeline: string, speech: string, start: number, tempo: number, dir: string, signal: AbortSignal, availableSeconds?: number) {
  if (!(start >= 0 && Number.isFinite(start) && tempo >= 0.5 && tempo <= 2)) throw new AppError("Ogiltig talposition eller taltempo.", 422);
  const raw = path.join(dir, "current-speech.pcm");
  await ffmpeg([...inputArgs(speech), "-af", `atempo=${tempo.toFixed(6)}`, "-ar", "24000", "-ac", "1", "-f", "f32le", raw], signal);
  const source = await open(raw, "r"); const destination = await open(timeline, "r+");
  const total = (await destination.stat()).size; let position = Math.round(start * 24000) * 4; let offset = 0;
  const available = Math.max(0, Math.min(total - position, availableSeconds === undefined ? total : Math.floor(availableSeconds * 24000) * 4));
  const incoming = Buffer.alloc(65536); const existing = Buffer.alloc(65536);
  try {
    const speechBytes = (await source.stat()).size;
    // Reject before writing any samples. The old loop silently discarded speech
    // beyond the file end and could mix speech over the next sentence.
    if (speechBytes > available) throw new SpeechWindowError(Math.ceil((speechBytes - available) / 96));
    while (position < total) {
      signal.throwIfAborted();
      const { bytesRead } = await source.read(incoming, 0, Math.min(incoming.length, total - position), offset); if (!bytesRead) break;
      existing.fill(0); await destination.read(existing, 0, bytesRead, position);
      for (let n = 0; n < bytesRead; n += 4) existing.writeFloatLE(existing.readFloatLE(n) + incoming.readFloatLE(n), n);
      let written = 0; while (written < bytesRead) written += (await destination.write(existing, written, bytesRead - written, position + written)).bytesWritten;
      offset += bytesRead; position += bytesRead;
    }
  } finally { await source.close(); await destination.close(); }
}
export async function renderTrack(dir: string, target: string, duration: number, original: string, mode: "replace" | "voiceover", background: string | undefined, signal: AbortSignal) {
  const output = path.join(dir, `${target}.wav`);
  const inputs = ["-f", "f32le", "-ar", "24000", "-ac", "1", "-i", path.join(dir, `${target}.pcm`)];
  const bed = background || (mode === "voiceover" ? original : undefined);
  if (bed) inputs.push(...inputArgs(bed));
  const filters = (effect: string) => bed ? ["-filter_complex", `[0:a]aformat=channel_layouts=stereo[voice];[1:a]volume=${background ? "1" : "0.15"},aformat=channel_layouts=stereo[bed];[voice][bed]amix=inputs=2:duration=first:normalize=0,${effect}[out]`, "-map", "[out]"] : ["-af", effect];
  const loudnorm = "loudnorm=I=-16:TP=-1.5:LRA=11";
  // Measure the complete mix before applying one global normalization pass.
  // Single-pass dynamic loudnorm can overshoot badly on short, sparse clips.
  const measurement = await ffmpeg([...inputs, ...filters(`${loudnorm}:print_format=json`), "-t", String(duration), "-f", "null", "-"], signal);
  let normalization = loudnorm;
  const raw = measurement.match(/\{\s*"input_i"[^}]+\}/u)?.[0];
  if (raw) {
    const values = JSON.parse(raw) as Record<string, string>;
    if (["input_i", "input_lra", "input_tp", "input_thresh", "target_offset"].every((key) => Number.isFinite(Number(values[key])))) normalization += `:measured_I=${values.input_i}:measured_LRA=${values.input_lra}:measured_TP=${values.input_tp}:measured_thresh=${values.input_thresh}:offset=${values.target_offset}:linear=true`;
  }
  // loudnorm can negotiate 192 kHz and a nonzero starting PTS for real speech.
  // Normalize both the sample rate and sample clock before fixing the length;
  // output -t must not consume the filter's timestamp offset as missing audio.
  const args = [...inputs, ...filters(`${normalization},alimiter=limit=0.95:level=0:latency=1,aresample=48000,asetpts=N/SR/TB,apad=whole_dur=${duration},atrim=duration=${duration}`)];
  args.push("-t", String(duration), "-ar", "48000", "-c:a", "pcm_s16le", "-map_metadata", "-1", output);
  await ffmpeg(args, signal);
  for (const format of ["mp3", "m4a"] as const) await ffmpeg([...inputArgs(output), "-c:a", format === "mp3" ? "libmp3lame" : "aac", "-b:a", "192k", path.join(dir, `${target}.${format}`)], signal);
}
export async function renderVideo(original: string, audio: string | undefined, output: string, duration: number, signal: AbortSignal, subtitle?: { file: string; language: string }) {
  const args = [...inputArgs(original)];
  if (audio) args.push(...inputArgs(audio));
  if (subtitle) args.push("-protocol_whitelist", "file,pipe", "-f", "srt", "-i", subtitle.file);
  // Stream copy preserves original resolution, fps and bitstream. If MP4 cannot
  // contain the source codec, fail honestly instead of silently reducing quality.
  args.push("-map", "0:v:0", "-map", audio ? "1:a:0" : "0:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k");
  if (subtitle) args.push("-map", `${audio ? 2 : 1}:s:0`, "-c:s", "mov_text", "-disposition:s:0", "default", "-metadata:s:s:0", `language=${({ en: "eng", sv: "swe", ar: "ara" } as Record<string, string>)[subtitle.language] || "und"}`);
  args.push("-t", String(duration), "-movflags", "+faststart", "-map_metadata", "-1", output);
  await ffmpeg(args, signal);
  if (!(await stat(output)).size) throw new AppError("Videoexporten är tom.", 502);
  const rendered = await inspect(output, signal, "mp4");
  if (!rendered.video || Math.abs(rendered.duration - duration) > 0.08) throw new AppError("MP4-exportens längd avviker från originalet. Ingen godkänd video publicerades.", 502);
}
