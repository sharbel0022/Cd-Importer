import { createHash, randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AppError } from "../errors";
import { ffmpeg, inputArgs } from "./media";
import { assertCommercialLicense } from "./license-policy";
import { capabilities, providerFetch, transcriptionSchema } from "./providers";
import { jobDir, readJob, updateJob } from "./store";
import type { Job, Segment } from "./types";

export const asrReprocessSchema = z.object({
  revision: z.number().int().nonnegative(),
  segmentIds: z.array(z.string().regex(/^s\d+$/)).min(1).max(3),
  models: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).min(1).max(2),
  denoise: z.boolean().default(false),
}).strict().refine((value) => new Set(value.segmentIds).size === value.segmentIds.length && new Set(value.models).size === value.models.length);
export type AsrReprocessRequest = z.infer<typeof asrReprocessSchema>;
const editable = new Set(["paused", "failed", "review", "completed"]);
const settingsSchema = z.record(z.string().max(80), z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.number()).max(20)]));
const resultSchema = transcriptionSchema.extend({ model: z.string(), settings: settingsSchema });

function tokenList(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/\p{M}/gu, "").replace(/[أإآ]/gu, "ا").replace(/[٠-٩]/gu, (v) => String(v.charCodeAt(0) - 0x660)).match(/[\p{L}\p{N}]+/gu) || [];
}
export function acousticDisagreement(reference: string, alternative: string) {
  const a = tokenList(reference), b = tokenList(alternative);
  let row = Array.from({ length: b.length + 1 }, (_, n) => n);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])));
    row = next;
  }
  return row[b.length] / Math.max(1, a.length, b.length);
}

function gateway() {
  const url = new URL(process.env.STUDIO_LOCAL_URL || "http://127.0.0.1:8765");
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new AppError("Lokal AI-gateway kräver loopback eller HTTPS.", 503);
  return url.href.replace(/\/$/, "");
}
async function boundedResult(response: Response) {
  if (!response.body) throw new AppError("ASR returnerade ett tomt svar.", 502);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 4 * 1024 ** 2) { await reader.cancel(); throw new AppError("ASR-svaret är för stort.", 502); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { throw new AppError("ASR returnerade ogiltig JSON.", 502); }
}

