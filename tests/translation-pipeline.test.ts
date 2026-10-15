import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { POST as upload } from "@/app/api/translation/jobs/route";
import { POST as live } from "@/app/api/translation/live/route";
import { PATCH as control } from "@/app/api/translation/jobs/[id]/route";
import { GET as getFile } from "@/app/api/translation/jobs/[id]/file/route";
import { runJob } from "@/lib/translation/pipeline";
import { jobDir, readJob, updateJob } from "@/lib/translation/store";
import { createTimeline, ffmpeg, inspect, placeSpeech, renderTrack } from "@/lib/translation/media";
import { wavBlob } from "@/lib/translation/client";
import type { Job } from "@/lib/translation/types";
import { AppError } from "@/lib/errors";
import * as providers from "@/lib/translation/providers";

vi.mock("@/lib/translation/providers", async (original) => ({ ...await original<typeof import("@/lib/translation/providers")>(), transcribe: vi.fn(), translate: vi.fn(), synthesize: vi.fn(), diarize: vi.fn(), separate: vi.fn() }));
let root: string;
async function tone(duration = 0.8, frequency = 880) { return Buffer.from(await wavBlob(Int16Array.from({ length: Math.round(duration * 16000) }, (_, i) => Math.sin(i * Math.PI * 2 * frequency / 16000) * 10000)).arrayBuffer()); }
async function makeJob(extension = "wav", bytes?: Buffer, extra = {}): Promise<Job> {
  const response = await upload(new Request("http://localhost/api/translation/jobs", { method: "POST", headers: { "x-file-name": `test.${extension}`, "x-studio-options": encodeURIComponent(JSON.stringify({ targets: ["sv"], rights: true, cloudConsent: true, ...extra })) }, body: new Uint8Array(bytes || await tone(3, 220)) }));
  expect(response.status, await response.clone().text()).toBe(201); return response.json();
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cd-translation-test-"));
  vi.stubEnv("STUDIO_DATA_DIR", root); vi.stubEnv("OPENAI_API_KEY", "test-key-never-sent");
  vi.stubEnv("STUDIO_ASR_PROVIDER", "openai"); vi.stubEnv("STUDIO_TTS_PROVIDER", "openai"); vi.stubEnv("STUDIO_TRANSLATION_PROVIDER", "openai");
  vi.mocked(providers.transcribe).mockResolvedValue({ language: "arabic", segments: [{ start: 0.5, end: 2, text: "مرحبا بالعالم" }] });
  vi.mocked(providers.translate).mockImplementation(async (segments) => segments.map((s) => ({ id: s.id, text: "Hej världen" })));
  vi.mocked(providers.synthesize).mockImplementation(async () => tone());
  vi.mocked(providers.diarize).mockResolvedValue([{ start: 0, end: 3, speaker: "A" }]);
});
afterEach(async () => { vi.resetAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
describe("real FFmpeg pipeline with explicitly mocked AI providers", () => {
  it("Arabic → Swedish exports actual new audio, exact duration, subtitles and Range", async () => {
    const job = await makeJob(); await runJob(job.id); const result = await readJob(job.id);
    expect(result.status, result.error).toBe("completed"); expect(result.detectedLanguage).toBe("arabic");
    expect(result.outputs.sv).toEqual(["srt", "vtt", "txt", "json", "wav", "mp3", "m4a"]);
    expect((await inspect(path.join(jobDir(job.id), "sv.wav"), new AbortController().signal)).duration).toBeCloseTo(3, 2);
    const original = await readFile(path.join(jobDir(job.id), "original.wav")); const translated = await readFile(path.join(jobDir(job.id), "sv.wav")); expect(translated.equals(original)).toBe(false);
    await ffmpeg(["-i", path.join(jobDir(job.id), "sv.wav"), "-ss", "0.6", "-t", "0.2", "-ar", "16000", "-ac", "1", "-f", "s16le", path.join(root, "decoded.pcm")], new AbortController().signal);
    const pcm = await readFile(path.join(root, "decoded.pcm")); let crossings = 0; for (let i = 2; i < pcm.length; i += 2) if (pcm.readInt16LE(i - 2) <= 0 && pcm.readInt16LE(i) > 0) crossings++;
    expect(crossings).toBeGreaterThan(120); // New 880 Hz fixture, not original 220 Hz.
    const loudness = await ffmpeg(["-i", path.join(jobDir(job.id), "sv.wav"), "-af", "ebur128=peak=true", "-f", "null", "-"], new AbortController().signal);
    const measuredLufs = [...loudness.matchAll(/I:\s*(-?\d+(?:\.\d+)?) LUFS/gu)].at(-1);
    expect(Number(measuredLufs?.[1])).toBeCloseTo(-16, 0);
    expect(Math.max(...Array.from({ length: pcm.length / 2 }, (_, i) => Math.abs(pcm.readInt16LE(i * 2)) / 32768))).toBeLessThan(0.95);
    expect(await readFile(path.join(jobDir(job.id), "sv.srt"), "utf8")).toContain("Hej världen");
    const response = await getFile(new Request(`http://localhost/file?target=sv&format=mp3`, { headers: { Range: "bytes=0-99" } }), { params: Promise.resolve({ id: job.id }) }); expect(response.status).toBe(206); expect((await response.arrayBuffer()).byteLength).toBe(100);
    expect(result.metrics.processingMs).toBeGreaterThan(0); expect(result.metrics.syncMaxDeviationMs).toBe(0);
  }, 30000);
  it("Arabic video → English MP4 retains video duration and replaces audio", async () => {
    const input = path.join(root, "input.mp4"); await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25:d=3", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-c:v", "libx264", "-c:a", "aac", "-shortest", input], new AbortController().signal);
    const job = await makeJob("mp4", await readFile(input), { targets: ["en"] }); await runJob(job.id); const result = await readJob(job.id);
    expect(result.status, result.error).toBe("completed"); expect(result.outputs.en).toContain("mp4"); expect(await inspect(path.join(jobDir(job.id), "en.mp4"), new AbortController().signal)).toMatchObject({ video: true, duration: 3 });
    const decoded = path.join(root, "video-decoded.pcm"); await ffmpeg(["-i", path.join(jobDir(job.id), "en.mp4"), "-ss", "0.6", "-t", "0.2", "-ar", "16000", "-ac", "1", "-f", "s16le", decoded], new AbortController().signal);
    const pcm = await readFile(decoded); let crossings = 0; for (let i = 2; i < pcm.length; i += 2) if (pcm.readInt16LE(i - 2) <= 0 && pcm.readInt16LE(i) > 0) crossings++;
    expect(crossings).toBeGreaterThan(120); // MP4 really contains new fixture voice, not original audio.
  }, 30000);
  it("subtitles mode retains original MP4 audio and muxes selectable English captions without TTS", async () => {
    const signal = new AbortController().signal; const input = path.join(root, "subtitles-input.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=160x90:r=25:d=3", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-c:v", "libx264", "-c:a", "aac", "-shortest", input], signal);
    vi.mocked(providers.translate).mockResolvedValue([{ id: "s1", text: "Hello world" }]);
    const job = await makeJob("mp4", await readFile(input), { targets: ["en"], mode: "subtitles" }); await runJob(job.id);
    const result = await readJob(job.id); expect(result.status, result.error).toBe("completed"); expect(providers.synthesize).not.toHaveBeenCalled();
    const output = path.join(jobDir(job.id), "en.mp4");
    expect(await inspect(output, signal)).toMatchObject({ video: true, duration: 3 });
    const captions = path.join(root, "extracted-captions.srt");
    await ffmpeg(["-i", output, "-map", "0:s:0", "-c:s", "srt", captions], signal);
    expect(await readFile(captions, "utf8")).toContain("Hello world");
    const decoded = path.join(root, "original-audio.pcm"); await ffmpeg(["-i", output, "-ss", "0.6", "-t", "0.2", "-ar", "16000", "-ac", "1", "-f", "s16le", decoded], signal);
    const pcm = await readFile(decoded); let crossings = 0; for (let i = 2; i < pcm.length; i += 2) if (pcm.readInt16LE(i - 2) <= 0 && pcm.readInt16LE(i) > 0) crossings++;
    expect(crossings).toBeGreaterThan(35); expect(crossings).toBeLessThan(55);
  }, 30000);
  it("uses consistent distinct voices for two diarized speakers", async () => {
    vi.mocked(providers.transcribe).mockResolvedValue({ language: "arabic", segments: [{ start: 0, end: 1.4, text: "واحد" }, { start: 1.5, end: 3, text: "اثنان" }] });
    vi.mocked(providers.diarize).mockResolvedValue([{ start: 0, end: 1.4, speaker: "A" }, { start: 1.5, end: 3, speaker: "B" }]);
    const job = await makeJob("wav", undefined, { diarize: true }); await runJob(job.id); const result = await readJob(job.id); expect(result.status, result.error).toBe("completed");
    expect(result.segments.map((s) => s.speaker)).toEqual(["A", "B"]); expect(new Set(vi.mocked(providers.synthesize).mock.calls.map((c) => c[2])).size).toBe(2);
  }, 30000);
  it("mixes an explicitly separated background and discloses separation limitations", async () => {
    vi.stubEnv("STUDIO_TTS_PROVIDER", "local"); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ready: true, languages: ["sv"], voices: ["coral"], diarization: false, cloning: false, separation: true, message: "test-only health" })));
    vi.mocked(providers.separate).mockResolvedValue(new Response(new Uint8Array(await tone(3, 1320)), { headers: { "Content-Type": "audio/wav" } }));
    const job = await makeJob("wav", undefined, { preserveBackground: true }); await runJob(job.id); const result = await readJob(job.id);
    expect(result.status, result.error).toBe("completed"); expect(providers.separate).toHaveBeenCalledOnce(); expect(result.warnings.join(" ")).toContain("artefakter");
    expect(await inspect(path.join(jobDir(job.id), "sv.wav"), new AbortController().signal)).toMatchObject({ channels: 2, duration: 3 });
  }, 30000);
  it("blocks final audio for overlong speech and permits editing then retry", async () => {
    vi.mocked(providers.synthesize).mockImplementation(async (text) => tone(text === "Kort" ? 0.5 : 4));
    const job = await makeJob(); await runJob(job.id); const review = await readJob(job.id); expect(review.status).toBe("review"); expect(review.outputs.sv).not.toContain("wav");
    const shortening = vi.mocked(providers.translate).mock.calls.find((call) => call[5] === true);
    expect(shortening?.[0][0].text).toBe("مرحبا بالعالم");
    expect(shortening?.[3]).toContain("Hej världen");
    const edit = await control(new Request("http://localhost/control", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "edit", edits: [{ id: "s1", target: "sv", text: "Kort", start: 0.5, end: 2, speaker: "unknown" }] }) }), { params: Promise.resolve({ id: job.id }) }); expect(edit.status).toBe(200);
    await updateJob(job.id, (j) => { j.status = "queued"; }); await runJob(job.id); expect((await readJob(job.id)).status).toBe("completed");
  }, 30000);
  it("automatically retries measured concise speech without editing or excessive tempo", async () => {
    let attempt = 0;
    vi.mocked(providers.translate).mockImplementation(async (segments, _target, _options, _context, _signal, shorten, fit) => {
      if (!shorten) return segments.map((s) => ({ id: s.id, text: "Den långa meningen" }));
      expect(fit?.measuredSeconds).toBeGreaterThan(fit!.availableSeconds);
      expect(fit?.maxWords).toBeGreaterThan(0);
      return [{ id: segments[0].id, text: ++attempt === 1 ? "Den är lång" : "Den korta" }];
    });
    vi.mocked(providers.synthesize).mockImplementation(async (text) => tone(text === "Den korta" ? 1.6 : text === "Den är lång" ? 3.5 : 4));
    const job = await makeJob(); await runJob(job.id); const result = await readJob(job.id);
    expect(result.status, result.error).toBe("completed");
    expect(result.translations.sv[0]).toMatchObject({ text: "Den korta", timing: { attempts: 2, review: false } });
    expect(result.translations.sv[0].timing!.tempo).toBeLessThanOrEqual(1.2);
    expect(result.outputs.sv).toContain("wav");
  }, 30000);
  it("rejects fact-losing shortening even when its speech would fit the window", async () => {
    const fullText = "Jerry har tre titlar"; const shortenedText = "Han har titlar";
    vi.mocked(providers.transcribe).mockResolvedValue({ language: "arabic", segments: [{ start: 0.5, end: 2, text: "جيري لديه ثلاثة ألقاب" }] });
    vi.mocked(providers.translate).mockImplementation(async (segments, _target, _options, _context, _signal, shorten) => segments.map((s) => ({ id: s.id, text: shorten ? shortenedText : fullText })));
    // The rejected wording would fit easily; the faithful four-second speech
    // cannot fit even with the bounded tempo and borrowed pause.
    vi.mocked(providers.synthesize).mockImplementation(async (text) => tone(text === shortenedText ? 0.5 : 4));
    const job = await makeJob(); await runJob(job.id); const result = await readJob(job.id);
    expect(vi.mocked(providers.translate).mock.calls.some((call) => call[5] === true)).toBe(true);
    expect(result.status, result.error).toBe("review");
    expect(result.translations.sv[0]).toMatchObject({ text: fullText, timing: { attempts: 3, review: true } });
    expect(vi.mocked(providers.synthesize).mock.calls.map((call) => call[0])).toEqual([fullText]);
    expect(result.outputs.sv).toEqual(["srt", "vtt", "txt", "json"]);
    const exportedText = await readFile(path.join(jobDir(job.id), "sv.txt"), "utf8");
    expect(exportedText).toContain(fullText); expect(exportedText).not.toContain(shortenedText);
  }, 30000);
  it("protects English names, written counts and negation during timing retries", async () => {
    const fullText = "Jerry did not win three titles";
    vi.mocked(providers.translate).mockImplementation(async (segments, _target, _options, _context, _signal, shorten) => segments.map((s) => ({ id: s.id, text: shorten ? "He won titles" : fullText })));
    vi.mocked(providers.synthesize).mockImplementation(async (text) => tone(text === fullText ? 4 : 0.5));
    const job = await makeJob("wav", undefined, { targets: ["en"] }); await runJob(job.id);
    const result = await readJob(job.id);
    expect(result.status).toBe("review"); expect(result.reviewReason).toBe("timing");
    expect(result.translations.en[0].text).toBe(fullText);
    expect(vi.mocked(providers.synthesize).mock.calls.map((c) => c[0])).toEqual([fullText]);
    expect(result.outputs.en).not.toContain("mp3");
  }, 30000);
  it("requires source review before translating uncertain words and resumes after approval", async () => {
    vi.mocked(providers.transcribe).mockResolvedValue({ language: "ar", language_probability: 0.95, segments: [{ start: 0.5, end: 2, text: "مرحبا", no_speech_prob: 0.9, uncertain: true, quality_reasons: ["low_confidence"], words: [{ start: 0.5, end: 2, word: "مرحبا", probability: 0.3, uncertain: true }] }] });
    const job = await makeJob("wav", undefined, { targets: ["en"] }); await runJob(job.id);
    expect(await readJob(job.id)).toMatchObject({ status: "review", reviewReason: "source", outputs: {}, sourceConfidence: 0.95, segments: [{ text: "مرحبا", uncertain: true, qualityReasons: ["low_confidence", "possible_background_noise_or_silence"], words: [{ probability: 0.3 }] }] });
    expect(providers.translate).not.toHaveBeenCalled(); expect(providers.synthesize).not.toHaveBeenCalled();
    const approved = await control(new Request("http://localhost/control", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve-source" }) }), { params: Promise.resolve({ id: job.id }) });
    expect(approved.status, await approved.clone().text()).toBe(200);
    await runJob(job.id); expect((await readJob(job.id)).status).toBe("completed");
  }, 30000);
  it("reuses untouched translation and speech segments when only one source segment changes", async () => {
    vi.mocked(providers.transcribe).mockResolvedValue({ language: "ar", segments: [{ start: 0, end: 1, text: "مرحبا." }, { start: 1.5, end: 3, text: "وداعا." }] });
    vi.mocked(providers.translate).mockImplementation(async (segments) => segments.map((s) => ({ id: s.id, text: s.text.includes("جديد") ? "Updated sentence" : `Translation ${s.id}` })));
    const job = await makeJob("wav", undefined, { targets: ["en"] }); await runJob(job.id); expect((await readJob(job.id)).status).toBe("completed");
    vi.mocked(providers.translate).mockClear(); vi.mocked(providers.synthesize).mockClear();
    const edit = await control(new Request("http://localhost/control", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "edit", edits: [{ id: "s1", target: "en", text: "Translation s1", original: "نص جديد.", start: 0, end: 1, speaker: "unknown" }] }) }), { params: Promise.resolve({ id: job.id }) });
    expect(edit.status, await edit.clone().text()).toBe(200);
    await updateJob(job.id, (j) => { j.status = "queued"; }); await runJob(job.id);
    const result = await readJob(job.id); expect(result.status, result.error).toBe("completed");
    expect(vi.mocked(providers.translate).mock.calls.flatMap((c) => c[0].map((s) => s.id))).toEqual(["s1"]);
    expect(vi.mocked(providers.synthesize).mock.calls.map((c) => c[0])).toEqual(["Updated sentence"]);
    expect(result.translations.en.find((t) => t.id === "s2")?.text).toBe("Translation s2");
  }, 30000);
  it("requires alignment review for high-confidence words separated by a VAD timestamp gap, including saved transcripts", async () => {
    vi.mocked(providers.transcribe).mockResolvedValue({ language: "en", language_probability: 0.99, segments: [{ start: 5.46, end: 35.2, text: "When you call someone.", avg_logprob: -0.02, words: [{ start: 5.46, end: 5.98, word: "When", probability: 0.99, uncertain: false }, { start: 31.14, end: 31.34, word: "you", probability: 0.999, uncertain: false }, { start: 31.34, end: 35.2, word: "call someone.", probability: 0.999, uncertain: false }] }] });
    const job = await makeJob("wav", await tone(36), { targets: ["en"] }); await runJob(job.id);
    expect(await readJob(job.id)).toMatchObject({ status: "review", reviewReason: "source", sourceReviewed: false, outputs: {}, segments: [{ start: 5.46, end: 35.2, uncertain: true, qualityReasons: ["discontinuous_word_timestamps"], words: [{ start: 5.46, probability: 0.99 }, { start: 31.14, probability: 0.999 }, { start: 31.34, probability: 0.999 }] }] });
    expect(providers.translate).not.toHaveBeenCalled(); expect(providers.synthesize).not.toHaveBeenCalled();
    // An older saved job can already have approved ASR text without this timing
    // check. Discovering the problem must revoke that obsolete approval once.
    await updateJob(job.id, (j) => { j.status = "queued"; j.sourceReviewed = true; j.segments[0].uncertain = false; j.segments[0].qualityReasons = []; });
    vi.mocked(providers.transcribe).mockClear(); await runJob(job.id);
    expect(await readJob(job.id)).toMatchObject({ status: "review", reviewReason: "source", sourceReviewed: false, segments: [{ uncertain: true, qualityReasons: ["discontinuous_word_timestamps"] }] });
    expect(providers.transcribe).not.toHaveBeenCalled(); expect(providers.translate).not.toHaveBeenCalled(); expect(providers.synthesize).not.toHaveBeenCalled();
  }, 30000);
  it("retains faithful text when shortening fails integrity, with bounded speech rate", async () => {
    vi.mocked(providers.translate).mockImplementation(async (segments, _target, _options, _context, _signal, shorten) => {
      if (shorten) throw new providers.TranslationIntegrityError("Missing fact", 502);
      return segments.map((s) => ({ id: s.id, text: "Den svenska meningen behåller alla fakta" }));
    });
    vi.mocked(providers.synthesize).mockImplementation(async () => tone(3));
    const job = await makeJob(); await runJob(job.id); const result = await readJob(job.id);
    expect(result.status, result.error).toBe("completed");
    expect(result.translations.sv[0].timing).toMatchObject({ attempts: 3, review: false });
    expect(result.translations.sv[0].timing!.tempo).toBeLessThanOrEqual(1.4);
    expect(result.translations.sv[0].text).toBe("Den svenska meningen behåller alla fakta");
  }, 30000);
  it("reports invalid media, missing credentials and failed TTS without a successful audio export", async () => {
    const invalid = await makeJob("wav", Buffer.from("not media")); await runJob(invalid.id); expect((await readJob(invalid.id)).status).toBe("failed");
    const failed = await makeJob(); vi.mocked(providers.synthesize).mockRejectedValue(new AppError("Felaktig API-nyckel", 502)); await runJob(failed.id); expect(await readJob(failed.id)).toMatchObject({ status: "failed", outputs: {} });
    vi.stubEnv("OPENAI_API_KEY", ""); const denied = await upload(new Request("http://localhost/jobs", { method: "POST", headers: { "x-file-name": "test.wav", "x-studio-options": encodeURIComponent(JSON.stringify({ targets: ["sv"], rights: true, cloudConsent: true })) }, body: new Uint8Array(await tone()) })); expect(denied.status).toBe(503);
  }, 30000);
  it("rejects silent TTS rather than presenting silence as translated speech", async () => {
    vi.mocked(providers.synthesize).mockResolvedValue(Buffer.from(await wavBlob(new Int16Array(16000)).arrayBuffer()));
    const job = await makeJob(); await runJob(job.id); expect(await readJob(job.id)).toMatchObject({ status: "failed", outputs: {} });
    vi.mocked(providers.synthesize).mockImplementation(async () => tone());
    await updateJob(job.id, (j) => { j.status = "queued"; }); await runJob(job.id); expect((await readJob(job.id)).status).toBe("completed");
  }, 30000);
  it("pauses and cancels in-flight AI requests through the persisted command", async () => {
    vi.mocked(providers.transcribe).mockImplementation(async (_file, _source, signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }));
    const job = await makeJob(); const work = runJob(job.id); await new Promise((r) => setTimeout(r, 800)); await updateJob(job.id, (j) => { j.command = "pause"; }); await work; expect((await readJob(job.id)).status).toBe("paused");
    await updateJob(job.id, (j) => { j.status = "queued"; }); const second = runJob(job.id); await new Promise((r) => setTimeout(r, 800)); await updateJob(job.id, (j) => { j.command = "cancel"; }); await second; expect((await readJob(job.id)).status).toBe("cancelled");
  }, 30000);
  it("places late speech at the absolute sample position after an hour without cumulative drift", async () => {
    const timeline = path.join(root, "long.pcm"); const voice = path.join(root, "voice.wav"); await writeFile(voice, await tone(0.5)); await createTimeline(timeline, 3600); await placeSpeech(timeline, voice, 3599, 1, root, new AbortController().signal);
    expect((await stat(timeline)).size).toBe(3600 * 24000 * 4);
    const f = await open(timeline, "r"); const b = Buffer.alloc(4800); try { await f.read(b, 0, b.length, 3599 * 24000 * 4); expect([...new Float32Array(b.buffer, b.byteOffset, b.length / 4)].some((v) => Math.abs(v) > 0.1)).toBe(true); await f.read(b, 0, b.length, 3598 * 24000 * 4); expect(b.every((v) => v === 0)).toBe(true); } finally { await f.close(); }
  }, 30000);
  it("rejects speech that would be cut off or overlap the next segment before writing samples", async () => {
    const timeline = path.join(root, "cutoff.pcm"); const voice = path.join(root, "voice.wav");
    await writeFile(voice, await tone(1)); await createTimeline(timeline, 1);
    await expect(placeSpeech(timeline, voice, 0.5, 1, root, new AbortController().signal)).rejects.toThrow(/avklippning/);
    expect((await readFile(timeline)).every((v) => v === 0)).toBe(true);
    await createTimeline(timeline, 3);
    await expect(placeSpeech(timeline, voice, 0, 1, root, new AbortController().signal, 0.5)).rejects.toThrow(/överlappning/);
    expect((await readFile(timeline)).every((v) => v === 0)).toBe(true);
  }, 30000);
  it("keeps a 6.62-second normalized export and audible speech at the original file end", async () => {
    const signal = new AbortController().signal; const timeline = path.join(root, "en.pcm"); const voice = path.join(root, "end-voice.wav");
    await writeFile(voice, await tone(1)); await createTimeline(timeline, 6.62);
    await placeSpeech(timeline, voice, 5.62, 1, root, signal, 1);
    await renderTrack(root, "en", 6.62, voice, "replace", undefined, signal);
    expect((await inspect(path.join(root, "en.wav"), signal)).duration).toBe(6.62);
    const end = path.join(root, "end.pcm");
    await ffmpeg(["-i", path.join(root, "en.wav"), "-ss", "6.50", "-t", "0.10", "-ar", "16000", "-ac", "1", "-f", "s16le", end], signal);
    const bytes = await readFile(end); expect(bytes.length).toBe(3200);
    expect(Array.from({ length: bytes.length / 2 }, (_, n) => Math.abs(bytes.readInt16LE(n * 2))).some((v) => v > 1000)).toBe(true);
  }, 30000);
  it("keeps the sample clock and full duration when high-crest-factor speech needs dynamic loudness normalization", async () => {
    const signal = new AbortController().signal; const timeline = Buffer.alloc(6.62 * 24000 * 4);
    for (let n = Math.ceil(0.78 * 24000); n < 6.6 * 24000; n++) {
      const time = n / 24000;
      const pulse = time % 1 < 0.02 ? 0.85 : 0;
      timeline.writeFloatLE((0.02 + pulse) * Math.sin(time * 880 * 2 * Math.PI), n * 4);
    }
    await writeFile(path.join(root, "en.pcm"), timeline);
    await renderTrack(root, "en", 6.62, "unused.wav", "replace", undefined, signal);
    expect((await inspect(path.join(root, "en.wav"), signal)).duration).toBe(6.62);
    const decoded = path.join(root, "dynamic-clock.pcm");
    await ffmpeg(["-i", path.join(root, "en.wav"), "-ar", "24000", "-ac", "1", "-f", "f32le", decoded], signal);
    const bytes = await readFile(decoded); expect(bytes.length).toBe(timeline.length);
    const nonzero = Array.from({ length: bytes.length / 4 }, (_, n) => Math.abs(bytes.readFloatLE(n * 4)) > 0.001);
    expect(nonzero.indexOf(true) / 24000).toBeCloseTo(0.78, 2);
    expect(nonzero.lastIndexOf(true) / 24000).toBeGreaterThan(6.59);
  }, 30000);
  it("streams Swedish microphone-block transcription, English text and real TTS bytes", async () => {
    vi.mocked(providers.transcribe).mockResolvedValue({ language: "sv", segments: [{ start: 0.1, end: 1, text: "God morgon" }] });
    vi.mocked(providers.translate).mockResolvedValue([{ id: "s1", text: "Good morning" }]);
    const response = await live(new Request("http://localhost/api/translation/live", { method: "POST", headers: { "x-studio-options": encodeURIComponent(JSON.stringify({ source: "sv", targets: ["en"], rights: true, cloudConsent: true })) }, body: new Uint8Array(await tone(4)) }));
    expect(response.status).toBe(200); const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((e) => e.type)).toEqual(["transcript", "translation", "audio"]); expect(events[1].text).toBe("Good morning"); expect(events[2].processingMs).toBeGreaterThan(0); expect(Buffer.from(events[2].audio, "base64").toString("ascii", 0, 4)).toBe("RIFF");
  }, 30000);
});
