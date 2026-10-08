import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import bundledFFmpeg from "ffmpeg-static";
import { AppError } from "./errors";
import type { Bitrate } from "./types";

let activeConversions = 0;
const MAX_CONVERSIONS = 2;
const MAX_CONVERSION_BYTES = 100 * 1024 * 1024;
export const SUPPORTED_UPLOAD_EXTENSIONS = new Set(["wav", "flac", "m4a", "mp3", "ogg", "oga", "aac", "aiff", "aif", "opus", "webm"]);

export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) {
    if (!path.isAbsolute(process.env.FFMPEG_PATH)) throw new AppError("FFMPEG_PATH måste vara en absolut sökväg.", 503);
    return process.env.FFMPEG_PATH;
  }
  return bundledFFmpeg ?? "ffmpeg";
}

async function runFFmpeg(args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new AppError("Konverteringen avbröts.", 400);
  return new Promise((resolve, reject) => {
    // The binary is installed by ffmpeg-static or explicitly configured by the
    // local operator. Do not trace the entire checkout as a dynamic executable.
    const child = spawn(/* turbopackIgnore: true */ ffmpegPath(), args, { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    let expired = false;
    const cancel = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, timeout);
    child.stderr.on("data", (chunk: Buffer) => { if (diagnostic.length < 16_000) diagnostic += chunk.toString().slice(0, 16_000 - diagnostic.length); });
    child.on("error", () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new AppError("FFmpeg kunde inte startas. Installera FFmpeg eller ange FFMPEG_PATH.", 503)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) reject(new AppError("Konverteringen avbröts.", 400));
      else if (expired) reject(new AppError("Konverteringen tog för lång tid. Välj en mindre ljudfil.", 504));
      else if (code !== 0) reject(new AppError("Ljudfilen kunde inte konverteras. Kontrollera att formatet stöds och att filen är oskadad.", 422));
      else resolve(diagnostic);
    });
  });
}

export async function getFFmpegStatus(): Promise<{ available: boolean; path?: string; message: string }> {
  try {
    await runFFmpeg(["-hide_banner", "-version"], 5_000);
    return { available: true, path: ffmpegPath(), message: "FFmpeg är redo för MP3-konvertering." };
  } catch (error) {
    return { available: false, message: error instanceof AppError ? error.message : "FFmpeg är inte tillgängligt." };
  }
}

/** Real audio-only transcoding. The input demuxer is forced so playlists cannot
 * reference local files, and FFmpeg is never allowed to make network requests. */
export async function convertToMp3(input: Buffer, bitrate: Bitrate, extension: string, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw new AppError("Konverteringen avbröts.", 400);
  extension = extension.toLowerCase();
  if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) throw new AppError("Ljudformatet stöds inte.", 415);
  if (!input.length || input.length > MAX_CONVERSION_BYTES) throw new AppError("Ljudfilen är tom eller för stor.", 413);
  if (activeConversions >= MAX_CONVERSIONS) throw new AppError("Två konverteringar pågår redan. Försök igen om en stund.", 429);
  const inputFormat: Record<string, string> = { wav: "wav", flac: "flac", m4a: "mov", mp3: "mp3", ogg: "ogg", oga: "ogg", aac: "aac", aiff: "aiff", aif: "aiff", opus: "ogg", webm: "matroska" };
  activeConversions++;
  let temporaryDirectory: string | undefined;
  try {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "music-downloader-"));
    const inputPath = path.join(temporaryDirectory, `input.${extension}`);
    const outputPath = path.join(temporaryDirectory, "output.mp3");
    await writeFile(inputPath, input, { flag: "wx" });
    await runFFmpeg([
      "-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe",
      "-f", inputFormat[extension], "-i", inputPath, "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", `${bitrate}k`,
      "-fs", String(MAX_CONVERSION_BYTES), "-f", "mp3", outputPath,
    ], 120_000, signal);
    const info = await stat(outputPath);
    if (!info.size || info.size >= MAX_CONVERSION_BYTES) throw new AppError("Det konverterade ljudet är tomt eller för stort.", 413);
    return await readFile(outputPath);
  } finally {
    try { if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }); }
    finally { activeConversions--; }
  }
}