/** Re-decode source clips without replacing or approving the saved transcript. */
export async function reprocessAsr(id: string, input: AsrReprocessRequest, signal: AbortSignal): Promise<Job> {
  const parsed = asrReprocessSchema.safeParse(input);
  if (!parsed.success) throw new AppError("Välj högst tre segment och två installerade ASR-modeller.");
  const value = parsed.data;
  const snapshot = await readJob(id);
  if (snapshot.revision !== value.revision || !editable.has(snapshot.status)) throw new AppError("Jobbet har ändrats eller körs. Uppdatera och pausa före ny ASR.", 409);
  if (process.env.STUDIO_ASR_PROVIDER !== "local") throw new AppError("Segmentjämförelse kräver en konfigurerad lokal ASR-provider.", 422);
  const selected = value.segmentIds.map((segmentId) => snapshot.segments.find((segment) => segment.id === segmentId));
  if (selected.some((segment) => !segment || !Number.isFinite(segment.start + segment.end) || segment.start < 0 || segment.end <= segment.start || segment.end - segment.start > 60 || segment.end > (snapshot.media?.duration || 0) + 0.05)) throw new AppError("Välj befintliga källsegment på högst 60 sekunder.", 422);
  const caps = await capabilities();
  if (value.models.some((model) => !caps.asrModels?.some((available) => available.id === model))) throw new AppError("Den valda ASR-modellen är inte installerad och tillåten.", 422);
  for (const model of value.models) assertCommercialLicense(`asr:${model}`, model);
  const requestId = randomUUID(); const createdAt = new Date().toISOString();
  const directory = await mkdtemp(path.join(jobDir(id), ".asr-"));
  type Alternative = NonNullable<Segment["asrAlternatives"]>[number];
  const comparisons = new Map<string, { alternatives: Alternative[]; uncertain: boolean }>();
  try {
    for (const segment of selected as Segment[]) {
      signal.throwIfAborted();
      const clip = path.join(directory, `${segment.id}.wav`);
      await ffmpeg(["-ss", String(segment.start), ...inputArgs(path.join(jobDir(id), "normalized.wav")), "-t", String(segment.end - segment.start),
        ...(value.denoise ? ["-af", "afftdn=nf=-25"] : []), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-map_metadata", "-1", clip], signal, 60_000);
      const sha256 = createHash("sha256").update(await readFile(clip)).digest("hex");
      const alternatives: Alternative[] = []; let uncertain = false;
      for (const model of value.models) {
        const form = new FormData(); form.append("file", await openAsBlob(clip), "audio.wav"); form.append("model", model);
        if (snapshot.options.source !== "auto") form.append("language", snapshot.options.source);
        const headers = process.env.STUDIO_LOCAL_TOKEN ? { Authorization: `Bearer ${process.env.STUDIO_LOCAL_TOKEN}` } : undefined;
        const response = await providerFetch(`${gateway()}/transcribe`, { method: "POST", headers, body: form }, signal, 600_000, 0);
        const result = resultSchema.safeParse(await boundedResult(response));
        if (!result.success || result.data.model !== model) throw new AppError("ASR returnerade ogiltig modell, inställningar eller tidsstämplar.", 502);
        const data = result.data; const duration = segment.end - segment.start;
        if (data.segments.length > 1000 || data.segments.some((item) => item.end < item.start || item.end > duration + 0.5 || item.words?.some((word) => word.end < word.start || word.end > duration + 0.5))) throw new AppError("ASR-tiderna ligger utanför det valda källsegmentet.", 502);
        const text = data.segments.map((item) => item.raw_text ?? item.text).join(" ").trim();
        if (text.length > 4000) throw new AppError("ASR-texten överskred segmentgränsen.", 502);
        const disagreement = acousticDisagreement(segment.text, text);
        uncertain ||= !text || disagreement > 0.35 || data.segments.some((item) => item.uncertain || (item.quality_reasons?.length || 0) > 0);
        alternatives.push({ model, text, disagreement, requestId, createdAt, start: segment.start, end: segment.end, denoised: value.denoise,
          settings: { ...data.settings, clip_sha256: sha256, noise_filter: value.denoise ? "afftdn=nf=-25" : "none" },
          words: data.segments.flatMap((item) => item.words || []).map((word) => ({ ...word, start: segment.start + word.start, end: segment.start + word.end })) });
      }
      comparisons.set(segment.id, { alternatives, uncertain });
    }
    return await updateJob(id, (job) => {
      // All network/model work above happens outside the short disk lock.
      // updatedAt additionally catches pause/resume/approval changes which do
      // not necessarily change the media output revision.
      if (job.revision !== value.revision || job.updatedAt !== snapshot.updatedAt || job.status !== snapshot.status || !editable.has(job.status)) throw new AppError("Jobbet ändrades under ASR-jämförelsen. Inga resultat skrevs över. Försök igen.", 409);
      let requiresReview = false;
      for (const segment of job.segments) {
        const comparison = comparisons.get(segment.id); if (!comparison) continue;
        segment.asrAlternatives = [...(segment.asrAlternatives || []), ...comparison.alternatives].slice(-12);
        if (comparison.uncertain) {
          requiresReview = true; segment.uncertain = true; segment.reviewedAt = undefined;
          segment.qualityReasons = [...new Set([...(segment.qualityReasons || []), "asr_reprocess_requires_listening"])];
        }
      }
      if (requiresReview) {
        job.revision++; job.sourceReviewed = false; job.outputs = {}; job.outputManifest = undefined;
        job.status = "review"; job.reviewReason = "source"; job.error = undefined;
        job.message = "ASR-alternativen kräver lyssning. Källtexten är bevarad; välj, spara och godkänn dina rättningar uttryckligen.";
      }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
