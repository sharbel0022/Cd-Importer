import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acousticDisagreement, reprocessAsr } from "@/lib/translation/asr-reprocess";
import { ffmpeg } from "@/lib/translation/media";
import { capabilities, providerFetch } from "@/lib/translation/providers";
import { jobDir, readJob, updateJob } from "@/lib/translation/store";
import { optionsSchema, type Capabilities, type Job } from "@/lib/translation/types";
import { POST } from "@/app/api/translation/jobs/[id]/asr/route";

vi.mock("@/lib/translation/providers", async (original) => ({ ...await original<typeof import("@/lib/translation/providers")>(), capabilities: vi.fn(), providerFetch: vi.fn() }));
let root: string; let job: Job;
const signal = () => new AbortController().signal;
const comparison = (text = "He said five", uncertain = false) => Response.json({ model: "configured", settings: { device: "cpu", compute_type: "int8", condition_on_previous_text: false, temperature: [0, .2, .4, .6, .8, 1] }, segments: [{ start: 0, end: 1, text, raw_text: text, uncertain, words: [{ start: 0, end: 1, word: text, probability: .9 }] }] });
const request = () => ({ revision: job.revision, segmentIds: ["s1"], models: ["configured"], denoise: false });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cd-asr-reprocess-"));
  vi.stubEnv("STUDIO_DATA_DIR", root); vi.stubEnv("STUDIO_ASR_PROVIDER", "local"); vi.stubEnv("STUDIO_LOCAL_URL", "http://127.0.0.1:8765"); vi.stubEnv("STUDIO_LOCAL_TOKEN", "asr-private-token");
  const now = new Date().toISOString();
  job = { id: randomUUID(), name: "source.wav", extension: "wav", createdAt: now, updatedAt: now, revision: 2, options: optionsSchema.parse({ targets: ["en"], rights: true }), status: "completed", stage: "completed", message: "Ready", media: { duration: 4, channels: 1, sampleRate: 16000, video: false, waveform: [] },
    sourceReviewed: true, segments: [{ id: "s1", start: 1, end: 3, text: "He said five", rawText: "He said five", speaker: "unknown", reviewedAt: now }], rawSegments: [{ id: "s1", start: 1, end: 3, text: "He said five", speaker: "unknown" }], translations: { en: [{ id: "s1", text: "He said five" }] }, outputs: { en: ["wav"] }, outputManifest: { en: { wav: { sha256: "previous", revision: 2, bytes: 12, createdAt: now } } }, warnings: [], metrics: { processingMs: 0, stages: {} } };
  await mkdir(jobDir(job.id)); await writeFile(path.join(jobDir(job.id), "job.json"), JSON.stringify(job));
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=4", "-c:a", "pcm_s16le", path.join(jobDir(job.id), "normalized.wav")], signal());
  vi.mocked(capabilities).mockResolvedValue({ asrModels: [{ id: "configured", label: "Installed acoustic model", selected: true }, { id: "medium", label: "Medium", selected: false }] } as Capabilities);
  vi.mocked(providerFetch).mockImplementation(async () => comparison());
});
afterEach(async () => { vi.unstubAllEnvs(); vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("targeted ASR with actual FFmpeg clips and explicit fixture decoder replies", () => {
  it("keeps an agreeing comparison separate from approved raw/effective source and exports", async () => {
    const result = await reprocessAsr(job.id, request(), signal());
    expect(result.segments[0].text).toBe(job.segments[0].text); expect(result.rawSegments).toEqual(job.rawSegments);
    expect(result.revision).toBe(2); expect(result.status).toBe("completed"); expect(result.outputs).toEqual(job.outputs); expect(result.outputManifest).toEqual(job.outputManifest);
    expect(result.segments[0].asrAlternatives?.[0]).toMatchObject({ model: "configured", text: "He said five", disagreement: 0, start: 1, end: 3, denoised: false, words: [{ start: 1, end: 2 }] });
    expect(result.segments[0].asrAlternatives?.[0].settings).toMatchObject({ noise_filter: "none", condition_on_previous_text: false });
    expect((await readdir(jobDir(job.id))).some((name) => name.startsWith(".asr-"))).toBe(false);
  });
  it("records explicit denoising provenance and reopens disagreement without replacing words", async () => {
    const original = await readFile(path.join(jobDir(job.id), "normalized.wav"));
    vi.mocked(providerFetch).mockImplementation(async (_url, init) => {
      expect(init.headers).toEqual({ Authorization: "Bearer asr-private-token" });
      expect((init.body as FormData).get("model")).toBe("configured"); expect((init.body as FormData).get("file")).toBeInstanceOf(Blob);
      return comparison("Six entirely different words", true);
    });
    const result = await reprocessAsr(job.id, { ...request(), denoise: true }, signal());
    expect(result.status).toBe("review"); expect(result.revision).toBe(3); expect(result.outputs).toEqual({}); expect(result.outputManifest).toBeUndefined();
    expect(result.segments[0].reviewedAt).toBeUndefined(); expect(result.sourceReviewed).toBe(false);
    expect(result.segments[0].text).toBe("He said five"); expect(result.rawSegments).toEqual(job.rawSegments); expect(result.translations).toEqual(job.translations);
    const alternative = result.segments[0].asrAlternatives![0]; expect(alternative.denoised).toBe(true); expect(alternative.settings?.noise_filter).toBe("afftdn=nf=-25");
    expect(alternative.settings?.clip_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(createHash("sha256").update(await readFile(path.join(jobDir(job.id), "normalized.wav"))).digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
  });
  it("rejects unsupported models and unsafe or oversized selections before inference", async () => {
    for (const input of [{ ...request(), models: ["../../model"] }, { ...request(), models: ["not-installed"] }, { ...request(), segmentIds: ["s1", "s1"] }, { ...request(), segmentIds: ["s1", "s2", "s3", "s4"] }, { ...request(), revision: 1 }]) await expect(reprocessAsr(job.id, input, signal())).rejects.toThrow();
    await updateJob(job.id, (current) => { current.media!.duration = 100; current.segments[0].end = 80; });
    await expect(reprocessAsr(job.id, request(), signal())).rejects.toThrow(/60/);
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("blocks unreviewed acoustic models in commercial mode before inference", async () => {
    vi.stubEnv("STUDIO_COMMERCIAL_MODE", "true"); vi.stubEnv("STUDIO_LICENSE_APPROVALS_JSON", "{}");
    await expect(reprocessAsr(job.id, request(), signal())).rejects.toThrow(/licens/);
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("does not hold the job lock during inference and refuses concurrent source edits", async () => {
    vi.mocked(providerFetch).mockImplementation(async () => { await updateJob(job.id, (current) => { current.revision++; current.segments[0].text = "User correction"; }); return comparison(); });
    await expect(reprocessAsr(job.id, request(), signal())).rejects.toThrow(/ändrades/);
    const saved = await readJob(job.id); expect(saved.segments[0].text).toBe("User correction"); expect(saved.segments[0].asrAlternatives).toBeUndefined();
    expect((await readdir(jobDir(job.id))).some((name) => name.startsWith(".asr-"))).toBe(false);
  });
  it("rejects queued/running jobs and out-of-window decoder timestamps", async () => {
    await updateJob(job.id, (current) => { current.status = "running"; });
    await expect(reprocessAsr(job.id, request(), signal())).rejects.toThrow(/pausa/);
    await updateJob(job.id, (current) => { current.status = "review"; });
    vi.mocked(providerFetch).mockResolvedValue(Response.json({ model: "configured", settings: {}, segments: [{ start: 0, end: 20, text: "outside clip" }] }));
    await expect(reprocessAsr(job.id, request(), signal())).rejects.toThrow(/utanför/);
    expect((await readJob(job.id)).segments[0].asrAlternatives).toBeUndefined();
  });
  it("enforces same-origin API access and returns the saved job", async () => {
    const context = { params: Promise.resolve({ id: job.id }) };
    const denied = await POST(new Request(`http://localhost/api/translation/jobs/${job.id}/asr`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" }, body: JSON.stringify(request()) }), context);
    expect(denied.status).toBe(403); expect(providerFetch).not.toHaveBeenCalled();
    const result = await POST(new Request(`http://localhost/api/translation/jobs/${job.id}/asr`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request()) }), context);
    expect(result.status).toBe(200); expect((await result.json()).segments[0].asrAlternatives).toHaveLength(1);
  });
});
it("measures lexical disagreement without claiming calibrated ASR accuracy", () => {
  expect(acousticDisagreement("أربعة", "اربعة")).toBe(0);
  expect(acousticDisagreement("five", "four")).toBe(1);
  expect(acousticDisagreement("", "")).toBe(0);
});
