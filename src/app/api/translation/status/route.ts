import { capabilities } from "@/lib/translation/providers";
import { errorResponse } from "@/lib/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { try { return Response.json(await capabilities(), { headers: { "Cache-Control": "no-store" } }); } catch (e) { return errorResponse(e); } }
