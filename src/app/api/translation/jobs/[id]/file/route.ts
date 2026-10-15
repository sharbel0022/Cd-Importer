import path from "node:path";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { AppError, errorResponse } from "@/lib/errors";
import { jobDir, readJob } from "@/lib/translation/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const types: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", mp4: "video/mp4", "mp4-captioned": "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", srt: "application/x-subrip", vtt: "text/vtt", txt: "text/plain", json: "application/json" };
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params; const job = await readJob(id); const query = new URL(request.url).searchParams;
    const original = query.get("original") === "true"; const target = query.get("target") || "";
    const preview = original && query.get("preview") === "true" && !!job.media;
    const previewFile = job.media?.video ? "source-preview.mp4" : "normalized.wav";
    const previewReady = preview && await stat(path.join(jobDir(id), previewFile)).then((s) => s.size > 0).catch(() => false);
    const format = previewReady ? job.media?.video ? "mp4" : "wav" : original ? job.extension : query.get("format") || "";
    const segment = query.get("segment");
    const clip = segment ? job.segmentOutputs?.[target]?.[segment] : undefined;
    if (!original && query.has("revision") && query.get("revision") !== String(job.revision)) throw new AppError("Exporten har ersatts av en ny version. Ladda om jobbet.", 409);
    if (segment) {
      const source = job.segments.find((s) => s.id === segment); const translation = job.translations[target]?.find((t) => t.id === segment);
      if (original || format !== "wav" || !job.options.targets.includes(target) || !source || !clip || !/^speech-[0-9a-f]{32}\.wav\.trim\.wav$/.test(clip.file) || clip.text !== translation?.text || translation.reviewRequired || source.uncertain && !source.reviewedAt && !job.sourceReviewed) throw new AppError("Segmentets ljud är inte aktuellt eller färdigt.", 404);
    } else if (!original && (!job.options.targets.includes(target) || !job.outputs[target]?.includes(format))) throw new AppError("Exporten är inte färdig eller finns inte.", 404);
    const filename = previewReady ? previewFile : original ? `original.${job.extension}` : clip?.file || `${target}.${format === "mp4-captioned" ? "mp4-captioned.mp4" : format}`; const file = path.join(jobDir(id), filename); const info = await stat(file);
    if (!info.size) throw new AppError("Mediafilen är tom.", 422);
    const headers: Record<string, string> = { "Content-Type": `${types[format] || "application/octet-stream"}${["txt", "json", "srt", "vtt"].includes(format) ? "; charset=utf-8" : ""}`, "Content-Length": String(info.size), "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Content-Disposition": `${query.get("download") === "true" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(previewReady ? `${path.basename(job.name, path.extname(job.name))}-source-preview.${format}` : original ? job.originalName || job.name : `${path.basename(job.name, path.extname(job.name))}-${target}.${format === "mp4-captioned" ? "captioned.mp4" : format}`)}` };
    const manifest = !original && !segment ? job.outputManifest?.[target]?.[format] : undefined;
    if (manifest) {
      if (manifest.revision !== job.revision || manifest.bytes !== info.size) throw new AppError("Exporten matchar inte aktuell version.", 409);
      headers["ETag"] = `"sha256-${manifest.sha256}"`; headers["X-Output-SHA256"] = manifest.sha256; headers["X-Output-Revision"] = String(manifest.revision);
    }
    const range = request.headers.get("range"); let start = 0; let end = info.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`; headers["Content-Length"] = String(end - start + 1);
    }
    const source = createReadStream(file, { start, end }); request.signal.addEventListener("abort", () => source.destroy(), { once: true });
    return new Response(Readable.toWeb(source) as ReadableStream, { status: range ? 206 : 200, headers });
  } catch (e) { return errorResponse(e); }
}
