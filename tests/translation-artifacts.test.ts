import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { digestFile, writeTextArtifacts } from "@/lib/translation/artifacts";
import { cachedSpeech } from "@/lib/translation/media";
import { wavBlob } from "@/lib/translation/client";
import { jobDir } from "@/lib/translation/store";
import { optionsSchema, type Job } from "@/lib/translation/types";

let root: string; let job: Job;
const provenance = { sourceSha256: "a".repeat(64), normalizedSha256: "b".repeat(64), providers: { asr: "test-asr", translation: "test-translation", tts: "test-tts" } };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cd-artifacts-")); vi.stubEnv("STUDIO_DATA_DIR", root);
  const now = new Date().toISOString();
  job = { id: randomUUID(), name: "source.wav", extension: "wav", createdAt: now, updatedAt: now, revision: 3, options: optionsSchema.parse({ targets: ["en", "sv"], rights: true }), status: "running", stage: "generating", message: "Generating", segments: [{ id: "s1", start: 0, end: 1, speaker: "A", text: "مرحبا" }], translations: { en: [{ id: "s1", text: "Hello" }], sv: [{ id: "s1", text: "Hej", reviewRequired: true }] }, outputs: {}, warnings: [], metrics: { processingMs: 0, stages: {} } };
  await mkdir(jobDir(job.id), { recursive: true });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("publishes only complete reviewed targets, with hashes of their actual text bytes", async () => {
  const manifest = await writeTextArtifacts(job, provenance);
  expect(Object.keys(manifest)).toEqual(["en"]);
  for (const format of ["srt", "vtt", "txt", "json"]) expect(manifest.en[format]).toMatchObject({ ...await digestFile(path.join(jobDir(job.id), `en.${format}`)), revision: 3 });
  expect(JSON.parse(await readFile(path.join(jobDir(job.id), "en.json"), "utf8")).provenance).toMatchObject({ ...provenance, revision: 3 });
  expect((await readdir(jobDir(job.id))).some((file) => file.startsWith("sv."))).toBe(false);
});
it("blocks complete text exports while any source evidence is awaiting approval", async () => {
  job.segments[0].uncertain = true;
  expect(await writeTextArtifacts(job, provenance)).toEqual({});
  expect(await readdir(jobDir(job.id))).toEqual([]);
});
it("writes bilingual speaker cues without changing the source or translation evidence", async () => {
  job.options = optionsSchema.parse({ ...job.options, subtitles: { bilingual: true, speakerLabels: true, burnIn: true } });
  await writeTextArtifacts(job, provenance);
  expect(await readFile(path.join(jobDir(job.id), "en.srt"), "utf8")).toContain("A: مرحبا\nHello");
  expect(await readFile(path.join(jobDir(job.id), "en.vtt"), "utf8")).toContain("A: مرحبا\nHello");
  expect(job.segments[0].text).toBe("مرحبا"); expect(job.translations.en[0].text).toBe("Hello");
  const subtitleSha256 = (await digestFile(path.join(jobDir(job.id), "en.srt"))).sha256;
  await writeFile(path.join(jobDir(job.id), "en.caption-render.json"), JSON.stringify({ version: 1, requestedFont: "Arial", actualFont: "Tahoma", subtitleSha256 }));
  await writeTextArtifacts(job, provenance);
  expect(JSON.parse(await readFile(path.join(jobDir(job.id), "en.json"), "utf8")).provenance.captionRender).toMatchObject({ actualFont: "Tahoma", subtitleSha256 });
  job.translations.en[0].text = "A changed reviewed translation"; await writeTextArtifacts(job, provenance);
  expect(JSON.parse(await readFile(path.join(jobDir(job.id), "en.json"), "utf8")).provenance.captionRender).toBeUndefined();
});
it("recovers a damaged speech cache in the same run and installs only validated audio", async () => {
  const file = path.join(root, "speech.wav"); const signal = new AbortController().signal;
  const create = vi.fn(async () => Buffer.from(await wavBlob(Int16Array.from({ length: 12800 }, (_, i) => Math.sin(i * 2 * Math.PI * 880 / 16000) * 10000)).arrayBuffer()));
  const first = await cachedSpeech(file, create, signal); expect(first.duration).toBeGreaterThan(0.5);
  await writeFile(first.file, "interrupted WAV checkpoint");
  await cachedSpeech(file, create, signal); expect(create).toHaveBeenCalledOnce(); // Rebuild the derived clip from valid raw audio.
  await writeFile(first.file, "damaged derived clip"); await writeFile(file, "damaged raw model reply");
  const recovered = await cachedSpeech(file, create, signal);
  expect(create).toHaveBeenCalledTimes(2); expect(recovered.duration).toBeGreaterThan(0.5);
  await cachedSpeech(file, create, signal); expect(create).toHaveBeenCalledTimes(2);
  expect((await readdir(root)).filter((name) => name.includes(".tmp."))).toEqual([]);
  const invalid = path.join(root, "invalid.wav");
  await expect(cachedSpeech(invalid, async () => Buffer.from("invalid model audio"), signal)).rejects.toThrow();
  expect(await stat(invalid).catch(() => undefined)).toBeUndefined();
  expect(await stat(`${invalid}.trim.wav`).catch(() => undefined)).toBeUndefined();
}, 30000);
