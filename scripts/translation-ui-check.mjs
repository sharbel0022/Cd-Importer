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
  if (req.url === "/health") res.end(JSON.stringify({ ready: true, services: { asr: true, translation: true, tts: true }, languages: ["sv", "en", "ar"], voices: ["coral", "ash"], diarization: false, cloning: false, separation: false, message: "TEST FIXTURE" }));
  else if (req.url === "/transcribe") { await new Promise((r) => setTimeout(r, 900)); res.end(JSON.stringify({ language: "ar", segments: [{ start: 0.4, end: 1.8, text: "مرحبا بالعالم" }] })); }
  else if (req.url === "/translate") { const payload = JSON.parse(Buffer.concat(chunks)); const data = JSON.parse(payload.messages[1].content); res.end(JSON.stringify({ segments: data.segments.map((s) => ({ id: s.id, text: "Hej världen från studion" })) })); }
  else if (req.url === "/synthesize") { res.setHeader("Content-Type", "audio/wav"); res.end(speech); }
  else { res.statusCode = 404; res.end("{}"); }
});
gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
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
  await page.getByRole("checkbox", { name: "Jag har rätt att översätta och bearbeta detta material." }).check();
  await page.locator('input[type="file"]').setInputFiles({ name: "arabic-fixture.wav", mimeType: "audio/wav", buffer: source });
  await page.getByRole("button", { name: "Skapa översättning", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pausa", exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Pausa", exact: true }).click();
  await expect(page.getByRole("button", { name: "Återuppta", exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Återuppta", exact: true }).click();
  await expect(page.getByText("Klart. Granska översättning och AI-röst innan vidare användning.", { exact: true })).toBeVisible({ timeout: 60000 });
  await expect(page.getByLabel("Översättning (sv)")).toHaveValue("Hej världen från studion");
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("link", { name: "Hämta WAV" }).click(); const download = await downloadPromise; await download.saveAs(path.join(dir, "export.wav")); assert((await readFile(path.join(dir, "export.wav"))).length > 1000);
  await page.getByRole("button", { name: "Översatt AI-tal", exact: true }).click();
  await expect.poll(() => page.locator(".ts-preview audio").evaluate((audio) => audio.readyState)).toBeGreaterThan(0);
  await page.locator(".ts-preview audio").evaluate(async (audio) => { audio.currentTime = 1; await audio.play(); });
  await page.getByRole("button", { name: "Original", exact: true }).click(); await page.waitForTimeout(500);
  const current = await page.locator(".ts-preview audio").evaluate((audio) => audio.currentTime); assert(current >= 1 && current < 2.5, `Compare lost position: ${current}`);
  await page.getByLabel("Översättning (sv)").fill("Kort redigerad översättning"); await page.getByRole("button", { name: "Spara ändringar", exact: true }).click(); await expect(page.getByRole("button", { name: "Återuppta", exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(dir, "desktop.png"), fullPage: true });
  await page.getByRole("tab", { name: "Live Translate", exact: true }).click(); await page.getByRole("button", { name: "Starta Live Translate", exact: true }).click();
  await expect(page.locator(".ts-live-lines")).toContainText("Hej världen från studion", { timeout: 30000 });
  await expect(page.getByText(/Senaste startfördröjning:/)).toBeVisible({ timeout: 15000 });
  const latency = await page.locator(".ts-live-status").innerText(); await page.getByRole("button", { name: "Stoppa Live Translate", exact: true }).click();
  await page.getByRole("tab", { name: "Ljud & video", exact: true }).click();
  await page.getByRole("button", { name: "Spela in", exact: true }).click(); await page.waitForTimeout(1600); await page.getByRole("button", { name: "Stoppa inspelning", exact: true }).click(); await expect(page.locator(".ts-dropzone h2")).toContainText("mikrofon-");
  for (const width of [768, 390, 360]) { await page.setViewportSize({ width, height: 900 }); await page.screenshot({ path: path.join(dir, `width-${width}.png`), fullPage: true }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow at ${width}`); }
  assert.deepEqual(errors, []); await context.close();
  const report = { passed: true, ai: "Explicit test-only fixture gateway; no real model quality measured", checks: ["upload", "persistent worker", "pause/resume", "real FFmpeg export", "download", "compare at same position", "segment editing", "Live PCM capture + NDJSON + playback", "fake microphone recording", "1440/768/390/360 layouts"], latency, directory: dir };
  await writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); for (const process of children) process.kill("SIGTERM"); await Promise.all(children.map((p) => p.exitCode !== null ? Promise.resolve() : once(p, "exit"))); await new Promise((r) => gateway.close(r)); }
