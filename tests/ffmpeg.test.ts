import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToMp3, ffmpegPath, getFFmpegStatus } from "../src/lib/ffmpeg";
import { isRealMp3 } from "../src/lib/media";
import type { Bitrate } from "../src/lib/types";

const temporaryDirectories = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, mkdtemp: async (prefix: string) => {
    const directory = await actual.mkdtemp(prefix);
    temporaryDirectories.push(directory);
    return directory;
  } };
});

function sineWav(): Buffer {
  const samples = 44_100;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(samples, 24); bytes.writeUInt32LE(samples * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) bytes.writeInt16LE(Math.round(10_000 * Math.sin(2 * Math.PI * 440 * sample / samples)), 44 + sample * 2);
  return bytes;
}

function assertDecodableMp3(bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "pipe", "-f", "mp3", "-i", "pipe:0", "-f", "null", "-"], { shell: false, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(errors || `FFmpeg decoder exit: ${code}`)));
    child.stdin.on("error", reject);
    child.stdin.end(bytes);
  });
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

describe("real FFmpeg conversion", () => {
  it("finds a functioning FFmpeg binary", async () => { expect((await getFFmpegStatus()).available).toBe(true); });
  it("converts WAV to decodable MP3 at all four qualities and removes temporary files", async () => {
    const sizes: number[] = [];
    for (const bitrate of [128, 192, 256, 320] as Bitrate[]) {
      const output = await convertToMp3(sineWav(), bitrate, "wav");
      expect(isRealMp3(output)).toBe(true);
      await assertDecodableMp3(output);
      sizes.push(output.length);
    }
    expect(sizes[1]).toBeGreaterThan(sizes[0]);
    expect(sizes[2]).toBeGreaterThan(sizes[1]);
    expect(sizes[3]).toBeGreaterThan(sizes[2]);
    expect(temporaryDirectories).toHaveLength(4);
  }, 30_000);
  it("rejects a network playlist disguised as WAV and cleans failed conversion", async () => {
    await expect(convertToMp3(Buffer.from("#EXTM3U\nhttps://127.0.0.1/private\n"), 192, "wav")).rejects.toMatchObject({ status: 422 });
    expect(temporaryDirectories).toHaveLength(1);
  });
  it("does not start a conversion or create temporary files for an aborted upload", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(convertToMp3(sineWav(), 192, "wav", controller.signal)).rejects.toMatchObject({ status: 400 });
    expect(temporaryDirectories).toHaveLength(0);
  });
});
