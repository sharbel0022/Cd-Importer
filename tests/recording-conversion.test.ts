import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { convertToMp3, ffmpegPath } from "../src/lib/ffmpeg";
import { isRealMp3 } from "../src/lib/media";

function runFFmpeg(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let diagnostic = "";
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { diagnostic += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(diagnostic || `FFmpeg exited with ${code}`)));
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

describe("browser microphone recording formats", () => {
  it.each([
    { extension: "webm", codec: "libopus", format: "webm", flags: [] },
    { extension: "m4a", codec: "aac", format: "mp4", flags: ["-movflags", "frag_keyframe+empty_moov"] },
    { extension: "ogg", codec: "libopus", format: "ogg", flags: [] },
  ])("converts $extension microphone audio to a genuinely decodable MP3", async ({ extension, codec, format, flags }) => {
    const recording = await runFFmpeg([
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1.5",
      "-map", "0:a:0", "-c:a", codec, ...flags, "-f", format, "pipe:1",
    ]);
    expect(recording.length).toBeGreaterThan(1000);
    expect(isRealMp3(recording)).toBe(false);
    const mp3 = await convertToMp3(recording, 192, extension);
    expect(isRealMp3(mp3)).toBe(true);
    const decoded = await runFFmpeg([
      "-protocol_whitelist", "pipe", "-f", "mp3", "-i", "pipe:0", "-f", "s16le", "pipe:1",
    ], mp3);
    expect(decoded.length).toBeGreaterThan(48000);
    // A silent or renamed container would not satisfy the real decoder check.
    expect(decoded.some((byte) => byte !== 0)).toBe(true);
  }, 30_000);
});
