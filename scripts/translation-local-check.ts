import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { chunk, ffmpeg, inputArgs, inspect } from "../src/lib/translation/media";
import { resolveVoice } from "../src/lib/translation/providers";
import type { Capabilities, Job } from "../src/lib/translation/types";

const origin = process.env.LIVE_TEST_ORIGIN || "http://127.0.0.1:3011";
const gateway = process.env.STUDIO_LOCAL_URL || "http://127.0.0.1:8765";
const authorization: Record<string, string> = process.env.STUDIO_LOCAL_TOKEN ? { Authorization: `Bearer ${process.env.STUDIO_LOCAL_TOKEN}` } : {};
const target = process.env.STUDIO_TEST_TARGET || "en";
const expectedSource = process.env.STUDIO_TEST_SOURCE_LANGUAGE || "ar";
const directory = path.resolve("test-results", `local-translation-${target}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(directory, { recursive: true });
const inputMedia = process.env.STUDIO_TEST_MEDIA;
const existingJob = process.env.STUDIO_TEST_JOB_ID;
if (existingJob && !inputMedia) throw new Error("Ange originalfilen i STUDIO_TEST_MEDIA när ett befintligt jobb verifieras.");
const reference = inputMedia ? process.env.STUDIO_TEST_REFERENCE_TXT ? await readFile(process.env.STUDIO_TEST_REFERENCE_TXT, "utf8") : "" : "مرحباً بكم. أعيش مع عائلتي في مدينة هادئة قريبة من البحر. أتعلم اللغة السويدية كل يوم لأنني أريد التحدث مع أصدقائي وفهم الأخبار بشكل أفضل.";
const meaningExpectations: Record<string, Record<string, string>> | undefined = process.env.STUDIO_TEST_EXPECTATIONS ? JSON.parse(await readFile(process.env.STUDIO_TEST_EXPECTATIONS, "utf8")) : undefined;
const meaningChecks: { scope: string; fact: string; passed: boolean }[] = [];
function checkMeaning(scope: string, text: string, checks?: Record<string, string>) {
  for (const [fact, pattern] of Object.entries(checks || {})) meaningChecks.push({ scope, fact, passed: new RegExp(pattern, "iu").test(text.normalize("NFKC").replace(/\p{M}/gu, "")) });
}
await writeFile(path.join(directory, "source-reference.txt"), reference);
async function checkResponse(response: Response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 1500)}`);
  return response;
}
let source: Buffer;
if (inputMedia) { console.log("Testing the supplied media with real local models."); source = await readFile(inputMedia); }
else {
  console.log("Generating real Arabic speech with the installed Piper model.");
  const sourceRequest = new FormData(); sourceRequest.set("text", reference); sourceRequest.set("language", "ar"); sourceRequest.set("voice", "ar-kareem");
  source = Buffer.from(await (await checkResponse(await fetch(`${gateway}/synthesize`, { method: "POST", headers: authorization, body: sourceRequest, signal: AbortSignal.timeout(180000) }))).arrayBuffer());
}
const extension = inputMedia ? path.extname(inputMedia).slice(1).toLowerCase() : "wav";
const sourcePath = path.join(directory, `arabic-source.${extension}`); await writeFile(sourcePath, source);
const sourceInfo = await inspect(sourcePath, new AbortController().signal);
const status: Capabilities = await (await checkResponse(await fetch(`${origin}/api/translation/status`))).json();
assert(status.ready && status.worker && !status.cloud, "Local providers and worker must be ready, without cloud processing");
const voice = process.env.STUDIO_TEST_VOICE || "auto";
assert(status.languages.includes(target), `An installed voice must support ${target}`);
console.log(`${existingJob ? "Verifying saved job for" : "Uploading"} ${sourceInfo.duration.toFixed(2)} s through the real app API (${expectedSource} → ${target}).`);
const started = Date.now();
const browserTest = process.env.STUDIO_TEST_BROWSER_UPLOAD === "true";
async function uploadInBrowser(): Promise<Job> {
  assert(inputMedia, "Browser upload requires STUDIO_TEST_MEDIA");
  const { chromium, expect } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/translation`);
    await expect(page.getByText("AI konfigurerad", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Målspråk", exact: true }).selectOption(target);
    if (target === "en") await page.getByRole("combobox", { name: /^Engelsk variant/u }).selectOption(process.env.STUDIO_TEST_ENGLISH_LOCALE || "en-US");
    await page.getByRole("combobox", { name: /^AI-röst/u }).selectOption(voice);
    await page.getByRole("checkbox", { name: "Jag har rätt att översätta och bearbeta detta material." }).check();
    await page.getByLabel("Välj ljud eller video", { exact: true }).setInputFiles(path.resolve(inputMedia));
    const uploaded = page.waitForResponse((r) => r.url() === `${origin}/api/translation/jobs` && r.request().method() === "POST");
    await page.getByRole("button", { name: "Översätt ljud / Translate Audio", exact: true }).click();
    const response = await uploaded; assert.equal(response.status(), 201);
    // The UI immediately navigates after upload; DevTools may evict that body.
    await page.waitForURL((url) => !!url.searchParams.get("job"));
    const id = new URL(page.url()).searchParams.get("job");
    return (await checkResponse(await fetch(`${origin}/api/translation/jobs/${id}`))).json();
  } finally { await browser.close(); }
}
let job: Job = existingJob ? await (await checkResponse(await fetch(`${origin}/api/translation/jobs/${existingJob}`))).json() : browserTest ? await uploadInBrowser() : await (await checkResponse(await fetch(`${origin}/api/translation/jobs`, {
  method: "POST", headers: { "Content-Type": "application/octet-stream", Origin: origin, "x-file-name": inputMedia ? encodeURIComponent(path.basename(inputMedia)) : "arabic-known-speech.wav", "x-studio-options": encodeURIComponent(JSON.stringify({ source: "auto", targets: [target], englishLocale: process.env.STUDIO_TEST_ENGLISH_LOCALE || "en-US", style: "natural", mode: "replace", voice, rights: true, cloudConsent: false })) }, body: new Uint8Array(source),
}))).json();
if (existingJob) {
  const original = Buffer.from(await (await checkResponse(await fetch(`${origin}/api/translation/jobs/${existingJob}/file?original=true`))).arrayBuffer());
  assert(source.equals(original), "Originalfilen matchar inte det befintliga jobbets media");
}
await writeFile(path.join(directory, "job-id.txt"), job.id);
let last = "";
for (let n = 0; n < 400; n++) {
  job = await (await checkResponse(await fetch(`${origin}/api/translation/jobs/${job.id}`, { cache: "no-store" }))).json();
  if (job.message !== last) { last = job.message; console.log(`${job.status}/${job.stage}: ${last}`); }
  if (!["queued", "running"].includes(job.status)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
await writeFile(path.join(directory, "job.json"), JSON.stringify(job, null, 2));
if (job.status !== "completed") {
  await writeFile(path.join(directory, "report.json"), JSON.stringify({ passed: false, jobId: job.id, status: job.status, message: job.message, warnings: job.warnings, inputMedia, browserUpload: browserTest && !existingJob, target, directory }, null, 2));
}
assert.equal(job.status, "completed", `${job.error || job.message} Evidence: ${directory}`);
assert.equal(job.detectedLanguage, expectedSource, `Source language should be detected as ${expectedSource}`);
const expected = job.translations[target].map((s) => s.text).join(" ");
checkMeaning("source", job.segments.map((s) => s.text).join(" "), meaningExpectations?.source);
checkMeaning("translation", expected, meaningExpectations?.translation);
await writeFile(path.join(directory, `${target}-translation.txt`), expected);
function tokens(text: string) { return text.normalize("NFKC").toLowerCase().replace(/\bi dag\b/gu, "idag").replace(/\p{M}/gu, "").replace(/[\p{P}\p{S}]/gu, " ").split(/\s+/).filter(Boolean); }
function wer(reference: string, actual: string) {
  const a = tokens(reference), b = tokens(actual); let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); row = next; }
  return row[b.length] / Math.max(1, a.length);
}
const verification: Record<string, unknown> = {};
const qualityFailures: string[] = [];
const timingExpectations: { start: number; end: number }[] | undefined = process.env.STUDIO_TEST_TIMING_EXPECTATIONS ? JSON.parse(await readFile(process.env.STUDIO_TEST_TIMING_EXPECTATIONS, "utf8")) : undefined;
if (timingExpectations) {
  if (job.segments.length !== timingExpectations.length) qualityFailures.push("Known timing fixture segment count changed");
  for (const [i, expected] of timingExpectations.entries()) if (!job.segments[i] || Math.abs(job.segments[i].start - expected.start) > 0.35) qualityFailures.push(`Source timestamp ${i + 1} differs from the known fixture position`);
}
const availableFormats = sourceInfo.video ? ["wav", "mp3", "m4a", "mp4"] : ["wav", "mp3", "m4a"];
const formats = process.env.STUDIO_TEST_FORMATS?.split(",").map((v) => v.trim()) || availableFormats;
assert(formats.length && formats.every((v) => availableFormats.includes(v)), "Invalid verification format selection");
async function verifySpeech(file: string, format: string, duration: number) {
  const results: { start: number; language: string; language_probability?: number; segments: { start: number; end: number; text: string; words?: { start: number; end: number; word: string }[] }[] }[] = [];
  for (let start = 0; start < duration; start += 60) {
    const part = duration > 60 ? path.join(directory, `${format}-verification-${start}.wav`) : file;
    if (duration > 60) await chunk(file, part, start, Math.min(60, duration - start), new AbortController().signal);
    const form = new FormData(); form.set("file", await openAsBlob(part), path.basename(part));
    // Each independent run uses automatic language detection and no text hint.
    const data = await (await checkResponse(await fetch(`${gateway}/transcribe`, { method: "POST", headers: authorization, body: form, signal: AbortSignal.timeout(600000) }))).json();
    results.push({ start, ...data });
  }
  return { language: results.every((r) => r.language === results[0].language) ? results[0].language : "mixed", language_probability: Math.min(...results.map((r) => r.language_probability ?? 0)),
    segments: results.flatMap((r) => r.segments.map((s: { start: number; end: number; text: string; words?: { start: number; end: number; word: string }[] }) => ({ ...s, start: s.start + r.start, end: s.end + r.start, words: s.words?.map((w) => ({ ...w, start: w.start + r.start, end: w.end + r.start })) }))),
    verificationChunks: results.map((r) => ({ start: r.start, language: r.language, language_probability: r.language_probability })), prompt: null, languageHint: null };
}
for (const format of formats) {
  const bytes = Buffer.from(await (await checkResponse(await fetch(`${origin}/api/translation/jobs/${job.id}/file?target=${target}&format=${format}&download=true`))).arrayBuffer());
  assert(!bytes.equals(source), "Export must differ from the Arabic source");
  const file = path.join(directory, `${target}-export.${format}`); await writeFile(file, bytes);
  const info = await inspect(file, new AbortController().signal);
  const heard = await verifySpeech(file, format, info.duration);
  const text = heard.segments.map((s: { text: string }) => s.text).join(" ").trim(); const errorRate = wer(expected, text);
  checkMeaning(format, text, meaningExpectations?.audio);
  verification[format] = { language: heard.language, probability: heard.language_probability, text, wordErrorRate: errorRate, duration: info.duration, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  console.log(`${format.toUpperCase()} auto-detected ${heard.language}, WER ${(errorRate * 100).toFixed(1)} %: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);
  await writeFile(path.join(directory, `${format}-transcription.json`), JSON.stringify(heard, null, 2));
  if (heard.language !== target) qualityFailures.push(`${format}: detected language ${heard.language}, expected ${target}`);
  if (errorRate > 0.25) qualityFailures.push(`${format}: WER ${(errorRate * 100).toFixed(1)} % exceeds 25 %`);
  if (format === "wav" && Math.abs(info.duration - sourceInfo.duration) > 0.08) qualityFailures.push("WAV duration drift");
  if (format === "wav" && timingExpectations) {
    const pcm = path.join(directory, "timing-check.pcm");
    await ffmpeg([...inputArgs(file), "-ac", "1", "-ar", "16000", "-f", "s16le", pcm], new AbortController().signal);
    const samples = await readFile(pcm); const active: number[] = [];
    for (let offset = 0; offset + 640 <= samples.length; offset += 640) {
      let energy = 0; for (let n = 0; n < 640; n += 2) energy += (samples.readInt16LE(offset + n) / 32768) ** 2;
      if (Math.sqrt(energy / 320) > 0.005) active.push(offset / 32000);
    }
    const measuredStarts = timingExpectations.map((window) => active.find((t) => t >= window.start - 0.35 && t <= window.start + 0.6) ?? null);
    const outside = active.filter((t) => !timingExpectations.some((window) => t >= window.start - 0.35 && t <= window.end + 0.75));
    if (measuredStarts.some((t) => t === null)) qualityFailures.push("Speech missing at a known fixture start");
    if (outside.length > 5) qualityFailures.push(`Speech occurs outside known fixture windows (${(outside.length * 0.02).toFixed(2)} s)`);
    verification.timing = { expectedWindows: timingExpectations, measuredStarts, audibleSecondsOutsideWindows: outside.length * 0.02, method: "20 ms PCM RMS blocks, threshold 0.005; known constructed fixture only, not a lip-sync measurement" };
  }
  if (format === "mp4") {
    if (!info.video) qualityFailures.push("MP4 video stream missing");
    if (Math.abs(info.duration - sourceInfo.duration) > 0.08) qualityFailures.push("Video duration drift");
  }
}
const sourceText = job.segments.map((s) => s.text).join(" ");
let browserVerification: Record<string, unknown> | undefined;
if (browserTest && sourceInfo.video) {
  const { chromium, expect } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/translation?job=${job.id}`);
    await expect(page.getByRole("combobox", { name: /^Exportformat/u })).toBeVisible({ timeout: 20000 });
    await page.getByRole("combobox", { name: /^Exportformat/u }).selectOption("mp4");
    await expect(page.getByRole("link", { name: "Hämta MP4", exact: true })).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "Översatt AI-tal", exact: true }).click();
    const video = page.locator('video[aria-label="Översatt AI-tal"]');
    await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    const playback = await video.evaluate(async (element) => {
      const v = element as HTMLVideoElement; v.currentTime = 1; await v.play();
      await new Promise((r) => setTimeout(r, 1200)); v.pause();
      return { time: v.currentTime, width: v.videoWidth, height: v.videoHeight, duration: v.duration, error: v.error?.message };
    });
    assert(playback.time > 1.5 && playback.width > 0 && !playback.error, "Translated video must actually play");
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(directory, "video-ui.png"), fullPage: true });
    browserVerification = { passed: true, actualFileUploadedThroughUI: !existingJob, playback, pageErrors: errors };
  } finally { await browser.close(); }
}
const manifest = JSON.parse(await readFile("local-ai/models/manifest.json", "utf8"));
const actualVoice = resolveVoice(target, job.options, status);
const report = { passed: meaningChecks.every((c) => c.passed) && !qualityFailures.length, qualityFailures, meaningChecks, date: new Date().toISOString(), fixture: inputMedia ? "Supplied media; provenance must identify recorded or synthetic speech; no mocked providers" : "Neural Arabic speech synthesized locally from the disclosed reference; no mocked providers", cloud: false, origin, jobId: job.id,
  target, inputMedia, verificationScope: "Real upload/worker/export and unprompted, automatic-language ASR of downloaded audio. This is a separate ASR run using the same installed model, not an independent model. Semantic correctness requires source reference review; MOS/naturalness is not measured.",
  corrections: process.env.STUDIO_TEST_CORRECTIONS ? JSON.parse(await readFile(process.env.STUDIO_TEST_CORRECTIONS, "utf8")) : [],
  providers: { asr: `${path.basename(process.env.WHISPER_MODEL || "unknown")} / CPU int8`, translationConfigured: target === "en" ? process.env.OLLAMA_ENGLISH_MODEL || process.env.OLLAMA_MODEL : process.env.OLLAMA_MODEL, translationAtGeneration: process.env.STUDIO_TEST_TRANSLATION_MODEL_LABEL || "Model selection was not persisted per segment; see worker run configuration.", tts: actualVoice === "sv-mms-nc" ? "MMS Swedish / CC-BY-NC-4.0" : `Piper ${actualVoice}` }, modelRevisions: { whisper: manifest.whisper, piper: manifest.piper, ollama: manifest.ollama, mms: manifest.mms },
  reference, sourceReviewed: job.sourceReviewed || false, sourceSha256: createHash("sha256").update(source).digest("hex"), sourceTranscription: sourceText, sourceWordErrorRate: reference ? wer(reference, sourceText) : null, translation: expected, sourceDuration: sourceInfo.duration, processing: job.metrics, elapsedMs: Date.now() - started, verification, browserVerification, directory };
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, jobId: job.id, target, qualityFailures, meaningChecks: `${meaningChecks.filter((c) => c.passed).length}/${meaningChecks.length}`, directory }, null, 2));
assert(report.passed, `Failed checks: ${[...qualityFailures, ...meaningChecks.filter((c) => !c.passed).map((c) => `${c.scope}: ${c.fact}`)].join(", ")}. Evidence: ${directory}`);
