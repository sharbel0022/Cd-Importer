import { AppError, errorResponse } from "@/lib/errors";
import { boundedJson, guardRequest } from "@/lib/request";
import { duplicateTranslationProject, projectActionSchema, renameTranslationProject } from "@/lib/translation/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  try {
    guardRequest(request, "studio-project", true);
    const parsed = projectActionSchema.safeParse(await boundedJson(request, 4096));
    if (!parsed.success) throw new AppError("Ange ett giltigt projektnamn och aktuell version.");
    const { id } = await context.params; const action = parsed.data;
    const job = action.action === "rename" ? await renameTranslationProject(id, action.revision, action.name) : await duplicateTranslationProject(id, action.revision, request.signal);
    return Response.json(job, { status: action.action === "duplicate" ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (cause) { return errorResponse(cause); }
}
