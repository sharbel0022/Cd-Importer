import path from "node:path";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { AppError, errorResponse } from "@/lib/errors";
import { jobDir, readJob } from "@/lib/translation/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const types: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", srt: "application/x-subrip", vtt: "text/vtt", txt: "text/plain", json: "application/json" };
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params; const job = await readJob(id); const query = new URL(request.url).searchParams;
    const original = query.get("original") === "true"; const target = query.get("target") || ""; const format = original ? job.extension : query.get("format") || "";
    if (!original && (!job.options.targets.includes(target) || !job.outputs[target]?.includes(format))) throw new AppError("Exporten är inte färdig eller finns inte.", 404);
    const filename = original ? `original.${job.extension}` : `${target}.${format}`; const file = path.join(jobDir(id), filename); const info = await stat(file);
    const headers: Record<string, string> = { "Content-Type": `${types[format] || "application/octet-stream"}${["txt", "json", "srt", "vtt"].includes(format) ? "; charset=utf-8" : ""}`, "Content-Length": String(info.size), "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Content-Disposition": `${query.get("download") === "true" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(original ? job.name : `${path.basename(job.name, path.extname(job.name))}-${target}.${format}`)}` };
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
