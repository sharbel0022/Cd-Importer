import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { wavBlob } from "@/lib/translation/client";
import { atomicJson } from "@/lib/translation/store";
import { optionsSchema, type Job } from "@/lib/translation/types";

it("recovers disk checkpoints after a real worker is killed and continues after an unexpected job error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cd-worker-restart-"));
  const id = randomUUID(); const dir = path.join(root, id); await mkdir(dir);
  const now = new Date().toISOString();
  const job: Job = { id, name: "restart.wav", extension: "wav", createdAt: now, updatedAt: now, revision: 0, options: optionsSchema.parse({ source: "en", targets: ["en"], rights: true }), status: "queued", stage: "uploading", message: "Queued", segments: [], translations: {}, outputs: {}, warnings: [], metrics: { processingMs: 0, stages: {} } };
  const tone = async (seconds: number, frequency: number) => Buffer.from(await wavBlob(Int16Array.from({ length: seconds * 16000 }, (_, n) => Math.sin(n * 2 * Math.PI * frequency / 16000) * 10000)).arrayBuffer());
  await writeFile(path.join(dir, "original.wav"), await tone(4, 220)); await atomicJson(path.join(dir, "job.json"), job);
  const speech = await tone(0.6, 880);
  const calls = { asr: 0, translation: 0, tts: 0 }; let holdSecond = true; let blocked: ServerResponse | undefined;
  const gateway = createServer(async (request, response) => {
    try {
      if (request.url === "/health") {
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ready: true, services: { asr: true, translation: true, tts: true }, languages: ["en"], voices: ["en-test"], voiceLanguages: { "en-test": ["en"] }, voiceLocales: { "en-test": "en-US" }, diarization: false, cloning: false, separation: false, message: "Explicit restart-test provider fixture" })); return;
      }
      const blocks: Buffer[] = []; for await (const block of request) blocks.push(Buffer.from(block));
      if (request.url === "/transcribe") {
        calls.asr++; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ language: "en", language_probability: 0.99, segments: [{ start: 0.1, end: 1.2, text: "Hello." }, { start: 1.7, end: 2.9, text: "Welcome." }] }));
      } else if (request.url === "/translate") {
        calls.translation++; const input = JSON.parse(Buffer.concat(blocks).toString("utf8"));
        const source = JSON.parse(input.messages.at(-1).content);
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ segments: source.segments.map((s: { id: string; text: string }) => ({ id: s.id, text: s.text })) }));
      } else if (request.url === "/synthesize") {
        calls.tts++;
        if (holdSecond && calls.tts === 2) { blocked = response; return; }
        response.setHeader("Content-Type", "audio/wav"); response.end(speech);
      } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address(); if (!address || typeof address === "string") throw new Error("Fixture gateway did not start");
  const port = address.port;
  let logs = ""; const processes: ChildProcess[] = [];
  function start() {
    const process = spawn(globalThis.process.execPath, ["--import", "tsx", "scripts/translation-worker.ts"], { cwd: globalThis.process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...globalThis.process.env, STUDIO_DATA_DIR: root, STUDIO_LOCAL_URL: `http://127.0.0.1:${port}`, STUDIO_ASR_PROVIDER: "local", STUDIO_TRANSLATION_PROVIDER: "local", STUDIO_TTS_PROVIDER: "local", STUDIO_LOCAL_TOKEN: "", OPENAI_API_KEY: "", STUDIO_RETENTION_HOURS: "24" } });
    process.stdout?.on("data", (chunk) => { logs = (logs + chunk).slice(-20000); }); process.stderr?.on("data", (chunk) => { logs = (logs + chunk).slice(-20000); }); processes.push(process); return process;
  }
  async function stored() { return JSON.parse(await readFile(path.join(dir, "job.json"), "utf8")) as Job; }
  async function until(predicate: () => Promise<boolean>) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
    throw new Error(`Worker condition timed out. ${logs}`);
  }
  async function kill(process: ChildProcess) {
    if (process.exitCode !== null || process.signalCode !== null) return;
    await new Promise<void>((resolve) => { process.once("close", () => resolve()); process.kill("SIGKILL"); });
  }
  try {
    const first = start();
    await until(async () => calls.tts === 2 && !!(await stored()).segmentOutputs?.en.s1);
    const checkpoint = await stored(); expect(checkpoint.status).toBe("running");
    expect(checkpoint.outputs.en).toEqual(["srt", "vtt", "txt", "json"]);
    const firstClip = checkpoint.segmentOutputs!.en.s1.file;
    await kill(first); blocked?.destroy(); holdSecond = false;
    const beforeRestart = { ...calls }; expect(beforeRestart).toEqual({ asr: 1, translation: 4, tts: 2 });
    start(); await until(async () => (await stored()).status === "paused");
    expect((await stored()).message).toContain("worker-avbrott");
    const paused = await stored(); paused.status = "queued"; await atomicJson(path.join(dir, "job.json"), paused);
    await until(async () => ["completed", "failed"].includes((await stored()).status));
    const result = await stored(); expect(result.status, `${result.error || ""}\n${logs}`).toBe("completed");
    expect(calls).toEqual({ asr: beforeRestart.asr, translation: beforeRestart.translation, tts: beforeRestart.tts + 1 });
    expect(result.segmentOutputs?.en.s1.file).toBe(firstClip);
    expect(result.outputs.en).toContain("mp3"); expect(result.outputManifest?.en.mp3.sha256).toMatch(/^[0-9a-f]{64}$/);
    // A syntactically readable old/corrupt manifest can throw during pipeline
    // finalization. The process-level job boundary must keep the queue alive.
    const brokenId = randomUUID(); const nextId = randomUUID(); const queuedAt = Date.now();
    for (const [index, next] of [brokenId, nextId].entries()) {
      const destination = path.join(root, next); await mkdir(destination);
      await writeFile(path.join(destination, "original.wav"), await tone(4, 220));
      await atomicJson(path.join(destination, "job.json"), { ...job, id: next, createdAt: new Date(queuedAt + index).toISOString(), updatedAt: new Date(queuedAt + index).toISOString(), metrics: index === 0 ? { processingMs: 0, stages: null } : { processingMs: 0, stages: {} } });
    }
    const readNext = async (next: string) => JSON.parse(await readFile(path.join(root, next, "job.json"), "utf8")) as Job;
    await until(async () => (await readNext(brokenId)).status === "failed" && (await readNext(nextId)).status === "completed");
    expect((await readNext(brokenId)).error).toContain("slutsteg");
    expect((await readNext(nextId)).outputs.en).toContain("mp3");
    expect(logs).toContain("Workern fortsätter");
  } finally {
    blocked?.destroy(); for (const process of processes) await kill(process);
    gateway.closeAllConnections(); await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 70000);
