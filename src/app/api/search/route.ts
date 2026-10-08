import { searchMusic } from "@/lib/catalog";
import { errorResponse } from "@/lib/errors";
import { guardRequest, parseSearch } from "@/lib/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    guardRequest(request, "search");
    const { query, source, page, licensedOnly } = parseSearch(new URL(request.url).searchParams);
    return Response.json(await searchMusic(query, source, page, licensedOnly), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
