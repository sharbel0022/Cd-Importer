import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { captionBurnInAvailable, createTimeline, ffmpeg, inputArgs, inspect, placeSpeech, renderCaptionedVideo, renderTrack, selectCaptionFont, verifyExport } from "@/lib/translation/media";

let root: string; const signal = () => new AbortController().signal;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "cd-media-options-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function rms(file: string, start: number, duration: number) {
  const raw = path.join(root, "measure.pcm");
  await ffmpeg([...inputArgs(file), "-ss", String(start), "-t", String(duration), "-ac", "1", "-ar", "16000", "-f", "f32le", raw], signal());
  const bytes = await readFile(raw); let energy = 0;
  for (let n = 0; n < bytes.length; n += 4) energy += bytes.readFloatLE(n) ** 2;
  return Math.sqrt(energy / (bytes.length / 4));
}
it("selects installed Tahoma only for Windows Arabic shaping while preserving the requested font and text", () => {
  const text = "المحيط الأطلسي، عاصفة مُسمّاة";
  expect(selectCaptionFont("Arial", text, "win32", true)).toMatchObject({ requestedFont: "Arial", actualFont: "Tahoma", fallbackReason: expect.stringContaining("combining marks") });
  expect(selectCaptionFont("Arial", text, "linux", true)).toEqual({ requestedFont: "Arial", actualFont: "Arial" });
  expect(selectCaptionFont("Arial", text, "win32", false)).toEqual({ requestedFont: "Arial", actualFont: "Arial" });
  expect(selectCaptionFont("Arial", "Hello", "win32", true)).toEqual({ requestedFont: "Arial", actualFont: "Arial" });
  expect(selectCaptionFont("Tahoma", text, "win32", true)).toEqual({ requestedFont: "Tahoma", actualFont: "Tahoma" });
  expect(text).toBe("المحيط الأطلسي، عاصفة مُسمّاة");
});
it("applies speech gain and edge fades while retaining the complete media duration", async () => {
  const speech = path.join(root, "speech.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=24000:duration=4", "-c:a", "pcm_s16le", speech], signal());
  for (const target of ["base", "faded", "loudness"]) { await createTimeline(path.join(root, `${target}.pcm`), 4); await placeSpeech(path.join(root, `${target}.pcm`), speech, 0, 1, root, signal(), 4); }
  await renderTrack(root, "base", 4, speech, "replace", undefined, signal(), { normalize: false });
  await renderTrack(root, "faded", 4, speech, "replace", undefined, signal(), { normalize: false, speechGainDb: -6, fadeInSeconds: 1, fadeOutSeconds: 1 });
  const baseline = await rms(path.join(root, "base.wav"), 1.5, 0.5); const center = await rms(path.join(root, "faded.wav"), 1.5, 0.5);
  expect(center / baseline).toBeCloseTo(10 ** (-6 / 20), 2);
  expect(await rms(path.join(root, "faded.wav"), 0, 0.05)).toBeLessThan(center * 0.08);
  expect(await rms(path.join(root, "faded.wav"), 3.95, 0.05)).toBeLessThan(center * 0.08);
  expect((await inspect(path.join(root, "faded.wav"), signal())).duration).toBe(4);
  await renderTrack(root, "loudness", 4, speech, "replace", undefined, signal(), { loudnessLufs: -20 });
  const measurement = await ffmpeg([...inputArgs(path.join(root, "loudness.wav")), "-af", "ebur128=peak=true", "-f", "null", "-"], signal());
  expect(Number([...measurement.matchAll(/I:\s*(-?\d+(?:\.\d+)?) LUFS/gu)].at(-1)?.[1])).toBeCloseTo(-20, 0);
}, 40000);
it("controls original audio gain independently of the voice-over speech", async () => {
  const speech = path.join(root, "speech.wav"); const original = path.join(root, "original.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=24000:duration=3", "-c:a", "pcm_s16le", speech], signal());
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=24000:duration=3", "-c:a", "pcm_s16le", original], signal());
  for (const target of ["loud", "quiet"]) { await createTimeline(path.join(root, `${target}.pcm`), 3); await placeSpeech(path.join(root, `${target}.pcm`), speech, 0, 1, root, signal(), 3); }
  await renderTrack(root, "loud", 3, original, "voiceover", undefined, signal(), { normalize: false, speechGainDb: -18, originalGainDb: 0 });
  await renderTrack(root, "quiet", 3, original, "voiceover", undefined, signal(), { normalize: false, speechGainDb: -18, originalGainDb: -20 });
  const loud = await rms(path.join(root, "loud.wav"), 1, 0.5); const quiet = await rms(path.join(root, "quiet.wav"), 1, 0.5);
  // Two different tones add in energy. The quiet render retains the same voice
  // energy but reduces only the independently controlled original recording.
  expect(quiet / loud).toBeGreaterThan(0.14); expect(quiet / loud).toBeLessThan(0.18);
}, 30000);
it("burns styled subtitles into a separate playable MP4, even in a directory with filter characters", async () => {
  expect(await captionBurnInAvailable()).toBe(true);
  const dir = path.join(root, "captions[review]'s"); await mkdir(dir);
  const base = path.join(dir, "en.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=320x180:r=25:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-c:a", "aac", "-shortest", base], signal());
  const before = await readFile(base);
  const subtitle = "1\n00:00:00,200 --> 00:00:02,800\nSpeaker A: Hello\nالمحيط الأطلسي، عاصفة مُسمّاة\n";
  await writeFile(path.join(dir, "en.srt"), subtitle);
  const captioned = await renderCaptionedVideo(dir, "en", 3, signal(), { font: "Arial", fontSize: 24, color: "#FFFF00", outline: 2, position: "bottom" });
  await verifyExport(captioned, 3, signal());
  const metadata = JSON.parse(await readFile(path.join(dir, "en.caption-render.json"), "utf8"));
  expect(metadata).toMatchObject({ requestedFont: "Arial", frameWidth: 320, frameHeight: 180, marginPercent: 5, marginPixels: 9, requestedFontSize: 24 });
  if (process.platform === "win32") expect(metadata.actualFont).toBe("Tahoma");
  expect(await readFile(path.join(dir, "en.srt"), "utf8")).toBe(subtitle);
  expect(await readFile(base)).toEqual(before);
  const frame = async (file: string, name: string) => { const output = path.join(root, name); await ffmpeg([...inputArgs(file), "-ss", "1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", output], signal()); return readFile(output); };
  const originalPixels = await frame(base, "original.rgb"); const captionedPixels = await frame(captioned, "captions.rgb");
  let changed = 0; for (let n = 0; n < originalPixels.length; n++) if (Math.abs(originalPixels[n] - captionedPixels[n]) > 30) changed++;
  expect(changed).toBeGreaterThan(1000);
  expect((await inspect(captioned, signal())).duration).toBe(3);
}, 30000);
