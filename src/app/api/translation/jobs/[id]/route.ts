import { rm } from "node:fs/promises";
import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { boundedJson, guardRequest } from "@/lib/request";
import { jobDir, readJob, updateJob } from "@/lib/translation/store";
import { validateOptions } from "@/lib/translation/providers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const command = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["pause", "resume", "cancel"]) }).strict(),
  z.object({ action: z.literal("approve-source") }).strict(),
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
        if (!["paused", "review", "failed"].includes(j.status) || !j.segments.length || j.sourceReviewed || !j.segments.some((s) => s.uncertain)) throw new AppError("Det finns inget osäkert transkript att godkänna.", 409);
        j.sourceReviewed = true; j.reviewReason = undefined; j.status = "queued"; j.command = undefined; j.error = undefined; j.message = "Transkriptet är granskat. Väntar på översättning och AI-tal.";
      } else if (value.action === "resume") {
        if (!["paused", "failed", "review"].includes(j.status)) throw new AppError("Jobbet kan inte återupptas i detta läge.", 409);
        if (!j.sourceReviewed && j.segments.some((s) => s.uncertain)) throw new AppError("Granska och godkänn det osäkra transkriptet innan dubbning.", 409);
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
        for (const edit of value.edits) {
          const s = j.segments.find((s) => s.id === edit.id); const t = j.translations[edit.target]?.find((t) => t.id === edit.id);
          if (!s || !j.options.targets.includes(edit.target) || (t && !edit.text) || (!t && !edit.text && !edit.original) || edit.end <= edit.start || edit.end > (j.media?.duration || 0)) throw new AppError("Segmentet, texten eller tidsfönstret är ogiltigt.");
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
            if (s.uncertain) j.sourceReviewed = false;
          }
          s.start = edit.start; s.end = edit.end; s.speaker = edit.speaker;
          if (edit.original && edit.original !== s.text) { s.text = edit.original; s.words = undefined; sourceChanges.add(s.id); }
          if (t) { t.text = edit.text; t.timing = undefined; }
          else if (edit.text) (j.translations[edit.target] ??= []).push({ id: s.id, text: edit.text });
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
        if (value.speakerVoices) j.options.speakerVoices = value.speakerVoices;
        j.revision++; j.outputs = {}; j.status = "paused"; j.stage = sourceChanges.size ? "translating" : "generating"; j.reviewReason = !j.sourceReviewed && j.segments.some((s) => s.uncertain) ? "source" : undefined; j.metrics.reviewSegments = undefined; j.metrics.syncMaxDeviationMs = undefined; j.message = j.reviewReason === "source" ? "Ändringar sparade. Granska och godkänn transkriptet före dubbning." : "Ändringar sparade. Återuppta för att generera uppdaterade exporter.";
      }
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
export async function DELETE(request: Request, ctx: Context) {
  try { guardRequest(request, "studio-delete", true); const { id } = await ctx.params; await updateJob(id, (job) => { if (["running", "queued"].includes(job.status)) throw new AppError("Avbryt jobbet innan du raderar det.", 409); job.status = "cancelled"; job.message = "Raderas."; }); await rm(jobDir(id), { recursive: true, force: true }); return Response.json({ deleted: true }); } catch (e) { return errorResponse(e); }
}
