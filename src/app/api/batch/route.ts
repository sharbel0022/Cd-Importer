import { zipSync, strToU8 } from "fflate";
import { AppError, errorResponse } from "@/lib/errors";
import { contentDisposition, prepareTrackDownload, trackAttribution } from "@/lib/media";
import { boundedJson, guardRequest, parseBitrate, parseTrackRef } from "@/lib/request";
import type { TrackRef } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;
const BATCH_MAX_BYTES = 100 * 1024 * 1024;

function skippedHeader(failures: { title: string; message: string }[]): string {
  let titleLength = 80;
  let messageLength = 120;
  while (true) {
    const header = encodeURIComponent(JSON.stringify(failures.map(({ title, message }) => ({ title: title.slice(0, titleLength), message: message.slice(0, messageLength) }))));
    if (header.length <= 5_500) return header;
    titleLength = Math.floor(titleLength / 2);
    messageLength = Math.floor(messageLength / 2);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    guardRequest(request, "batch", true);
    const input = await boundedJson(request);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError("Nedladdningslistan är ogiltig.");
    const body = input as { tracks?: unknown; bitrate?: unknown };
    if (!Array.isArray(body.tracks) || !body.tracks.length || body.tracks.length > 10) throw new AppError("Välj mellan 1 och 10 låtar per ZIP-fil.");
    const bitrate = parseBitrate(body.bitrate ?? 192);
    const refs = body.tracks.map(parseTrackRef);
    const files: Record<string, Uint8Array> = {};
    const manifest: ReturnType<typeof trackAttribution>[] = [];
    const failures: { track: TrackRef; title: string; message: string }[] = [];
    let total = 0;
    let count = 0;
    for (const ref of refs) {
      try {
        if (total >= BATCH_MAX_BYTES) throw new AppError("ZIP-filens sammanlagda gräns på 100 MB är uppnådd.", 413);
        const result = await prepareTrackDownload(ref, bitrate, BATCH_MAX_BYTES - total, request.signal);
        let filename = result.filename;
        for (let duplicate = 2; filename in files; duplicate++) filename = result.filename.replace(/\.mp3$/, ` (${duplicate}).mp3`);
        files[filename] = new Uint8Array(result.bytes);
        manifest.push(trackAttribution(result.track));
        total += result.bytes.length;
        count++;
      } catch (error) {
        if (request.signal.aborted) throw new AppError("ZIP-hämtningen avbröts.", 400);
        failures.push({ track: ref, title: ref.source === "commons" ? ref.id.replace(/^File:/, "") : ref.file ?? ref.id,
          message: error instanceof AppError ? error.message : "Ljudfilen kunde inte hämtas." });
      }
    }
    if (!count) return Response.json({ error: "Ingen av de valda låtarna kunde hämtas.", failures }, { status: 422 });
    files["LICENSER.json"] = strToU8(JSON.stringify({ skapad: new Date().toISOString(), låtar: manifest }, null, 2));
    files["FEL.json"] = strToU8(JSON.stringify(failures, null, 2));
    // MP3 is already compressed; storing avoids costly recompression on the server.
    const zip = zipSync(files, { level: 0 });
    return new Response(new Uint8Array(zip), { headers: {
      "Content-Type": "application/zip", "Content-Length": String(zip.length),
      "Content-Disposition": contentDisposition("Music Downloader.zip"), "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff", "X-Downloaded-Tracks": String(count),
      "X-Skipped-Tracks": skippedHeader(failures),
    } });
  } catch (error) { return errorResponse(error); }
}
