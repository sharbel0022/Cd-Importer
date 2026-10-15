import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inspect } from "../src/lib/translation/media";
import type { Job } from "../src/lib/translation/types";

const origin = process.env.LIVE_TEST_ORIGIN || "http://127.0.0.1:3011";
const gateway = process.env.STUDIO_LOCAL_URL || "http://127.0.0.1:8765";
const authorization: Record<string, string> = process.env.STUDIO_LOCAL_TOKEN ? { Authorization: `Bearer ${process.env.STUDIO_LOCAL_TOKEN}` } : {};
const directory = path.resolve("test-results", `local-arabic-swedish-${new Date().toISOString().replace(/[:.]/g, "-")}`);
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
await writeFile(path.join(directory, "arabic-reference.txt"), reference);
async function checkResponse(response: Response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 1500)}`);
  return response;
}
let source: Buffer;
if (inputMedia) { console.log("Testing the supplied Arabic speech file."); source = await readFile(inputMedia); }
else {
  console.log("Generating real Arabic speech with the installed Piper model.");
  const sourceRequest = new FormData(); sourceRequest.set("text", reference); sourceRequest.set("language", "ar"); sourceRequest.set("voice", "ar-kareem");
  source = Buffer.from(await (await checkResponse(await fetch(`${gateway}/synthesize`, { method: "POST", headers: authorization, body: sourceRequest, signal: AbortSignal.timeout(180000) }))).arrayBuffer());
}
const extension = inputMedia ? path.extname(inputMedia).slice(1).toLowerCase() : "wav";
const sourcePath = path.join(directory, `arabic-source.${extension}`); await writeFile(sourcePath, source);
const sourceInfo = await inspect(sourcePath, new AbortController().signal);
const status = await (await checkResponse(await fetch(`${origin}/api/translation/status`))).json();
assert(status.ready && status.worker && !status.cloud, "Local providers and worker must be ready, without cloud processing");
const voice = process.env.STUDIO_TEST_VOICE || status.voices.find((v: string) => status.voiceLanguages[v]?.includes("sv"));
assert(voice, "A Swedish voice must be installed");
console.log(`Uploading ${sourceInfo.duration.toFixed(2)} s of Arabic speech through the real app API.`);
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
    await page.getByRole("combobox", { name: /^AI-röst/u }).selectOption(voice);
    await page.getByRole("checkbox", { name: "Jag har rätt att översätta och bearbeta detta material." }).check();
    await page.locator('input[type="file"]').setInputFiles(path.resolve(inputMedia));
    const uploaded = page.waitForResponse((r) => r.url() === `${origin}/api/translation/jobs` && r.request().method() === "POST");
    await page.getByRole("button", { name: "Skapa översättning", exact: true }).click();
    const response = await uploaded; assert.equal(response.status(), 201);
    // The UI immediately navigates after upload; DevTools may evict that body.
    await page.waitForURL((url) => !!url.searchParams.get("job"));
    const id = new URL(page.url()).searchParams.get("job");
    return (await checkResponse(await fetch(`${origin}/api/translation/jobs/${id}`))).json();
  } finally { await browser.close(); }
}
let job: Job = existingJob ? await (await checkResponse(await fetch(`${origin}/api/translation/jobs/${existingJob}`))).json() : browserTest ? await uploadInBrowser() : await (await checkResponse(await fetch(`${origin}/api/translation/jobs`, {
  method: "POST", headers: { "Content-Type": "application/octet-stream", Origin: origin, "x-file-name": inputMedia ? encodeURIComponent(path.basename(inputMedia)) : "arabic-known-speech.wav", "x-studio-options": encodeURIComponent(JSON.stringify({ source: "auto", targets: ["sv"], style: "natural", mode: "replace", voice, rights: true, cloudConsent: false })) }, body: new Uint8Array(source),
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
assert.equal(job.status, "completed", job.error || job.message);
assert.equal(job.detectedLanguage, "ar", "Source language should be detected as Arabic");
const expected = job.translations.sv.map((s) => s.text).join(" ");
checkMeaning("source", job.segments.map((s) => s.text).join(" "), meaningExpectations?.source);
checkMeaning("translation", expected, meaningExpectations?.translation);
await writeFile(path.join(directory, "swedish-translation.txt"), expected);
function tokens(text: string) { return text.normalize("NFKC").toLowerCase().replace(/\bi dag\b/gu, "idag").replace(/\p{M}/gu, "").replace(/[\p{P}\p{S}]/gu, " ").split(/\s+/).filter(Boolean); }
function wer(reference: string, actual: string) {
  const a = tokens(reference), b = tokens(actual); let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); row = next; }
  return row[b.length] / Math.max(1, a.length);
}
const verification: Record<string, unknown> = {};
const formats = sourceInfo.video ? ["wav", "mp3", "m4a", "mp4"] : ["wav", "mp3", "m4a"];
for (const format of formats) {
  const bytes = Buffer.from(await (await checkResponse(await fetch(`${origin}/api/translation/jobs/${job.id}/file?target=sv&format=${format}&download=true`))).arrayBuffer());
  assert(!bytes.equals(source), "Export must differ from the Arabic source");
  const file = path.join(directory, `swedish-export.${format}`); await writeFile(file, bytes);
  const form = new FormData(); form.set("file", await openAsBlob(file), `export.${format}`);
  // No source-language hint: the ASR must independently detect Swedish.
  const heard = await (await checkResponse(await fetch(`${gateway}/transcribe`, { method: "POST", headers: authorization, body: form, signal: AbortSignal.timeout(600000) }))).json();
  const text = heard.segments.map((s: { text: string }) => s.text).join(" ").trim(); const errorRate = wer(expected, text);
  checkMeaning(format, text, meaningExpectations?.audio);
  const info = await inspect(file, new AbortController().signal);
  verification[format] = { language: heard.language, probability: heard.language_probability, text, wordErrorRate: errorRate, duration: info.duration, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  console.log(`${format.toUpperCase()} auto-detected ${heard.language}, WER ${(errorRate * 100).toFixed(1)} %: ${text}`);
  await writeFile(path.join(directory, `${format}-transcription.json`), JSON.stringify(heard, null, 2));
  assert.equal(heard.language, "sv", `${format} does not independently identify as Swedish`);
  assert(errorRate <= 0.25, `${format} speech differs too much from the translated text`);
  if (format === "wav") assert(Math.abs(info.duration - sourceInfo.duration) <= 0.08, "WAV duration drift");
  if (format === "mp4") {
    assert(info.video, "Video export must retain its video stream");
    assert(Math.abs(info.duration - sourceInfo.duration) <= 0.08, "Video duration drift");
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
    const video = page.locator(".ts-preview video");
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
const report = { passed: meaningChecks.every((c) => c.passed), meaningChecks, date: new Date().toISOString(), fixture: inputMedia ? "Supplied recorded Arabic speech; no mocked providers" : "Real neural Arabic speech synthesized locally from the disclosed reference; no mocked providers", cloud: false, origin, jobId: job.id,
  verificationScope: "Real upload/worker/export and auto-ASR of downloaded audio. Semantic correctness requires separate source review.",
  corrections: process.env.STUDIO_TEST_CORRECTIONS ? JSON.parse(await readFile(process.env.STUDIO_TEST_CORRECTIONS, "utf8")) : [],
  providers: { asr: `${path.basename(process.env.WHISPER_MODEL || "unknown")} / CPU int8`, translation: process.env.OLLAMA_MODEL, tts: voice === "sv-mms-nc" ? "MMS Swedish / CC-BY-NC-4.0" : `Piper ${voice}` }, modelRevisions: { whisper: manifest.whisper, piper: manifest.piper, ollama: manifest.ollama, mms: manifest.mms },
  reference, sourceTranscription: sourceText, sourceWordErrorRate: reference ? wer(reference, sourceText) : null, translation: expected, sourceDuration: sourceInfo.duration, processing: job.metrics, elapsedMs: Date.now() - started, verification, browserVerification, directory };
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
assert(report.passed, `Critical meaning facts missing: ${meaningChecks.filter((c) => !c.passed).map((c) => `${c.scope}: ${c.fact}`).join(", ")}`);
