import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/translation/jobs/[id]/route";
import { atomicJson, jobDir, readJob } from "@/lib/translation/store";
import { optionsSchema, type Job } from "@/lib/translation/types";

describe("translation job source review and corrections", () => {
  let root: string;
  let job: Job;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "translation-routes-"));
    vi.stubEnv("STUDIO_DATA_DIR", root);
    const now = new Date().toISOString();
    job = { id: randomUUID(), name: "arabic.mp4", extension: "mp4", createdAt: now, updatedAt: now, revision: 0, options: optionsSchema.parse({ targets: ["en", "sv"], rights: true }), status: "review", stage: "transcribing", reviewReason: "source", message: "Review", media: { duration: 10, sampleRate: 16000, channels: 1, video: true, waveform: [] }, segments: [{ id: "s1", start: 0, end: 3, speaker: "A", text: "مرحبا", uncertain: true }, { id: "s2", start: 4, end: 8, speaker: "A", text: "شكرا" }], translations: { en: [{ id: "s1", text: "Hello" }, { id: "s2", text: "Thanks" }], sv: [{ id: "s1", text: "Hej" }, { id: "s2", text: "Tack" }] }, outputs: { en: ["mp4"] }, warnings: [], metrics: { processingMs: 0, stages: {} } };
    await mkdir(jobDir(job.id), { recursive: true });
    await atomicJson(path.join(jobDir(job.id), "job.json"), job);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  async function patch(body: unknown) {
    return PATCH(new Request(`http://localhost/api/translation/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: job.id }) });
  }
  it("requires explicit source approval before resuming uncertain speech", async () => {
    expect((await patch({ action: "resume" })).status).toBe(409);
    expect((await patch({ action: "approve-source" })).status).toBe(200);
    expect(await readJob(job.id)).toMatchObject({ sourceReviewed: true, status: "queued" });
    expect((await patch({ action: "approve-source" })).status).toBe(409);
  });
  it("invalidates only corrected source rows across every target and removes stale exports", async () => {
    const response = await patch({ action: "edit", edits: [{ id: "s1", target: "en", original: "مرحبا بكم", text: "Hello", start: 0, end: 3, speaker: "A" }] });
    expect(response.status).toBe(200);
    const next = await readJob(job.id);
    expect(next.segments[0].text).toBe("مرحبا بكم");
    expect(next.translations.en).toEqual([{ id: "s2", text: "Thanks" }]);
    expect(next.translations.sv).toEqual([{ id: "s2", text: "Tack" }]);
    expect(next.outputs).toEqual({});
    expect(next).toMatchObject({ status: "paused", stage: "translating", sourceReviewed: false, reviewReason: "source", revision: 1 });
  });
  it("rejects invalid times atomically without altering the stored transcript", async () => {
    const response = await patch({ action: "edit", edits: [{ id: "s1", target: "en", original: "changed", text: "Hello", start: 4, end: 2, speaker: "A" }] });
    expect(response.status).toBe(400);
    expect((await readJob(job.id)).segments[0].text).toBe("مرحبا");
  });
  it("clears stale word positions and requires fresh approval when correcting an uncertain timeline", async () => {
    job.sourceReviewed = true; job.status = "completed";
    job.segments[0].words = [{ start: 0.2, end: 0.8, word: "مرحبا" }];
    await atomicJson(path.join(jobDir(job.id), "job.json"), job);
    expect((await patch({ action: "edit", edits: [{ id: "s1", target: "en", original: "مرحبا", text: "Hello", start: 1, end: 3, speaker: "A" }] })).status).toBe(200);
    const next = await readJob(job.id);
    expect(next.segments[0]).toMatchObject({ start: 1, end: 3, text: "مرحبا" });
    expect(next.segments[0].words).toBeUndefined();
    expect(next.translations).toEqual(job.translations);
    expect(next).toMatchObject({ sourceReviewed: false, reviewReason: "source", status: "paused" });
    expect((await patch({ action: "resume" })).status).toBe(409);
    expect((await patch({ action: "approve-source" })).status).toBe(200);
  });
  it("clears word positions without retranslating an otherwise confident timing edit", async () => {
    job.sourceReviewed = true; job.status = "completed"; job.segments[0].uncertain = false;
    job.segments[1].words = [{ start: 4.1, end: 4.8, word: "شكرا" }];
    await atomicJson(path.join(jobDir(job.id), "job.json"), job);
    expect((await patch({ action: "edit", edits: [{ id: "s2", target: "en", original: "شكرا", text: "Thanks", start: 4.5, end: 8.5, speaker: "A" }] })).status).toBe(200);
    const next = await readJob(job.id);
    expect(next.segments[1].words).toBeUndefined();
    expect(next.translations).toEqual(job.translations);
    expect(next.sourceReviewed).toBe(true);
    expect(next.reviewReason).toBeUndefined();
  });
  it("requires review for a legacy discontinuous word timeline even if it was not previously flagged", async () => {
    job.sourceReviewed = true; job.status = "completed"; job.segments[0].uncertain = false;
    job.segments[1].words = [{ start: 4.1, end: 4.3, word: "شكرا" }, { start: 7.2, end: 7.8, word: "لك" }];
    await atomicJson(path.join(jobDir(job.id), "job.json"), job);
    expect((await patch({ action: "edit", edits: [{ id: "s2", target: "en", original: "شكرا", text: "Thanks", start: 7.1, end: 8, speaker: "A" }] })).status).toBe(200);
    const next = await readJob(job.id);
    expect(next.segments[1].words).toBeUndefined();
    expect(next.segments[1].uncertain).toBe(true);
    expect(next.segments[1].qualityReasons).toContain("discontinuous_word_timestamps");
    expect(next).toMatchObject({ sourceReviewed: false, reviewReason: "source" });
    expect(next.translations).toEqual(job.translations);
  });
  it("accepts a manually supplied missing target in source order without approving uncertain source", async () => {
    job.translations.en = [{ id: "s2", text: "Thanks" }];
    await atomicJson(path.join(jobDir(job.id), "job.json"), job);
    expect((await patch({ action: "edit", edits: [{ id: "s1", target: "en", text: "Welcome", start: 0, end: 3, speaker: "A" }] })).status).toBe(200);
    const next = await readJob(job.id);
    expect(next.translations.en).toEqual([{ id: "s1", text: "Welcome" }, { id: "s2", text: "Thanks" }]);
    expect(next.sourceReviewed).not.toBe(true);
    expect(next.reviewReason).toBe("source");
    expect((await patch({ action: "resume" })).status).toBe(409);
  });
  it("still permits correcting source while its missing target is left empty", async () => {
    job.translations.en = [];
    await atomicJson(path.join(jobDir(job.id), "job.json"), job);
    expect((await patch({ action: "edit", edits: [{ id: "s1", target: "en", original: "مرحبا بكم", text: "", start: 0, end: 3, speaker: "A" }] })).status).toBe(200);
    const next = await readJob(job.id);
    expect(next.segments[0].text).toBe("مرحبا بكم");
    expect(next.translations.en).toEqual([]);
    expect(next.translations.sv).toEqual([{ id: "s2", text: "Tack" }]);
    expect(next.sourceReviewed).toBe(false);
  });
  it("retains an explicit manual target supplied with corrected source and invalidates other stale targets", async () => {
    job.translations.en = [];
    await atomicJson(path.join(jobDir(job.id), "job.json"), job);
    expect((await patch({ action: "edit", edits: [{ id: "s1", target: "en", original: "مرحبا بكم", text: "Welcome", start: 0, end: 3, speaker: "A" }] })).status).toBe(200);
    const next = await readJob(job.id);
    expect(next.translations.en).toEqual([{ id: "s1", text: "Welcome" }]);
    expect(next.translations.sv).toEqual([{ id: "s2", text: "Tack" }]);
    expect(next).toMatchObject({ sourceReviewed: false, reviewReason: "source" });
  });
});
