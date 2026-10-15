import { rm } from "node:fs/promises";
import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { boundedJson, guardRequest } from "@/lib/request";
import { jobDir, readJob, updateJob } from "@/lib/translation/store";
import { validateOptions } from "@/lib/translation/providers";
import { pendingSourceSegments } from "@/lib/translation/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const command = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["pause", "resume", "cancel"]) }).strict(),
  z.object({ action: z.literal("approve-source"), ids: z.array(z.string().regex(/^s\d+$/)).min(1).max(6000).optional() }).strict(),
  z.object({ action: z.literal("regenerate"), target: z.string(), ids: z.array(z.string().regex(/^s\d+$/)).min(1).max(6000) }).strict(),
  z.object({ action: z.literal("edit"), edits: z.array(z.object({ id: z.string().regex(/^s\d+$/), target: z.string(), text: z.string().trim().max(4000), start: z.number().nonnegative(), end: z.number().positive(), speaker: z.string().trim().min(1).max(80), original: z.string().trim().min(1).max(4000).optional() }).strict()).min(1).max(6000), speakerVoices: z.record(z.string().max(80), z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).optional() }).strict(),
]);
export async function GET(_request: Request, ctx: Context) { try { return Response.json(await readJob((await ctx.params).id), { headers: { "Cache-Control": "no-store" } }); } catch (e) { return errorResponse(e); } }
export async function PATCH(request: Request, ctx: Context) {
  try {
    guardRequest(request, "studio-control", true); const { id } = await ctx.params;
    const parsed = command.safeParse(await boundedJson(request, 2 * 1024 ** 2)); if (!parsed.success) throw new AppError("Ogiltig jobbändring.");
    const value = parsed.data;
    // Provider validation must run outside the cross-process job lock.
    if (value.action === "edit" && value.speakerVoices) {
      const current = await readJob(id);
      await validateOptions({ ...current.options, speakerVoices: value.speakerVoices });
    }
    return Response.json(await updateJob(id, (j) => {
      if (value.action === "approve-source") {
        const pending = pendingSourceSegments(j);
        const ids = value.ids || pending.map((s) => s.id);
        if (!["paused", "review", "failed"].includes(j.status) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => !pending.some((s) => s.id === id))) throw new AppError("Det finns inget osäkert transkript att godkänna.", 409);
        const at = new Date().toISOString();
        for (const s of pending) if (ids.includes(s.id)) s.reviewedAt = at;
        j.sourceReviewed = pendingSourceSegments(j).length === 0; j.reviewReason = undefined; j.status = "queued"; j.command = undefined; j.error = undefined; j.message = `${ids.length} källsegment godkända. Väntar på översättning och AI-tal.`;
      } else if (value.action === "regenerate") {
        if (!["paused", "review", "failed", "completed"].includes(j.status) || !j.options.targets.includes(value.target) || new Set(value.ids).size !== value.ids.length) throw new AppError("Segmentet kan inte regenereras i detta läge.", 409);
        for (const id of value.ids) {
          const t = j.translations[value.target]?.find((t) => t.id === id);
          if (!t?.text || t.reviewRequired || pendingSourceSegments(j).some((s) => s.id === id)) throw new AppError("Spara och godkänn källsegment och översättning före regenerering.", 409);
          t.generation = (t.generation || 0) + 1; t.timing = undefined;
          if (j.segmentOutputs?.[value.target]) delete j.segmentOutputs[value.target][id];
        }
        j.revision++; j.outputs = {}; j.status = "queued"; j.command = undefined; j.error = undefined; j.message = "Genererar valda segment på nytt och skapar en ny komplett export. Oförändrat tal återanvänds.";
      } else if (value.action === "resume") {
        if (!["paused", "failed", "review"].includes(j.status)) throw new AppError("Jobbet kan inte återupptas i detta läge.", 409);
        if (pendingSourceSegments(j).length) throw new AppError("Granska och godkänn det osäkra transkriptet innan dubbning.", 409);
        j.status = "queued"; j.command = undefined; j.error = undefined; j.message = "Väntar på worker.";
      } else if (value.action === "pause" || value.action === "cancel") {
        if (j.status === "running") { j.command = value.action; j.message = value.action === "pause" ? "Pausar aktivt steg…" : "Avbryter aktivt steg…"; }
        else if (["queued", "paused", "review", "failed"].includes(j.status)) { j.status = value.action === "pause" ? "paused" : "cancelled"; j.command = undefined; j.message = value.action === "pause" ? "Pausat." : "Avbrutet."; }
        else throw new AppError("Jobbet är redan avslutat.", 409);
      } else if (value.action === "edit") {
        if (!["paused", "failed", "review", "completed"].includes(j.status)) throw new AppError("Pausa jobbet innan du redigerar.", 409);
        if (new Set(value.edits.map((e) => `${e.target}:${e.id}`)).size !== value.edits.length) throw new AppError("Samma segment kan inte ändras flera gånger i en begäran.");
        const sourceChanges = new Set<string>();
        const manualTargets = new Map<string, Set<string>>();
        j.rawSegments ??= structuredClone(j.segments.map((s) => ({ ...s, text: s.rawText ?? s.text })));
        for (const edit of value.edits) {
          const s = j.segments.find((s) => s.id === edit.id); const t = j.translations[edit.target]?.find((t) => t.id === edit.id);
          if (!s || !j.options.targets.includes(edit.target) || (t && !edit.text) || (!t && !edit.text && !edit.original) || edit.end <= edit.start || edit.end > (j.media?.duration || 0)) throw new AppError("Segmentet, texten eller tidsfönstret är ogiltigt.");
          const before = { text: s.text, start: s.start, end: s.end };
          const previousSpeaker = s.speaker;
          s.rawText ??= s.text;
          if (edit.text && (!t || edit.text !== t.text)) {
            if (!manualTargets.has(edit.target)) manualTargets.set(edit.target, new Set());
            manualTargets.get(edit.target)!.add(s.id);
          }
          if (s.start !== edit.start || s.end !== edit.end) {
            // Word positions belong to the previous ASR timeline. Keeping them
            // after a manual correction can relocate speech to obsolete times.
            const discontinuous = s.qualityReasons?.includes("discontinuous_word_timestamps") || s.words?.some((w, n, words) => n > 0 && w.start - words[n - 1].end > 2);
            const outside = s.words?.some((w) => w.start < s.start - 0.25 || w.end > s.end + 0.25);
            if (discontinuous || outside) {
              s.uncertain = true;
              s.qualityReasons = [...new Set([...(s.qualityReasons || []), ...(discontinuous ? ["discontinuous_word_timestamps"] : []), ...(outside ? ["word_timestamps_outside_segment"] : [])])];
            }
            s.words = undefined;
            if (s.uncertain) { s.reviewedAt = undefined; j.sourceReviewed = false; }
          }
          s.start = edit.start; s.end = edit.end; s.speaker = edit.speaker;
          if (edit.original && edit.original !== s.text) { s.text = edit.original; s.words = undefined; s.reviewedAt = undefined; sourceChanges.add(s.id); }
          if (before.text !== s.text || before.start !== s.start || before.end !== s.end) (j.sourceEdits ??= []).push({ id: s.id, at: new Date().toISOString(), before, after: { text: s.text, start: s.start, end: s.end } });
          if (t) { if (t.text !== edit.text) { t.editedByUser = true; t.reviewRequired = false; t.reviewMessage = undefined; } t.text = edit.text; t.timing = undefined; }
          else if (edit.text) (j.translations[edit.target] ??= []).push({ id: s.id, text: edit.text, editedByUser: true });
          if (sourceChanges.has(s.id) || before.start !== s.start || before.end !== s.end || previousSpeaker !== edit.speaker) {
            for (const clips of Object.values(j.segmentOutputs || {})) delete clips[s.id];
          } else if (j.segmentOutputs?.[edit.target]) delete j.segmentOutputs[edit.target][s.id];
        }
        if (sourceChanges.size) {
          // Retranslate stale source rows; retain explicitly supplied manual
          // translations and unchanged rows for reuse by the worker.
          for (const target of Object.keys(j.translations)) j.translations[target] = j.translations[target].filter((t) => !sourceChanges.has(t.id) || manualTargets.get(target)?.has(t.id));
          j.sourceReviewed = false;
        }
        if (j.segments.some((s, n) => n > 0 && s.start < j.segments[n - 1].start)) throw new AppError("Segmentens starttider måste ligga i tidsordning.");
        // Every target shares the source timeline: all timing reports are invalidated.
        for (const target of Object.keys(j.translations)) {
          const values = new Map(j.translations[target].map((t) => [t.id, t]));
          j.translations[target] = j.segments.flatMap((s) => { const t = values.get(s.id); if (!t) return []; t.timing = undefined; return [t]; });
        }
        if (value.speakerVoices) { j.options.speakerVoices = value.speakerVoices; j.segmentOutputs = {}; }
        j.revision++; j.outputs = {}; j.status = "paused"; j.stage = sourceChanges.size ? "translating" : "generating"; j.reviewReason = pendingSourceSegments(j).length ? "source" : undefined; j.metrics.reviewSegments = undefined; j.metrics.syncMaxDeviationMs = undefined; j.message = j.reviewReason === "source" ? "Ändringar sparade. Granska och godkänn transkriptet före dubbning." : "Ändringar sparade. Återuppta för att generera uppdaterade exporter.";
      }
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
export async function DELETE(request: Request, ctx: Context) {
  try { guardRequest(request, "studio-delete", true); const { id } = await ctx.params; await updateJob(id, (job) => { if (["running", "queued"].includes(job.status)) throw new AppError("Avbryt jobbet innan du raderar det.", 409); job.status = "cancelled"; job.message = "Raderas."; }); await rm(jobDir(id), { recursive: true, force: true }); return Response.json({ deleted: true }); } catch (e) { return errorResponse(e); }
}
