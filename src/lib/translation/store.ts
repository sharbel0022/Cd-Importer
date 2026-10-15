import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors";
import type { Job } from "./types";

export function dataRoot() { return path.resolve(process.env.STUDIO_DATA_DIR || ".translation-data"); }
export function jobDir(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new AppError("Ogiltigt jobb-ID.", 400);
  return path.join(dataRoot(), id);
}
export async function atomicWrite(file: string, value: string | Uint8Array) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { flag: "wx" });
    for (let n = 0; ; n++) {
      try { await rename(temp, file); break; }
      catch (error) { if (n >= 8 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "")) throw error; await new Promise((r) => setTimeout(r, 25 * (n + 1))); }
    }
  }
  finally { await rm(temp, { force: true }); }
}
export async function atomicJson(file: string, value: unknown) { await atomicWrite(file, JSON.stringify(value)); }
export async function readJob(id: string): Promise<Job> {
  try { return JSON.parse(await readFile(path.join(jobDir(id), "job.json"), "utf8")) as Job; }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError("Jobbet finns inte eller har rensats.", 404); }
}
// Short cross-process lock. No AI/network work is performed while holding it.
export async function updateJob(id: string, update: (job: Job) => void): Promise<Job> {
  const lock = path.join(jobDir(id), ".lock");
  for (let n = 0; ; n++) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => undefined); if (!info) continue;
      if (Date.now() - info.mtimeMs > 30_000) { await rm(lock, { recursive: true, force: true }); continue; }
      if (n >= 100) throw new AppError("Jobbet är upptaget. Försök igen.", 409);
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  try {
    const job = await readJob(id); update(job); job.updatedAt = new Date().toISOString();
    await atomicJson(path.join(jobDir(id), "job.json"), job); return job;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
export async function listJobs(): Promise<Job[]> {
  await mkdir(dataRoot(), { recursive: true });
  const names = await readdir(dataRoot());
  const jobs = await Promise.all(names.filter((id) => /^[0-9a-f-]{36}$/.test(id)).map((id) => readJob(id).catch(() => null)));
  return jobs.filter((j): j is Job => !!j).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function workerAvailable() {
  try { const value = JSON.parse(await readFile(path.join(dataRoot(), "worker.json"), "utf8")); return Date.now() - value.time < 15_000; }
  catch { return false; }
}
export function uploadMb() { return Math.min(1024, Math.max(1, Number(process.env.STUDIO_MAX_UPLOAD_MB) || 500)); }
export function durationLimit() { return Math.min(7200, Math.max(10, Number(process.env.STUDIO_MAX_DURATION_SECONDS) || 3600)); }
export async function enforceQuota(additionalBytes = uploadMb() * 1024 ** 2) {
  const limit = Math.min(50, Math.max(1, Number(process.env.STUDIO_DISK_GB) || 5)) * 1024 ** 3;
  let size = 0;
  async function scan(dir: string) { for (const e of await readdir(dir, { withFileTypes: true })) { if (e.isSymbolicLink()) continue; const p = path.join(dir, e.name); if (e.isDirectory()) await scan(p); else size += (await stat(p)).size; } }
  await mkdir(dataRoot(), { recursive: true }); await scan(dataRoot());
  if (size + additionalBytes > limit) throw new AppError("Studions lagringsgräns är nådd. Radera äldre jobb, dela filen eller höj STUDIO_DISK_GB.", 507);
}
export async function receiveUpload(request: Request, destination: string, limit: number) {
  if (!request.body) throw new AppError("Välj en mediefil.");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new AppError("Filen är för stor.", 413);
  const file = await open(destination, "wx"); const reader = request.body.getReader(); let size = 0; let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => undefined); }, 300_000);
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new AppError("Filen är för stor.", 413);
      let written = 0;
      while (written < value.length) written += (await file.write(value, written, value.length - written)).bytesWritten;
    }
    if (expired || request.signal.aborted || !size) throw new AppError("Uppladdningen avbröts eller var tom.", 408);
  } finally { clearTimeout(timer); reader.releaseLock(); await file.close(); }
}
