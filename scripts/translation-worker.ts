import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { atomicJson, dataRoot, jobDir, listJobs, updateJob } from "../src/lib/translation/store";
import { runJob } from "../src/lib/translation/pipeline";

await mkdir(dataRoot(), { recursive: true });
const lockFile = path.join(dataRoot(), "worker.lock");
async function lock() {
  try { const f = await open(lockFile, "wx"); await f.writeFile(String(process.pid)); await f.close(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await readFile(lockFile, "utf8")); let alive = false;
    try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch { /* dead worker */ }
    if (alive) throw new Error("En studio-worker körs redan för denna datamapp.", { cause: error });
    await rm(lockFile, { force: true }); await lock();
  }
}
await lock();
const stop = new AbortController();
process.on("SIGINT", () => stop.abort()); process.on("SIGTERM", () => stop.abort());
const heartbeat = () => atomicJson(path.join(dataRoot(), "worker.json"), { time: Date.now(), pid: process.pid });
await heartbeat(); const timer = setInterval(() => { void heartbeat().catch(() => undefined); }, 4000);
let lastCleanup = 0;
try {
  for (const job of await listJobs()) if (job.status === "running") await updateJob(job.id, (j) => { j.status = "paused"; j.command = undefined; j.message = "Återställd efter worker-avbrott. Återuppta när du är redo."; });
  console.log("AI Translation Studio worker redo. En fil åt gången. Ctrl+C pausar aktivt jobb.");
  while (!stop.signal.aborted) {
    if (Date.now() - lastCleanup > 3600_000) {
      const retention = Math.max(1, Math.min(720, Number(process.env.STUDIO_RETENTION_HOURS) || 24)) * 3600_000;
      for (const job of await listJobs()) if (!["running", "queued"].includes(job.status) && Date.now() - new Date(job.updatedAt).getTime() > retention) await rm(jobDir(job.id), { recursive: true, force: true });
      // Interrupted uploads have no manifest and are cleaned after one hour.
      for (const name of await readdir(dataRoot())) if (/^[0-9a-f-]{36}$/.test(name)) { const dir = jobDir(name); try { await stat(path.join(dir, "job.json")); } catch { if (Date.now() - (await stat(dir)).mtimeMs > 3600_000) await rm(dir, { recursive: true, force: true }); } }
      lastCleanup = Date.now();
    }
    const next = (await listJobs()).reverse().find((j) => j.status === "queued");
    if (next) await runJob(next.id, stop.signal);
    else await new Promise((r) => setTimeout(r, 750));
  }
} finally { clearInterval(timer); await rm(path.join(dataRoot(), "worker.json"), { force: true }); await rm(lockFile, { force: true }); }
