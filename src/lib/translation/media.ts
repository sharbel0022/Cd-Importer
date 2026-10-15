import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { ffmpegPath } from "../ffmpeg";
import { AppError } from "../errors";
import { EXTENSIONS, type MediaInfo } from "./types";

export async function ffmpeg(args: string[], signal: AbortSignal, timeout = 600_000): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ ffmpegPath(), ["-nostdin", "-hide_banner", "-y", "-threads", "2", ...args], { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = ""; let expired = false;
    const cancel = () => child.kill("SIGKILL"); signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { expired = true; cancel(); }, timeout);
    child.stderr.on("data", (b: Buffer) => { diagnostic = (diagnostic + b.toString()).slice(-48000); });
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
export async function placeSpeech(timeline: string, speech: string, start: number, tempo: number, dir: string, signal: AbortSignal) {
  const raw = path.join(dir, "current-speech.pcm");
  await ffmpeg([...inputArgs(speech), "-af", `atempo=${tempo.toFixed(6)}`, "-ar", "24000", "-ac", "1", "-f", "f32le", raw], signal);
  const source = await open(raw, "r"); const destination = await open(timeline, "r+");
  const total = (await destination.stat()).size; let position = Math.round(start * 24000) * 4; let offset = 0;
  const incoming = Buffer.alloc(65536); const existing = Buffer.alloc(65536);
  try {
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
  const args = ["-f", "f32le", "-ar", "24000", "-ac", "1", "-i", path.join(dir, `${target}.pcm`)];
  const bed = background || (mode === "voiceover" ? original : undefined);
  if (bed) {
    args.push(...inputArgs(bed), "-filter_complex", `[0:a]aformat=channel_layouts=stereo[voice];[1:a]volume=${background ? "1" : "0.15"},aformat=channel_layouts=stereo[bed];[voice][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=0:latency=1[out]`, "-map", "[out]");
  } else args.push("-af", "alimiter=limit=0.95:level=0:latency=1");
  args.push("-t", String(duration), "-ar", "48000", "-c:a", "pcm_s16le", "-map_metadata", "-1", output);
  await ffmpeg(args, signal);
  for (const format of ["mp3", "m4a"] as const) await ffmpeg([...inputArgs(output), "-c:a", format === "mp3" ? "libmp3lame" : "aac", "-b:a", "192k", path.join(dir, `${target}.${format}`)], signal);
}
export async function renderVideo(original: string, audio: string | undefined, output: string, duration: number, signal: AbortSignal) {
  const args = [...inputArgs(original)];
  if (audio) args.push(...inputArgs(audio));
  // Stream copy preserves original resolution, fps and bitstream. If MP4 cannot
  // contain the source codec, fail honestly instead of silently reducing quality.
  args.push("-map", "0:v:0", "-map", audio ? "1:a:0" : "0:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(duration), "-movflags", "+faststart", "-map_metadata", "-1", output);
  await ffmpeg(args, signal);
  if (!(await stat(output)).size) throw new AppError("Videoexporten är tom.", 502);
}
