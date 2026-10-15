// Annotate an existing acoustic transcript using independent decoder evidence.
// Never select replacement words or approve a segment on the user's behalf.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { jobDir, updateJob } from "../src/lib/translation/store";

const [id, reportPath] = process.argv.slice(2);
if (!id || !reportPath) throw new Error("Usage: STUDIO_DATA_DIR=... node --import tsx scripts/review-asr-comparison.ts <job-id> <comparison-report.json>");
type Acoustic = { model: string; sha256: string; segments: { start: number; end: number; text: string; words?: { start: number; end: number; word: string }[] }[] };
const report = JSON.parse(await readFile(reportPath, "utf8")) as { results: Acoustic[] };
if (report.results.length < 2 || new Set(report.results.map((r) => r.model)).size < 2) throw new Error("At least two distinct acoustic decoders are required.");
const sourceHash = createHash("sha256").update(await readFile(path.join(jobDir(id), "normalized.wav"))).digest("hex");
if (report.results.some((r) => r.sha256 !== sourceHash)) throw new Error("The acoustic comparisons must use this job's exact normalized source file.");
function tokens(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\p{M}/gu, "").replace(/[أإآ]/gu, "ا").replace(/ة/gu, "ه").replace(/[٠-٩]/gu, (v) => String(v.charCodeAt(0) - 0x660)).match(/[\p{L}\p{N}]+/gu) || [];
}
function disagreement(a: string[], b: string[]) {
  let row = b.map((_, i) => i + 1); row.unshift(0);
  for (let i = 0; i < a.length; i++) { const next = [i + 1]; for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1))); row = next; }
  return row[b.length] / Math.max(1, a.length, b.length);
}
const result = await updateJob(id, (job) => {
  if (["queued", "running"].includes(job.status)) throw new Error("Pause the job before annotating acoustic comparisons.");
  for (const segment of job.segments) {
    const alternatives = report.results.map((r) => {
      const words = r.segments.flatMap((s) => s.words || []);
      const text = words.length ? words.filter((w) => (w.start + w.end) / 2 >= segment.start && (w.start + w.end) / 2 <= segment.end).map((w) => w.word.trim()).join(" ") : r.segments.filter((s) => s.start < segment.end && s.end > segment.start).map((s) => s.text).join(" ");
      return { model: r.model, text, disagreement: disagreement(tokens(segment.text), tokens(text)) };
    });
    segment.asrAlternatives = alternatives;
    if (alternatives.some((a) => a.disagreement > 0.35)) {
      segment.uncertain = true; segment.reviewedAt = undefined;
      segment.qualityReasons = [...new Set([...(segment.qualityReasons || []), "asr_model_disagreement"])];
      for (const [target, translations] of Object.entries(job.translations)) job.translations[target] = translations.filter((t) => t.id !== segment.id);
      for (const clips of Object.values(job.segmentOutputs || {})) delete clips[segment.id];
    }
  }
  job.revision++; job.sourceReviewed = false; job.outputs = {}; job.status = "review"; job.reviewReason = "source";
  job.message = "Oberoende ASR-avkodningar skiljer sig. Lyssna på de markerade segmenten; inga ord har ersatts eller godkänts automatiskt.";
});
console.log(JSON.stringify({ id, status: result.status, pending: result.segments.filter((s) => s.uncertain && !s.reviewedAt).map((s) => ({ id: s.id, start: s.start, end: s.end, reasons: s.qualityReasons })) }, null, 2));
