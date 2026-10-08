import { errorResponse } from "@/lib/errors";
import { attributionHeader, contentDisposition, prepareTrackDownload } from "@/lib/media";
import { guardRequest, parseBitrate, parseTrackRef } from "@/lib/request";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(request: Request): Promise<Response> {
  try {
    guardRequest(request, "download");
    const params = new URL(request.url).searchParams;
    const result = await prepareTrackDownload(parseTrackRef(params), parseBitrate(params.get("bitrate") ?? 192), undefined, request.signal);
    return new Response(new Uint8Array(result.bytes), { headers: {
      "Content-Type": result.contentType, "Content-Length": String(result.bytes.length),
      "Content-Disposition": contentDisposition(result.filename), "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff", "X-Music-Attribution": attributionHeader(result.track),
      "Link": `<${result.track.sourceUrl}>; rel="original"`,
    } });
  } catch (error) { return errorResponse(error); }
}
