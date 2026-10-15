import { constants } from "node:fs";
import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors";
import { atomicJson, enforceQuota, jobDir, readJob, updateJob } from "./store";
import { EXTENSIONS, type Job } from "./types";

export const projectActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("rename"), name: z.string().trim().min(1).max(200).refine((name) => Array.from(name).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 && character !== "/" && character !== "\\")), revision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("duplicate"), revision: z.number().int().nonnegative() }).strict(),
]);
const duplicable = new Set<Job["status"]>(["paused", "review", "failed", "completed"]);
function checkRevision(job: Job, revision: number) {
  if (job.revision !== revision) throw new AppError("Projektet har ändrats. Läs in den senaste versionen före ändringen.", 409);
}
export async function renameTranslationProject(id: string, revision: number, name: string) {
  const value = projectActionSchema.parse({ action: "rename", revision, name });
  if (value.action !== "rename") throw new AppError("Ogiltig projektändring.");
  return updateJob(id, (job) => { checkRevision(job, value.revision); job.originalName ??= job.name; job.name = value.name; });
}
async function ordinaryFile(file: string, required = false) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1) throw new AppError("Projektets källfil kan inte kopieras säkert.", 409);
    return info;
  } catch (cause) {
    if (!required && (cause as NodeJS.ErrnoException).code === "ENOENT") return;
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new AppError("Projektets originalfil saknas och kan inte kopieras.", 409);
    throw cause;
  }
}
export async function duplicateTranslationProject(id: string, revision: number, signal: AbortSignal) {
  const source = await readJob(id); checkRevision(source, revision);
  if (!duplicable.has(source.status) || source.command) throw new AppError("Pausa eller avsluta projektet före kopiering.", 409);
  if (!Object.hasOwn(EXTENSIONS, source.extension)) throw new AppError("Projektets källformat är ogiltigt.");
  const sourceDir = jobDir(source.id);
  if ((await lstat(sourceDir)).isSymbolicLink()) throw new AppError("Länkade projektmappar kan inte kopieras.", 409);
  const files = [];
  for (const filename of [`original.${source.extension}`, "normalized.wav", "source-preview.mp4"]) {
    const file = path.join(sourceDir, filename); const info = await ordinaryFile(file, filename.startsWith("original."));
    if (info) files.push({ filename, file, info });
  }
  signal.throwIfAborted();
  const newId = randomUUID(); const now = new Date().toISOString();
  const duplicate: Job = {
    ...structuredClone(source), id: newId, name: `${source.name.slice(0, 190)} · kopia`, createdAt: now, updatedAt: now,
    revision: 0, status: "paused", command: undefined, error: undefined,
    stage: source.segments.length ? "translating" : "transcribing",
    message: "Projektkopia sparad. Granska inställningarna och återuppta när du vill generera nya exporter.",
    outputs: {}, segmentOutputs: {}, outputManifest: {},
    metrics: { processingMs: 0, stages: {} },
  };
  for (const translations of Object.values(duplicate.translations)) for (const translation of translations) translation.timing = undefined;
  const manifestBytes = Buffer.byteLength(JSON.stringify(duplicate));
  await enforceQuota(files.reduce((sum, file) => sum + file.info.size, manifestBytes));
  signal.throwIfAborted();
  const destination = jobDir(newId); let owned = false;
  try {
    // A job is invisible to listJobs/the worker until job.json is published last.
    await mkdir(destination); owned = true;
    for (const file of files) {
      signal.throwIfAborted();
      const before = await ordinaryFile(file.file, true);
      if (!before || before.size !== file.info.size || before.mtimeMs !== file.info.mtimeMs || before.ino !== file.info.ino) throw new AppError("Källfilen ändrades under kopieringen. Försök igen.", 409);
      const copied = path.join(destination, file.filename);
      await copyFile(file.file, copied, constants.COPYFILE_EXCL);
      signal.throwIfAborted();
      const after = await ordinaryFile(file.file, true); const output = await ordinaryFile(copied, true);
      if (!after || !output || after.size !== file.info.size || after.mtimeMs !== file.info.mtimeMs || after.ino !== file.info.ino || output.size !== file.info.size) throw new AppError("Källfilen ändrades under kopieringen. Försök igen.", 409);
    }
    const latest = await readJob(id);
    if (latest.updatedAt !== source.updatedAt || latest.revision !== source.revision || JSON.stringify(latest) !== JSON.stringify(source)) throw new AppError("Projektet ändrades under kopieringen. Den ofärdiga kopian rensades; försök igen.", 409);
    await enforceQuota(manifestBytes);
    signal.throwIfAborted();
    await atomicJson(path.join(destination, "job.json"), duplicate);
    owned = false;
    return duplicate;
  } finally {
    // Only the freshly created UUID directory belongs to this operation.
    if (owned) await rm(destination, { recursive: true, force: true });
  }
}
