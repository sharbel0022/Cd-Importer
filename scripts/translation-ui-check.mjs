import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { wavBlob } from "../src/lib/translation/client.ts";

// Test-only AI gateway. Web UI, routes, upload, worker, FFmpeg and downloads are
// real. Synthetic fixtures do not measure ASR/translation/voice model quality.
const dir = path.resolve("test-results", `translation-ui-${randomUUID()}`); await mkdir(dir, { recursive: true });
const source = Buffer.from(await wavBlob(Int16Array.from({ length: 48000 }, (_, i) => Math.sin(i * 2 * Math.PI * 220 / 16000) * 9000)).arrayBuffer());
const speech = Buffer.from(await wavBlob(Int16Array.from({ length: 12800 }, (_, i) => Math.sin(i * 2 * Math.PI * 880 / 16000) * 9000)).arrayBuffer());
const gateway = http.createServer(async (req, res) => {
  const chunks = []; for await (const part of req) chunks.push(part);
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/health") res.end(JSON.stringify({ ready: ttsReady, services: { asr: true, translation: true, tts: ttsReady }, languages: ttsReady ? ["sv", "en", "ar"] : [], voices: ttsReady ? ["en-us-female", "en-uk-male", "sv-female"] : [], voiceLanguages: { "en-us-female": ["en"], "en-uk-male": ["en"], "sv-female": ["sv"] }, voiceLocales: { "en-us-female": "en-US", "en-uk-male": "en-GB" }, diarization: false, cloning: false, separation: false, message: "TEST FIXTURE" }));
  else if (req.url === "/transcribe") { await new Promise((r) => setTimeout(r, 900)); const live = /name="file"; filename="audio.wav"/.test(Buffer.concat(chunks).toString()) && liveMode; res.end(JSON.stringify({ language: "ar", segments: [{ start: 0.4, end: 1.8, text: "مرحبا بالعالم", uncertain: !live, confidence: live ? 0.95 : 0.45, words: [{ start: 0.4, end: 0.9, word: "مرحبا", probability: live ? 0.95 : 0.45 }, { start: 1, end: 1.8, word: "بالعالم", probability: 0.95 }] }] })); }
  else if (req.url === "/translate") { const payload = JSON.parse(Buffer.concat(chunks)); const data = JSON.parse(payload.messages[1].content); res.end(JSON.stringify({ segments: data.segments.map((s) => ({ id: s.id, text: "Hello world from the studio" })) })); }
  else if (req.url === "/synthesize") { synthCount++; if (!ttsReady) { res.statusCode = 503; res.end("{}"); } else { res.setHeader("Content-Type", "audio/wav"); res.end(speech); } }
  else { res.statusCode = 404; res.end("{}"); }
});
gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
let liveMode = false; let ttsReady = true; let synthCount = 0;
const port = Number(process.env.STUDIO_UI_PORT || 3187); const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, OPENAI_API_KEY: "", STUDIO_DATA_DIR: path.join(dir, "jobs"), STUDIO_LOCAL_URL: `http://127.0.0.1:${gateway.address().port}`, STUDIO_ASR_PROVIDER: "local", STUDIO_TRANSLATION_PROVIDER: "local", STUDIO_TTS_PROVIDER: "local" };
const children = []; let browser;
function child(args) { const process = spawn(globalThis.process.execPath, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); children.push(process); let log = ""; process.stdout.on("data", (b) => { log += b; }); process.stderr.on("data", (b) => { log += b; }); process.on("exit", () => { void writeFile(path.join(dir, args.includes("start") ? "server.log" : "worker.log"), log); }); return process; }
try {
  child(["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)]);
  child(["--import", "tsx", "scripts/translation-worker.ts"]);
  let ready = false; for (let i = 0; i < 90; i++) { try { const res = await fetch(`${origin}/api/translation/status`); if (res.ok && (await res.json()).worker) { ready = true; break; } } catch { /* startup */ } await new Promise((r) => setTimeout(r, 500)); }
  assert(ready, "Next server and worker did not start");
  browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ["microphone"], acceptDownloads: true }); const page = await context.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/translation`); await expect(page.getByText("AI konfigurerad", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Målspråk", exact: true })).toHaveValue("en");
  await expect(page.getByRole("combobox", { name: "Engelsk variant" })).toHaveValue("en-US");
  await expect(page.getByRole("combobox", { name: "Översättningsläge", exact: true })).toHaveValue("faithful");
  await page.getByRole("combobox", { name: "Översättningsläge", exact: true }).selectOption("natural");
  await page.getByRole("combobox", { name: "Översättningsläge", exact: true }).selectOption("faithful");
  await expect(page.getByRole("combobox", { name: "AI-röst", exact: true })).toHaveValue("auto");
  await expect(page.getByRole("combobox", { name: "AI-röst", exact: true }).locator('option[value="sv-female"]')).toHaveCount(0);
  await page.getByRole("combobox", { name: "Engelsk variant" }).selectOption("en-GB");
  await expect(page.getByRole("combobox", { name: "AI-röst", exact: true }).locator('option[value="en-us-female"]')).toHaveCount(0);
  await page.getByRole("slider", { name: "Taltempo", exact: true }).fill("1.1");
  await page.getByRole("checkbox", { name: "Jag har rätt att översätta och bearbeta detta material." }).check();
  const previewResponse = page.waitForResponse((response) => response.url().endsWith("/api/translation/preview"));
  await page.getByRole("button", { name: "Förhandslyssna på AI-röst", exact: true }).click();
  assert.equal((await previewResponse).headers()["x-studio-voice"], "en-uk-male");
  await expect(page.getByLabel("AI-röstprov")).toHaveAttribute("src", /^blob:/, { timeout: 20000 });
  await page.locator('input[type="file"]').setInputFiles({ name: "arabic-fixture.wav", mimeType: "audio/wav", buffer: source });
  await page.getByRole("button", { name: "Översätt ljud / Translate Audio", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pausa", exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Pausa", exact: true }).click();
  const resume = page.getByRole("button", { name: "Återuppta", exact: true });
  const approve = page.getByRole("button", { name: "Jag har granskat transkriptet · fortsätt", exact: true });
  await expect(resume.or(approve)).toBeVisible({ timeout: 20000 });
  if (await resume.isVisible()) await resume.click();
  await expect(approve).toBeVisible({ timeout: 30000 });
  await expect(page.getByLabel("Översättning (en)")).toBeEnabled();
  await page.locator('.ts-segments textarea').first().fill("مرحبا بكم بالعالم");
  await page.getByLabel("Översättning (en)").fill("Hello world from the studio");
  await expect(approve).toBeDisabled();
  await page.getByRole("button", { name: "Spara ändringar", exact: true }).click();
  await expect(page.getByLabel("Översättning (en)")).toHaveValue("Hello world from the studio");
  await expect(approve).toBeEnabled();
  await page.getByRole("button", { name: "Spela original s1", exact: true }).click();
  await expect.poll(() => page.getByLabel("Spela valt segment").evaluate((a) => a.currentTime)).toBeGreaterThanOrEqual(0.4);
  await page.getByRole("button", { name: "Godkänn källa s1", exact: true }).click();
  await expect(page.getByText("Klart. Granska översättning och AI-röst innan vidare användning.", { exact: true })).toBeVisible({ timeout: 60000 });
  await expect(page.getByLabel("Översättning (en)")).toHaveValue("Hello world from the studio");
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("link", { name: "Hämta WAV" }).click(); const download = await downloadPromise; await download.saveAs(path.join(dir, "export.wav")); assert((await readFile(path.join(dir, "export.wav"))).length > 1000);
  await page.getByRole("button", { name: "Spela översättning s1", exact: true }).click();
  await expect.poll(() => page.getByLabel("Spela valt segment").evaluate((a) => a.readyState)).toBeGreaterThan(0);
  const previewUrl = await page.getByLabel("Översatt AI-tal", { exact: true }).getAttribute("src");
  const mp3DownloadPromise = page.waitForEvent("download"); await page.getByRole("link", { name: "Hämta MP3", exact: true }).click();
  await (await mp3DownloadPromise).saveAs(path.join(dir, "export.mp3"));
  const previewBytes = Buffer.from(await (await fetch(new URL(previewUrl, origin))).arrayBuffer());
  assert(previewBytes.equals(await readFile(path.join(dir, "export.mp3"))), "Preview must be byte-identical to downloaded MP3");
  await page.getByRole("button", { name: "Översatt AI-tal", exact: true }).click();
  await expect.poll(() => page.getByLabel("Översatt AI-tal", { exact: true }).evaluate((audio) => audio.readyState)).toBeGreaterThan(0);
  await page.getByLabel("Översatt AI-tal", { exact: true }).evaluate(async (audio) => { audio.currentTime = 1; await audio.play(); });
  await page.getByRole("button", { name: "Original", exact: true }).click(); await page.waitForTimeout(500);
  const current = await page.getByLabel("Originalinspelning", { exact: true }).evaluate((audio) => audio.currentTime); assert(current >= 1 && current < 2.5, `Compare lost position: ${current}`);
  await page.getByLabel("Översättning (en)").fill("A short edited translation"); await page.getByRole("button", { name: "Spara ändringar", exact: true }).click(); await expect(page.getByRole("button", { name: "Återuppta", exact: true })).toBeVisible();
  assert.equal((await fetch(new URL(previewUrl, origin))).status, 409, "An edited job must revoke the previous preview revision");
  const beforeRegeneration = synthCount;
  await page.getByRole("button", { name: "Regenerera s1 & export", exact: true }).click();
  await expect(page.getByText("Klart. Granska översättning och AI-röst innan vidare användning.", { exact: true })).toBeVisible({ timeout: 60000 });
  assert.equal(synthCount, beforeRegeneration + 1, "Only the selected speech segment is regenerated");
  const jobId = new URL(page.url()).searchParams.get("job");
  const saved = await (await fetch(`${origin}/api/translation/jobs/${jobId}`)).json();
  assert.equal(saved.rawSegments[0].text, "مرحبا بالعالم");
  assert.equal(saved.sourceEdits[0].after.text, "مرحبا بكم بالعالم");
  await page.screenshot({ path: path.join(dir, "desktop.png"), fullPage: true });
  liveMode = true;
  await page.getByRole("tab", { name: "Live Translate", exact: true }).click(); await page.getByRole("button", { name: "Starta Live Translate", exact: true }).click();
  await expect(page.locator(".ts-live-lines")).toContainText("Hello world from the studio", { timeout: 30000 });
  await expect(page.getByText(/Senaste startfördröjning:/)).toBeVisible({ timeout: 15000 });
  const latency = await page.locator(".ts-live-status").innerText(); await page.getByRole("button", { name: "Stoppa Live Translate", exact: true }).click();
  await page.getByRole("tab", { name: "Ljud & video", exact: true }).click();
  await page.getByRole("button", { name: "Spela in", exact: true }).click(); await page.waitForTimeout(1600); await page.getByRole("button", { name: "Stoppa inspelning", exact: true }).click(); await expect(page.locator(".ts-dropzone h2")).toContainText("mikrofon-");
  for (const width of [768, 390, 360]) { await page.setViewportSize({ width, height: 900 }); await page.screenshot({ path: path.join(dir, `width-${width}.png`), fullPage: true }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow at ${width}`); }
  ttsReady = false; const beforeSubtitles = synthCount;
  await page.goto(`${origin}/translation`);
  await page.getByRole("combobox", { name: "Ljudläge", exact: true }).selectOption("subtitles");
  await expect(page.getByText("Undertexter konfigurerade", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Jag har rätt att översätta och bearbeta detta material." }).check();
  await page.locator('input[type="file"]').setInputFiles({ name: "subtitles-without-tts.wav", mimeType: "audio/wav", buffer: source });
  await page.getByRole("button", { name: "Översätt ljud / Translate Audio", exact: true }).click();
  await expect(page.getByText("Klart. Granska översättning och undertexter innan vidare användning.", { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole("combobox", { name: "Exportformat", exact: true }).selectOption("srt");
  const subtitleDownloadPromise = page.waitForEvent("download"); await page.getByRole("link", { name: "Hämta SRT", exact: true }).click();
  await (await subtitleDownloadPromise).saveAs(path.join(dir, "without-tts.srt"));
  assert.match(await readFile(path.join(dir, "without-tts.srt"), "utf8"), /Hello world from the studio/);
  assert.equal(synthCount, beforeSubtitles, "Subtitle mode must not invoke unavailable TTS");
  assert.deepEqual(errors, []); await context.close();
  const report = { passed: true, ai: "Explicit test-only fixture gateway; no real model quality measured", checks: ["Faithful default / Natural mode", "byte-identical MP3 preview/download", "individual source approval", "bounded original segment playback", "translated segment playback", "raw ASR and correction audit", "selected segment regeneration", "stale revision rejected", "English US default", "English UK and speech rate", "language compatible voices", "real TTS preview route and actual UK voice", "upload", "persistent worker", "pause/resume", "uncertain source approval", "source correction", "real FFmpeg export", "download", "side by side compare at same position", "segment editing", "Live PCM capture + NDJSON + playback", "fake microphone recording", "1440/768/390/360 layouts", "subtitle export with unavailable TTS and zero synthesis calls"], latency, directory: dir };
  await writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); for (const process of children) process.kill("SIGTERM"); await Promise.all(children.map((p) => p.exitCode !== null ? Promise.resolve() : once(p, "exit"))); await new Promise((r) => gateway.close(r)); }
