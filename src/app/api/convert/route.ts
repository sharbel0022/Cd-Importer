import path from "node:path";
import { AppError, errorResponse } from "@/lib/errors";
import { convertToMp3, SUPPORTED_UPLOAD_EXTENSIONS } from "@/lib/ffmpeg";
import { contentDisposition, isRealMp3, safeFilename } from "@/lib/media";
import { guardRequest, limitedBody, parseBitrate, uploadLimitMb } from "@/lib/request";
import { parseAudioCuts } from "@/lib/audio-edits";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request): Promise<Response> {
  try {
    guardRequest(request, "convert", true);
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw new AppError("Ladda upp en ljudfil med formuläret.", 415);
    const maxBytes = uploadLimitMb() * 1024 * 1024;
    // Read with a hard limit before the multipart parser allocates the upload.
    const bytes = await limitedBody(request, maxBytes + 64 * 1024);
    let form: FormData;
    try { form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType } }).formData(); }
    catch { throw new AppError("Uppladdningen kunde inte läsas. Försök igen."); }
    if (form.get("rightsConfirmed") !== "true") throw new AppError("Bekräfta att du äger filen eller har tillstånd att konvertera den.", 403);
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("Välj en ljudfil att konvertera.");
    if (!file.size || file.size > maxBytes) throw new AppError(`Ljudfilen får vara högst ${uploadLimitMb()} MB.`, 413);
    const extension = path.extname(file.name).slice(1).toLowerCase();
    if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) throw new AppError("Välj WAV, FLAC, M4A, MP3, OGG, AAC eller AIFF.", 415);
    const bitrate = parseBitrate(form.get("bitrate") ?? 192);
    const cuts = parseAudioCuts(form.get("cuts"));
    const artist = form.get("artist");
    const title = form.get("title");
    if ((artist !== null && typeof artist !== "string") || (title !== null && typeof title !== "string") ||
      (typeof artist === "string" && artist.length > 200) || (typeof title === "string" && title.length > 200)) throw new AppError("Artist och låttitel får vara högst 200 tecken.");
    const input = Buffer.from(await file.arrayBuffer());
    const output = await convertToMp3(input, bitrate, extension, request.signal, cuts);
    if (!isRealMp3(output)) throw new AppError("Konverteringen kunde inte skapa en giltig MP3.", 422);
    const filename = safeFilename(artist ?? undefined, title || path.basename(file.name, path.extname(file.name)));
    return new Response(new Uint8Array(output), { headers: {
      "Content-Type": "audio/mpeg", "Content-Length": String(output.length),
      "Content-Disposition": contentDisposition(filename), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return errorResponse(error); }
}
