import { resolveTrack, searchMusic } from "../src/lib/catalog";
import { AppError, errorResponse } from "../src/lib/errors";
import { parseSearch, parseTrackRef, parseBitrate } from "../src/lib/request-validators";
import { isRealMp3, safeFilename, contentDisposition, attributionHeader, trackAttribution } from "../src/lib/media-format";
import { fetchAudio } from "./safe-fetch";
declare const __SITE_HTML__: string;
interface Env { ASSETS?: { fetch(request: Request): Promise<Response> } }
const budgets = new Map<string, { count: number; reset: number }>();
const HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "Permissions-Policy": "camera=(), microphone=(self), display-capture=(self), geolocation=()" };
const TRANSLATION_INFO_HTML = `<!doctype html>
<html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#141612"><title>AI Translation · lokalt · TON</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#141612;color:#f3f2e9}*{box-sizing:border-box}body{margin:0}main{width:min(720px,100%);margin:auto;padding:48px 24px 64px}a{color:#d3ed82;text-underline-offset:4px}a:focus-visible{outline:2px solid #d3ed82;outline-offset:6px}.brand{display:inline-block;font-weight:850;font-size:30px;letter-spacing:-2px;text-decoration:none;color:#f3f2e9}.brand span{color:#c8df7a}.back{display:block;margin:32px 0 48px;font-size:14px}.eyebrow{color:#c8df7a;font-size:12px;letter-spacing:2px;text-transform:uppercase}h1{font-size:clamp(34px,7vw,52px);line-height:1.1;letter-spacing:-1.5px;margin:16px 0 24px}p{color:#bdc1b3;line-height:1.75;margin:16px 0}.panel{padding:24px;border:1px solid #3b4131;background:#1e2219;border-radius:16px;margin:32px 0}h2{font-size:20px;margin:0 0 12px}.button{display:inline-block;padding:13px 18px;margin:8px 0;background:#c8df7a;color:#18200e;border-radius:8px;font-weight:650;text-decoration:none}.address{overflow-wrap:anywhere;font-size:13px}.links{display:flex;gap:20px;flex-wrap:wrap;font-size:14px}footer{margin-top:48px;color:#878d7a;font-size:13px}
</style></head><body><main>
<a class="brand" href="/" aria-label="TON startsida">TON<span>.</span></a><a class="back" href="/">← Till musikbiblioteket</a>
<div class="eyebrow">AI Translation · lokalt</div><h1>Fler språk.<br>På din dator.</h1>
<p>AI Translation Studio körs i den lokala versionen av Cd-Importer. Whisper transkriberar talet, Ollama översätter och en lokal TTS-röst läser upp resultatet.</p>
<p>Den här sidan tar inte emot dina videor eller ljudfiler. Översättning, granskning och export sker i studion som du startar på din egen dator.</p>
<section class="panel" aria-labelledby="start-heading"><h2 id="start-heading">Starta den lokala servern först</h2>
<p>Installera modellerna enligt guiden och starta AI-gateway, worker och webbappen på port 3011. Länken nedan fungerar när den lokala servern är igång på den här datorn.</p>
<a class="button" href="http://127.0.0.1:3011/translation" target="_blank" rel="noopener noreferrer">Öppna lokala studion ↗</a>
<p class="address">http://127.0.0.1:3011/translation</p></section>
<nav class="links" aria-label="Installation och källkod"><a href="https://github.com/sharbel0022/Cd-Importer/blob/main/docs/local-ai-setup.md" target="_blank" rel="noopener noreferrer">Installationsguide ↗</a><a href="https://github.com/sharbel0022/Cd-Importer" target="_blank" rel="noopener noreferrer">Källkod på GitHub ↗</a></nav>
<footer>TON. Dina medier. Din lokala studio.</footer>
</main></body></html>`;
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
    if (["/translation", "/translation/", "/translation/guide", "/translation/guide/"].includes(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Informationssidan tar inte emot uppladdningar.", { status: 405, headers: { Allow: "GET, HEAD" } });
      return new Response(request.method === "HEAD" ? null : TRANSLATION_INFO_HTML, { headers: {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      } });
    }
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
