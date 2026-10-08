import { FFmpeg } from "@ffmpeg/ffmpeg";
import { zipSync, strToU8 } from "fflate";
import { isRealMp3, safeFilename, contentDisposition } from "../src/lib/media-format";
import { parseBitrate, parseTrackRef } from "../src/lib/request-validators";
import { trackQuery } from "../src/lib/types";
import { AppError, errorResponse } from "../src/lib/errors";
const SUPPORTED = new Set(["wav", "flac", "m4a", "mp3", "aac", "ogg", "oga", "aiff", "aif", "opus", "webm"]);
let converting = false;
async function convert(bytes: Uint8Array, extension: string, bitrate: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw new AppError("Konverteringen avbröts.");
  if (converting) throw new AppError("En konvertering pågår. Vänta tills den är klar.", 429);
  if (!SUPPORTED.has(extension) || !bytes.length || bytes.length > 25 * 1024 * 1024) throw new AppError("Välj ett ljudformat som stöds, högst 25 MB.", 413);
  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") throw new AppError("Webbläsaren kan inte konvertera MP3. Prova en aktuell webbläsare eller använd den lokala appen.", 415);
  converting = true; const ffmpeg = new FFmpeg(); const controller = new AbortController(); let wasmUrl: string | undefined;
  const abort = () => { controller.abort(); ffmpeg.terminate(); };
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 150_000);
  try {
    const manifestResponse = await fetch("/ffmpeg/manifest.json", { signal: controller.signal });
    if (!manifestResponse.ok) throw new AppError("Konverteringsverktyget kunde inte hämtas. Kontrollera anslutningen och försök igen.", 503);
    const manifest = await manifestResponse.json() as { parts: string[]; size: number; sha256: string };
    if (!Array.isArray(manifest.parts) || manifest.parts.length !== 2 || !manifest.parts.every(part => /^core-[01]\.bin$/.test(part)) || manifest.size > 40 * 1024 * 1024) throw new AppError("Konverteringsverktyget saknar giltiga data.", 503);
    const parts = await Promise.all(manifest.parts.map(async name => { const result = await fetch(`/ffmpeg/${name}`, { signal: controller.signal }); if (!result.ok) throw new AppError("Konverteringsverktyget kunde inte hämtas.", 503); return result.arrayBuffer(); }));
    const core = new Blob(parts, { type: "application/wasm" });
    if (core.size !== manifest.size) throw new AppError("Konverteringsverktyget är ofullständigt. Försök igen.", 503);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await core.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== manifest.sha256) throw new AppError("Konverteringsverktyget kunde inte verifieras.", 503);
    wasmUrl = URL.createObjectURL(core);
    await ffmpeg.load({ coreURL: new URL("/ffmpeg/ffmpeg-core.js", location.href).href, wasmURL: wasmUrl }, { signal: controller.signal });
    await ffmpeg.writeFile(`input.${extension}`, bytes, { signal: controller.signal });
    const formats: Record<string, string> = { webm: "matroska", m4a: "mov", ogg: "ogg", oga: "ogg", opus: "ogg", wav: "wav", flac: "flac" };
    const code = await ffmpeg.exec(["-hide_banner", "-protocol_whitelist", "file,pipe", ...(formats[extension] ? ["-f", formats[extension]] : []), "-i", `input.${extension}`, "-map", "0:a:0", "-vn", "-sn", "-dn", "-c:a", "libmp3lame", "-b:a", `${bitrate}k`, "-fs", "26214400", "output.mp3"], 120_000, { signal: controller.signal });
    if (code !== 0) throw new AppError("Ljudet kunde inte konverteras. Filen kan vara skadad eller för stor.", 422);
    const output = await ffmpeg.readFile("output.mp3", "binary", { signal: controller.signal });
    if (!(output instanceof Uint8Array) || !isRealMp3(output)) throw new AppError("Konverteringen skapade ingen giltig MP3.", 422);
    if (output.length >= 25 * 1024 * 1024) throw new AppError("MP3-filen blev för stor. Välj lägre kvalitet eller ett kortare ljud.", 413);
    return output;
  } catch (error) {
    if (controller.signal.aborted) throw new AppError("Konverteringen avbröts eller tog för lång tid. Din inspelning finns kvar; försök med ett kortare ljud.", 408);
    if (error instanceof AppError) throw error;
    throw new AppError("Webbläsaren kunde inte köra MP3-konverteringen. Försök igen med en mindre fil eller använd den lokala appen.", 422);
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); ffmpeg.terminate(); if (wasmUrl) URL.revokeObjectURL(wasmUrl); converting = false; }
}
function mp3Response(bytes: Uint8Array, filename: string, original?: Headers): Response {
  const headers = new Headers(original); headers.set("Content-Type", "audio/mpeg"); headers.set("Content-Length", String(bytes.length)); headers.set("Content-Disposition", contentDisposition(filename)); headers.set("Cache-Control", "no-store");
  return new Response(new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }), { headers });
}
async function ownFile(init: RequestInit): Promise<Response> {
  const data = init.body;
  if (!(data instanceof FormData) || data.get("rightsConfirmed") !== "true") throw new AppError("Bekräfta att du har rätt att konvertera ljudet.", 403);
  const file = data.get("file"); if (!(file instanceof File)) throw new AppError("Välj en ljudfil.");
  if (!file.size || file.size > 25 * 1024 * 1024) throw new AppError("Välj en ljudfil på högst 25 MB.", 413);
  const title = String(data.get("title") ?? file.name.replace(/\.[^.]+$/, "")); const artist = String(data.get("artist") ?? "");
  if (title.length > 200 || artist.length > 200) throw new AppError("Namnet får vara högst 200 tecken.");
  const output = await convert(new Uint8Array(await file.arrayBuffer()), file.name.split(".").pop()?.toLowerCase() ?? "", parseBitrate(data.get("bitrate")), init.signal ?? undefined);
  return mp3Response(output, safeFilename(artist, title));
}
async function remoteFile(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, location.href); url.searchParams.set("envelope", "1");
  const response = await fetch(url, init); if (!response.ok) return response;
  const envelope = await response.formData(); const audio = envelope.get("audio"); const license = envelope.get("license");
  if (!(audio instanceof File) || typeof license !== "string") throw new AppError("Källans ljud och licens kunde inte kontrolleras.", 502);
  JSON.parse(license); const headers = new Headers(response.headers); headers.set("X-Music-Attribution", encodeURIComponent(license));
  const bytes = new Uint8Array(await audio.arrayBuffer());
  if (isRealMp3(bytes)) return mp3Response(bytes, filename(response), headers);
  if (response.headers.get("X-Convert-Allowed") !== "true") throw new AppError("Källan tillåter inte MP3-konvertering.", 403);
  const output = await convert(bytes, response.headers.get("X-Source-Extension") ?? "", parseBitrate(new URL(input, location.href).searchParams.get("bitrate") ?? 192), init?.signal ?? undefined);
  return mp3Response(output, filename(response), headers);
}
function filename(response: Response): string { const preferred = response.headers.get("X-MP3-Filename"); if (preferred) return decodeURIComponent(preferred); const encoded = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get("Content-Disposition") ?? ""); return encoded ? decodeURIComponent(encoded[1]) : "Ljudfil.mp3"; }
async function batch(init: RequestInit): Promise<Response> {
  if (typeof init.body !== "string" || init.body.length > 16_384) throw new AppError("Ogiltig nedladdningslista.");
  const data = JSON.parse(init.body) as { tracks: unknown[]; bitrate?: unknown };
  if (!Array.isArray(data.tracks) || !data.tracks.length || data.tracks.length > 10) throw new AppError("Välj 1–10 spår.");
  const bitrate = parseBitrate(data.bitrate); const files: Record<string, Uint8Array> = Object.create(null); const licenses: unknown[] = []; const failures: { title: string; message: string; sourceUrl?: string }[] = []; let size = 0;
  for (const input of data.tracks) {
    if (init.signal?.aborted) throw new AppError("Hämtningen avbröts.");
    const ref = parseTrackRef(input); const query = trackQuery(ref); let provenance: Record<string, unknown> = {};
    try {
      const result = await remoteFile(`/api/download?${query}&bitrate=${bitrate}`, { signal: init.signal });
      if (!result.ok) throw new AppError(String((await result.json() as { error?: string }).error ?? "Filen kunde inte hämtas."), result.status);
      provenance = JSON.parse(decodeURIComponent(result.headers.get("X-Music-Attribution") ?? "")) as Record<string, unknown>;
      const bytes = new Uint8Array(await result.arrayBuffer()); if (size + bytes.length > 100 * 1024 * 1024) throw new AppError("Paketet får vara högst 100 MB.", 413);
      let name = filename(result); let suffix = 1; while (name in files) name = filename(result).replace(/\.mp3$/, ` (${suffix++}).mp3`);
      files[name] = bytes; size += bytes.length; licenses.push({ fil: name, ...provenance });
    } catch (error) { if (init.signal?.aborted) throw error; failures.push({ title: String(provenance.titel ?? ref.id), message: error instanceof Error ? error.message : "Hämtningen misslyckades.", sourceUrl: typeof provenance.original === "string" ? provenance.original : undefined }); }
  }
  if (!licenses.length) return Response.json({ error: "Inga valda spår kunde hämtas.", failures }, { status: 422 });
  files["LICENSER.json"] = strToU8(JSON.stringify({ skapad: new Date().toISOString(), låtar: licenses }, null, 2)); files["FEL.json"] = strToU8(JSON.stringify(failures, null, 2));
  return new Response(new Blob([new Uint8Array(zipSync(files, { level: 0 }))], { type: "application/zip" }), { headers: { "Content-Type": "application/zip", "Content-Disposition": contentDisposition("TON-musik.zip"), "X-Skipped-Tracks": encodeURIComponent(JSON.stringify(failures)) } });
}
export async function musicRequest(input: string, init?: RequestInit): Promise<Response> {
  try {
    if (input === "/api/convert") return await ownFile(init ?? {});
    if (input.startsWith("/api/download?")) return await remoteFile(input, init);
    if (input === "/api/batch") return await batch(init ?? {});
    return await fetch(input, init);
  } catch (error) { return errorResponse(error); }
}
