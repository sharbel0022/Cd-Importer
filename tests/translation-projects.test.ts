import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/translation/jobs/[id]/project/route";
import { AppError } from "@/lib/errors";
import { duplicateTranslationProject, renameTranslationProject } from "@/lib/translation/projects";
import { atomicJson, enforceQuota, jobDir, listJobs, readJob } from "@/lib/translation/store";
import { optionsSchema, type Job } from "@/lib/translation/types";

vi.mock("node:fs/promises", async (importOriginal) => { const actual = await importOriginal<typeof import("node:fs/promises")>(); return { ...actual, copyFile: vi.fn(actual.copyFile) }; });
vi.mock("@/lib/translation/store", async (importOriginal) => { const actual = await importOriginal<typeof import("@/lib/translation/store")>(); return { ...actual, enforceQuota: vi.fn(actual.enforceQuota) }; });

describe("persisted translation project actions", () => {
  let root: string; let job: Job;
  beforeEach(async () => {
    vi.clearAllMocks();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); vi.mocked(copyFile).mockImplementation(actualFs.copyFile);
    const actualStore = await vi.importActual<typeof import("@/lib/translation/store")>("@/lib/translation/store"); vi.mocked(enforceQuota).mockImplementation(actualStore.enforceQuota);
    root = await mkdtemp(path.join(os.tmpdir(), "translation-projects-")); vi.stubEnv("STUDIO_DATA_DIR", root);
    const now = "2026-10-15T10:00:00.000Z";
    job = { id: randomUUID(), name: "Arabic original.mp4", extension: "mp4", createdAt: now, updatedAt: now, revision: 3, options: optionsSchema.parse({ targets: ["en"], rights: true, preserveVoice: true, voiceConsent: true }), status: "completed", stage: "completed", message: "Done", media: { duration: 10, sampleRate: 16000, channels: 1, video: true, waveform: [0.2] }, rawSegments: [{ id: "s1", start: 1, end: 4, speaker: "A", text: "raw" }], segments: [{ id: "s1", start: 1, end: 4, speaker: "A", text: "corrected", rawText: "raw", reviewedAt: now, uncertain: true }], sourceEdits: [{ id: "s1", at: now, before: { text: "raw", start: 1, end: 4 }, after: { text: "corrected", start: 1, end: 4 } }], sourceReviewed: true, translations: { en: [{ id: "s1", text: "Five, no, four", editedByUser: true, timing: { generated: 2, window: 3, tempo: 1, deviationMs: 0, review: false } }] }, outputs: { en: ["mp4", "mp3"] }, outputManifest: { en: { mp3: { sha256: "abc", bytes: 20, revision: 3, createdAt: now } } }, segmentOutputs: { en: { s1: { file: "private-clone.wav", text: "Five, no, four" } } }, warnings: [], metrics: { processingMs: 999, stages: { generating: 700 } } };
    await mkdir(jobDir(job.id));
    await Promise.all([atomicJson(path.join(jobDir(job.id), "job.json"), job), writeFile(path.join(jobDir(job.id), "original.mp4"), "original media bytes"), writeFile(path.join(jobDir(job.id), "normalized.wav"), "normalized audio bytes"), writeFile(path.join(jobDir(job.id), "source-preview.mp4"), "compatible source preview"), writeFile(path.join(jobDir(job.id), "private-clone.wav"), "private voice reference"), writeFile(path.join(jobDir(job.id), "en.mp3"), "stale export")]);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  async function post(value: unknown, headers?: Record<string, string>) { return POST(new Request(`http://localhost/api/translation/jobs/${job.id}/project`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) }), { params: Promise.resolve({ id: job.id }) }); }
  it("renames the saved project without invalidating its unchanged media revision and export manifest", async () => {
    const response = await post({ action: "rename", revision: 3, name: "  My reviewed video  " }); expect(response.status).toBe(200);
    const saved = await readJob(job.id); expect(saved.name).toBe("My reviewed video"); expect(saved.originalName).toBe(job.name); expect(saved.revision).toBe(3); expect(saved.outputManifest).toEqual(job.outputManifest); expect(saved.outputs).toEqual(job.outputs);
    expect(saved.updatedAt).not.toBe(job.updatedAt); expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("copies real source bytes and reviewed content but starts paused with no outputs or reusable clone reference", async () => {
    const response = await post({ action: "duplicate", revision: 3 }); expect(response.status).toBe(201); const duplicate = await response.json() as Job;
    expect(duplicate.id).not.toBe(job.id); expect(duplicate.createdAt).not.toBe(job.createdAt);
    expect(duplicate).toMatchObject({ revision: 0, status: "paused", outputs: {}, segmentOutputs: {}, outputManifest: {}, metrics: { processingMs: 0, stages: {} } });
    expect(duplicate.segments).toEqual(job.segments); expect(duplicate.rawSegments).toEqual(job.rawSegments); expect(duplicate.sourceEdits).toEqual(job.sourceEdits);
    expect(duplicate.translations.en[0]).toMatchObject({ text: "Five, no, four", editedByUser: true }); expect(duplicate.translations.en[0].timing).toBeUndefined();
    expect(duplicate.options).toEqual(job.options); expect(duplicate.sourceReviewed).toBe(true);
    expect((await readdir(jobDir(duplicate.id))).sort()).toEqual(["job.json", "normalized.wav", "original.mp4", "source-preview.mp4"]);
    for (const file of ["original.mp4", "normalized.wav", "source-preview.mp4"]) expect(await readFile(path.join(jobDir(duplicate.id), file))).toEqual(await readFile(path.join(jobDir(job.id), file)));
    expect(await readJob(job.id)).toEqual(job); expect((await listJobs()).filter((entry) => entry.status === "queued")).toEqual([]);
    const copiedBytes = Buffer.byteLength("original media bytesnormalized audio bytescompatible source preview");
    expect(vi.mocked(enforceQuota).mock.calls[0][0]).toBeGreaterThan(copiedBytes);
  });
  it("allows optional normalized/source preview files to be absent", async () => {
    await rm(path.join(jobDir(job.id), "normalized.wav")); await rm(path.join(jobDir(job.id), "source-preview.mp4"));
    const duplicate = await duplicateTranslationProject(job.id, 3, new AbortController().signal);
    expect((await readdir(jobDir(duplicate.id))).sort()).toEqual(["job.json", "original.mp4"]);
  });
  it("rejects stale revisions before renaming or copying and preserves the original", async () => {
    expect((await post({ action: "rename", revision: 2, name: "Stale" })).status).toBe(409);
    expect((await post({ action: "duplicate", revision: 2 })).status).toBe(409);
    expect(await readdir(root)).toEqual([job.id]); expect(await readJob(job.id)).toEqual(job); expect(copyFile).not.toHaveBeenCalled();
  });
  it("rejects active jobs instead of copying changing checkpoints", async () => {
    job.status = "running"; await atomicJson(path.join(jobDir(job.id), "job.json"), job);
    expect((await post({ action: "duplicate", revision: 3 })).status).toBe(409); expect(await readdir(root)).toEqual([job.id]);
  });
  it("enforces source-byte storage quota before copying", async () => {
    vi.mocked(enforceQuota).mockRejectedValue(new AppError("Quota reached", 507));
    expect((await post({ action: "duplicate", revision: 3 })).status).toBe(507);
    expect(copyFile).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([job.id]);
  });
  it("removes only its new directory when a source revision changes during the copy", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(copyFile).mockImplementationOnce(async (...args) => { await actual.copyFile(...args); await atomicJson(path.join(jobDir(job.id), "job.json"), { ...job, revision: 4, updatedAt: "2026-10-15T11:00:00.000Z" }); });
    expect((await post({ action: "duplicate", revision: 3 })).status).toBe(409); expect(await readdir(root)).toEqual([job.id]);
    expect((await readJob(job.id)).revision).toBe(4); expect(await readFile(path.join(jobDir(job.id), "original.mp4"), "utf8")).toBe("original media bytes");
  });
  it("detects an updatedAt-only rename during a copy even when content revision is unchanged", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(copyFile).mockImplementationOnce(async (...args) => { await actual.copyFile(...args); await renameTranslationProject(job.id, 3, "Concurrent rename"); });
    expect((await post({ action: "duplicate", revision: 3 })).status).toBe(409); expect(await readdir(root)).toEqual([job.id]); expect((await readJob(job.id)).name).toBe("Concurrent rename");
  });
  it("cleans partial copies on I/O failure or a cancelled request", async () => {
    vi.mocked(copyFile).mockRejectedValueOnce(new Error("Test disk failure"));
    await expect(duplicateTranslationProject(job.id, 3, new AbortController().signal)).rejects.toThrow("Test disk failure"); expect(await readdir(root)).toEqual([job.id]);
    const abort = new AbortController(); const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(copyFile).mockImplementationOnce(async (...args) => { await actual.copyFile(...args); abort.abort(); });
    await expect(duplicateTranslationProject(job.id, 3, abort.signal)).rejects.toThrow(); expect(await readdir(root)).toEqual([job.id]);
  });
  it("rejects missing original media and malformed or cross-origin actions without creating a duplicate", async () => {
    for (const value of [{ action: "rename", revision: 3, name: "../escape" }, { action: "rename", revision: 3, name: "" }, { action: "duplicate", revision: -1 }, { action: "duplicate", revision: 3, path: "C:/private" }]) expect((await post(value)).status).toBe(400);
    expect((await post({ action: "duplicate", revision: 3 }, { Origin: "https://attacker.example" })).status).toBe(403);
    await rm(path.join(jobDir(job.id), "original.mp4")); expect((await post({ action: "duplicate", revision: 3 })).status).toBe(409); expect(await readdir(root)).toEqual([job.id]);
  });
});
