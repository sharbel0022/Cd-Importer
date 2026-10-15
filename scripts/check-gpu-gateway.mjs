// Actual loopback HTTP inference. The gateway must report CUDA; never approve text.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";

const { fetch, FormData, Blob, AbortSignal } = globalThis;

const port = Number(process.env.STUDIO_GPU_GATEWAY_PORT || 8766);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
const origin = `http://127.0.0.1:${port}`;
const separationCheck = process.argv.includes("--separation");
const reportFile = path.resolve("test-results/gpu-quality", separationCheck ? "gateway-separation.json" : "gateway.json");
await mkdir("test-results/gpu-quality", { recursive: true });
await writeFile(reportFile, JSON.stringify({ passed: false, status: "running", startedAt: new Date().toISOString() }));
const headers = process.env.STUDIO_LOCAL_TOKEN ? { Authorization: `Bearer ${process.env.STUDIO_LOCAL_TOKEN}` } : {};
const bytes = await readFile("local-ai/fixtures/fleurs-ar-eg-test-0.wav");
const body = new FormData();
body.set("file", new Blob([bytes], { type: "audio/wav" }), "reference.wav");
body.set("language", "auto");
const started = performance.now();
const response = await fetch(`${origin}/transcribe`, { method: "POST", headers, body, signal: AbortSignal.timeout(120_000) });
assert(response.ok, `GPU gateway HTTP ${response.status}`);
const result = await response.json();
assert.equal(result.settings.device, "cuda");
assert.equal(result.settings.compute_type, "float16");
assert(result.segments.length && result.segments.some((s) => s.text.trim()));
const report = { passed: true, httpSeconds: (performance.now() - started) / 1000,
  sourceSha256: createHash("sha256").update(bytes).digest("hex"), result,
  scope: "Real local HTTP ASR, including cold model load. No transcript approval or subjective accuracy claim." };
if (separationCheck) {
  const input = await readFile("test-results/demucs-evaluation/controlled-input.wav");
  const form = new FormData();
  form.set("file", new Blob([input], { type: "audio/wav" }), "controlled.wav");
  const start = performance.now();
  const separated = await fetch(`${origin}/separate`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(180_000) });
  assert(separated.ok, `Real separation HTTP ${separated.status}`);
  const output = Buffer.from(await separated.arrayBuffer());
  assert(output.length > 1000 && output.subarray(0, 4).toString() === "RIFF");
  const file = path.resolve("test-results/gpu-quality/gateway-background.wav");
  await writeFile(file, output);
  execFileSync(ffmpeg, ["-nostdin", "-v", "error", "-i", file, "-f", "null", "-"], { windowsHide: true });
  report.separation = { passed: true, httpSeconds: (performance.now() - start) / 1000, bytes: output.length,
    sha256: createHash("sha256").update(output).digest("hex"), decodedByFfmpeg: true,
    scope: "Actual existing gateway Demucs adapter and downloaded weights. Not a human preservation rating." };
}
await writeFile(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, device: result.settings.device, httpSeconds: report.httpSeconds }));
