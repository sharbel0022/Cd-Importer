import { AppError, errorResponse } from "@/lib/errors";
import { boundedJson, guardRequest } from "@/lib/request";
import { asrReprocessSchema, reprocessAsr } from "@/lib/translation/asr-reprocess";

export const runtime = "nodejs";
export const maxDuration = 3600;
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: Context) {
  try {
    guardRequest(request, "studio-asr", true);
    const parsed = asrReprocessSchema.safeParse(await boundedJson(request, 4096));
    if (!parsed.success) throw new AppError("Ange aktuell version, högst tre källsegment och två installerade ASR-modeller.");
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3_550_000)]);
    return Response.json(await reprocessAsr((await ctx.params).id, parsed.data, signal), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
