import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicJson, atomicWrite, jobDir } from "./store";
import { pendingSourceSegments, subtitles, type Job } from "./types";

export const TEXT_FORMATS = ["srt", "vtt", "txt", "json"] as const;
export interface FileDigest { sha256: string; bytes: number }
export interface ExportProvenance {
  sourceSha256: string;
  normalizedSha256: string;
  providers: { asr: string; translation: string; tts: string };
}
export interface CaptionRenderMetadata {
  version: 1; generatedAt: string; requestedFont: string; actualFont: string; fallbackReason?: string;
  subtitleSha256: string; frameWidth: number; frameHeight: number; marginPixels: number; marginPercent: number;
  requestedFontSize: number; renderedFontSize: number;
}
async function captionRenderProvenance(job: Job, target: string) {
  if (!job.options.subtitles?.burnIn) return;
  try {
    const metadata = JSON.parse(await readFile(path.join(jobDir(job.id), `${target}.caption-render.json`), "utf8")) as CaptionRenderMetadata;
    if (metadata.version === 1 && typeof metadata.requestedFont === "string" && typeof metadata.actualFont === "string" && metadata.subtitleSha256 === (await digestFile(path.join(jobDir(job.id), `${target}.srt`))).sha256) return metadata;
  } catch { /* Optional render provenance must match this exact subtitle file. */ }
}
export function artifactFilename(target: string, format: string) { return `${target}.${format === "mp4-captioned" ? "mp4-captioned.mp4" : format}`; }
export function retainTextArtifacts(job: Job) {
  const outputs: Job["outputs"] = {}; const outputManifest: NonNullable<Job["outputManifest"]> = {};
  if (!job.segments.length || pendingSourceSegments(job).length) return { outputs, outputManifest };
  for (const target of job.options.targets) {
    if (job.segments.some((segment) => !job.translations[target]?.some((translation) => translation.id === segment.id && translation.text.trim() && !translation.reviewRequired))) continue;
    const formats = TEXT_FORMATS.filter((format) => job.outputs[target]?.includes(format) && job.outputManifest?.[target]?.[format]?.revision === job.revision);
    if (formats.length) {
      outputs[target] = formats;
      outputManifest[target] = Object.fromEntries(formats.map((format) => [format, job.outputManifest![target][format]]));
    }
  }
  return { outputs, outputManifest };
}
export async function digestFile(file: string, signal?: AbortSignal): Promise<FileDigest> {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const block of createReadStream(file, { signal })) { const data = block as Buffer; hash.update(data); bytes += data.length; }
  return { sha256: hash.digest("hex"), bytes };
}
export async function describeArtifacts(job: Job, target: string, formats: readonly string[]) {
  const entries: NonNullable<Job["outputManifest"]>[string] = {};
  const createdAt = new Date().toISOString();
  for (const format of formats) entries[format] = { ...await digestFile(path.join(jobDir(job.id), artifactFilename(target, format))), revision: job.revision, createdAt };
  return entries;
}
// Source approval and complete reviewed translations are independent of TTS.
// No partial transcript is advertised as a complete translated subtitle file.
export async function writeTextArtifacts(job: Job, provenance: ExportProvenance) {
  const manifest: NonNullable<Job["outputManifest"]> = {};
  if (!job.segments.length || pendingSourceSegments(job).length) return manifest;
  const dir = jobDir(job.id);
  for (const target of job.options.targets) {
    const translations = job.translations[target];
    if (!translations || job.segments.some((s) => !translations.some((t) => t.id === s.id && t.text.trim() && !t.reviewRequired))) continue;
    const lookup = new Map(translations.map((t) => [t.id, t]));
    const captions = job.segments.map((segment) => ({ id: segment.id, text: `${job.options.subtitles?.speakerLabels ? `${segment.speaker}: ` : ""}${job.options.subtitles?.bilingual ? `${segment.text}\n` : ""}${lookup.get(segment.id)!.text}` }));
    await atomicWrite(path.join(dir, `${target}.srt`), subtitles(job.segments, captions, "srt"));
    await atomicWrite(path.join(dir, `${target}.vtt`), subtitles(job.segments, captions, "vtt"));
    await atomicWrite(path.join(dir, `${target}.txt`), job.segments.map((s) => `[${s.start.toFixed(3)}–${s.end.toFixed(3)}] ${s.speaker}\nOriginal: ${s.text}\n${lookup.get(s.id)!.text}`).join("\n\n"));
    await atomicJson(path.join(dir, `${target}.json`), {
      sourceLanguage: job.detectedLanguage, targetLanguage: target, translationMode: job.options.translationMode || "faithful", aiGenerated: true,
      provenance: { ...provenance, revision: job.revision, generatedAt: new Date().toISOString(), captionRender: await captionRenderProvenance(job, target) },
      subtitleOptions: job.options.subtitles, mixOptions: job.options.mix,
      rawSegments: job.rawSegments, sourceEdits: job.sourceEdits || [],
      segments: job.segments.map((s) => ({ ...s, translation: lookup.get(s.id) })), metrics: job.metrics, warnings: job.warnings,
    });
    manifest[target] = await describeArtifacts(job, target, TEXT_FORMATS);
  }
  return manifest;
}
