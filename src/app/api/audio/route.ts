import { resolveTrack } from "@/lib/catalog";
import { AppError, errorResponse } from "@/lib/errors";
import { guardRequest, parseTrackRef } from "@/lib/request";
import { safeAudioFetch, validateRange } from "@/lib/safe-download";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  try {
    guardRequest(request, "audio");
    const ref = parseTrackRef(new URL(request.url).searchParams);
    const range = validateRange(request.headers.get("range"));
    if (request.signal.aborted) throw new AppError("Uppspelningen avbröts.", 400);
    const { track, url } = await resolveTrack(ref);
    if (!track.playbackAllowed) throw new AppError("Källan har inte gett tydligt tillstånd för uppspelning. Öppna originalkällan.", 403);
    const audio = await safeAudioFetch(url, { range, signal: request.signal });
    const headers = new Headers({ "Content-Type": audio.contentType, "Content-Length": String(audio.bytes.length),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    if (audio.acceptRanges === "bytes") headers.set("Accept-Ranges", "bytes");
    if (audio.contentRange) headers.set("Content-Range", audio.contentRange);
    return new Response(new Uint8Array(audio.bytes), { status: audio.status, headers });
  } catch (error) { return errorResponse(error); }
}
