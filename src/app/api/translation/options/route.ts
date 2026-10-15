import { errorResponse } from "@/lib/errors";
import { boundedJson, guardRequest } from "@/lib/request";
import { createUploadOptions, UPLOAD_OPTIONS_MAX_BYTES } from "@/lib/translation/upload-options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    guardRequest(request, "studio-upload-options", true);
    const result = await createUploadOptions(await boundedJson(request, UPLOAD_OPTIONS_MAX_BYTES), request.signal);
    return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (cause) { return errorResponse(cause); }
}
