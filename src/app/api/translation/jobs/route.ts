import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AppError, errorResponse } from "@/lib/errors";
import { guardRequest } from "@/lib/request";
import { atomicJson, enforceQuota, jobDir, listJobs, receiveUpload, uploadMb } from "@/lib/translation/store";
import { validateOptions } from "@/lib/translation/providers";
import { EXTENSIONS, type Job } from "@/lib/translation/types";
import { uploadOptionsFromRequest } from "@/lib/translation/upload-options";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET() {
  try { return Response.json((await listJobs()).slice(0, 40).map(({ id, name, status, stage, createdAt, message, options }) => ({ id, name, status, stage, createdAt, message, targets: options.targets })), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return errorResponse(e); }
}
export async function POST(request: Request) {
  let dir: string | undefined;
  try {
    guardRequest(request, "studio-upload", true);
    let name: string;
    try { name = Array.from(decodeURIComponent(request.headers.get("x-file-name") || ""), (c) => c.charCodeAt(0) < 32 || c === "/" || c === "\\" ? "_" : c).join(""); }
    catch { throw new AppError("Uppladdningen saknar giltigt namn eller inställningar."); }
    if (!name || name.length > 200) throw new AppError("Filnamnet måste vara 1–200 tecken.");
    const options = await uploadOptionsFromRequest(request); await validateOptions(options);
    const extension = path.extname(name).slice(1).toLowerCase(); if (!EXTENSIONS[extension]) throw new AppError("Välj MP3, WAV, M4A, AAC, FLAC, OGG, MP4, MOV, MKV eller WebM.", 415);
    if ((await listJobs()).filter((j) => ["queued", "running"].includes(j.status)).length >= 8) throw new AppError("Jobbkön är full. Vänta eller avbryt ett jobb.", 429);
    await enforceQuota();
    const id = randomUUID(); dir = jobDir(id); await mkdir(dir, { recursive: true });
    await receiveUpload(request, path.join(dir, `original.${extension}`), uploadMb() * 1024 ** 2);
    const now = new Date().toISOString();
    const job: Job = { id, name, extension, createdAt: now, updatedAt: now, revision: 0, options, status: "queued", stage: "uploading", message: "Uppladdad. Väntar på studio-worker.", segments: [], translations: {}, outputs: {}, warnings: [], metrics: { processingMs: 0, stages: {} } };
    await atomicJson(path.join(dir, "job.json"), job); dir = undefined;
    return Response.json(job, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) { if (dir) await rm(dir, { recursive: true, force: true }); return errorResponse(e); }
}
