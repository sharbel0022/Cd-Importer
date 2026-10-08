import { resolveTrack, searchMusic } from "../src/lib/catalog";
import { AppError, errorResponse } from "../src/lib/errors";
import { parseSearch, parseTrackRef, parseBitrate } from "../src/lib/request-validators";
import { isRealMp3, safeFilename, contentDisposition, attributionHeader, trackAttribution } from "../src/lib/media-format";
import { fetchAudio } from "./safe-fetch";
declare const __SITE_HTML__: string;
interface Env { ASSETS?: { fetch(request: Request): Promise<Response> } }
const budgets = new Map<string, { count: number; reset: number }>();
const HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "Permissions-Policy": "camera=(), microphone=(self), geolocation=()" };
function guard(request: Request, action: string) {
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("Öppna appen för att använda den här funktionen.", 403);
  const minute = Date.now(); const key = `${request.headers.get("cf-connecting-ip") || "local"}:${action}`;
  if (budgets.size > 5000) for (const [id, bucket] of budgets) if (bucket.reset < minute) budgets.delete(id);
  if (budgets.size > 10000) throw new AppError("Tjänsten är tillfälligt upptagen.", 429);
  const bucket = budgets.get(key); const limit = action === "search" ? 30 : 120;
  if (!bucket || bucket.reset < minute) budgets.set(key, { count: 1, reset: minute + 60_000 });
  else if (++bucket.count > limit) throw new AppError("För många anrop. Vänta en minut och försök igen.", 429);
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const action = url.pathname.slice(5);
  if (!url.pathname.startsWith("/api/")) {
    if (url.pathname === "/") return new Response(__SITE_HTML__, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Sidan finns inte.", { status: 404 });
  }
  if (request.method !== "GET") throw new AppError("Konvertering och ZIP sker i appens webbläsare.", 405);
  guard(request, action);
  if (action === "status") return Response.json({ conversionLocation: "browser", ffmpeg: { available: true, message: "FFmpeg körs i din webbläsare." }, limits: { uploadMb: 25, batchTracks: 10 } });
  if (action === "search") { const query = parseSearch(url.searchParams); return Response.json(await searchMusic(query.query, query.source, query.page, query.licensedOnly)); }
  if (!["license", "audio", "download"].includes(action)) throw new AppError("Funktionen finns inte.", 404);
  const { track, url: sourceUrl } = await resolveTrack(parseTrackRef(url.searchParams));
  if (action === "license") return Response.json(trackAttribution(track), { headers: { "Content-Disposition": contentDisposition(safeFilename(track.artist, track.title).replace(/\.mp3$/, ".licens.json")) } });
  if (action === "audio" ? !track.playbackAllowed : !track.downloadAllowed || !track.license.downloadAllowed) throw new AppError("Källan har inte gett tillstånd. Läs rättigheterna på originalkällan.", 403);
  const audio = await fetchAudio(sourceUrl, request.signal, action === "audio" ? request.headers.get("range") ?? undefined : undefined);
  const headers = new Headers({ "Content-Type": audio.contentType, "Content-Length": String(audio.bytes.length), "Accept-Ranges": "bytes" });
  if (audio.contentRange) headers.set("Content-Range", audio.contentRange);
  if (action === "download") {
    parseBitrate(url.searchParams.get("bitrate") ?? 192);
    const mp3 = isRealMp3(audio.bytes);
    if (!mp3 && (track.format === "MP3" || !track.license.conversionAllowed)) throw new AppError("Filen är inte en verifierad MP3 och licensen tillåter ingen konvertering.", 403);
    const mp3Filename = safeFilename(track.artist, track.title);
    const extension = new URL(sourceUrl).pathname.split(".").pop()?.toLowerCase() ?? "bin";
    headers.set("X-MP3-Filename", encodeURIComponent(mp3Filename));
    headers.set("Content-Disposition", contentDisposition(mp3 ? mp3Filename : mp3Filename.replace(/\.mp3$/, `.${extension}`)));
    headers.set("X-Music-Attribution", attributionHeader(track));
    headers.set("Link", `<${track.sourceUrl}>; rel="original"`);
    if (mp3) headers.set("Content-Type", "audio/mpeg");
    else { headers.set("X-Convert-Allowed", "true"); headers.set("X-Source-Extension", extension); }
    if (url.searchParams.get("envelope") === "1") {
      // Audio and full licensing come from the same authoritative resolution.
      const body = new FormData();
      body.set("audio", new Blob([audio.bytes], { type: headers.get("Content-Type")! }), mp3 ? mp3Filename : `original.${extension}`);
      body.set("license", JSON.stringify(trackAttribution(track)));
      headers.delete("Content-Length"); headers.delete("Content-Type"); headers.delete("Content-Disposition");
      return new Response(body, { headers });
    }
  }
  return new Response(audio.bytes, { status: audio.status, headers });
}
export default { async fetch(request: Request, env: Env): Promise<Response> {
  let response: Response; try { response = await route(request, env); } catch (error) { response = errorResponse(error); }
  const headers = new Headers(response.headers); for (const [key, value] of Object.entries(HEADERS)) headers.set(key, value);
  if (new URL(request.url).pathname.startsWith("/api/")) headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
} };
