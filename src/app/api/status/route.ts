import { getFFmpegStatus } from "@/lib/ffmpeg";
import { errorResponse } from "@/lib/errors";
import { guardRequest, uploadLimitMb } from "@/lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let statusCache: { expires: number; value: Promise<{ available: boolean; message: string }> } | undefined;

export async function GET(request: Request): Promise<Response> {
  try {
    guardRequest(request, "status");
    if (!statusCache || statusCache.expires < Date.now()) {
      statusCache = { expires: Date.now() + 30_000, value: getFFmpegStatus().then(({ available, message }) => ({ available, message })) };
    }
    return Response.json({
      ffmpeg: await statusCache.value,
      limits: { uploadMb: uploadLimitMb(), batchTracks: 10 },
      sources: [
        { id: "archive", name: "Internet Archive", requiresApiKey: false },
        { id: "commons", name: "Wikimedia Commons", requiresApiKey: false },
      ],
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
