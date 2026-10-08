import { resolveTrack } from "@/lib/catalog";
import { errorResponse } from "@/lib/errors";
import { contentDisposition, safeFilename, trackAttribution } from "@/lib/media";
import { guardRequest, parseTrackRef } from "@/lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    guardRequest(request, "license");
    const { track } = await resolveTrack(parseTrackRef(new URL(request.url).searchParams));
    const filename = safeFilename(track.artist, track.title).replace(/\.mp3$/, ".licens.json");
    return Response.json(trackAttribution(track), { headers: {
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return errorResponse(error); }
}
