import path from "node:path";
import { resolveTrack } from "./catalog";
import { AppError } from "./errors";
import { convertToMp3, SUPPORTED_UPLOAD_EXTENSIONS } from "./ffmpeg";
import { safeAudioFetch } from "./safe-download";
import type { Bitrate, Track, TrackRef } from "./types";
import { trackRef } from "./types";

interface Mp3Frame { length: number; version: number; sampleRate: number }
function mp3Frame(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[offset + 1] >> 3) & 3;
  const layer = (bytes[offset + 1] >> 1) & 3;
  const bitrateIndex = bytes[offset + 2] >> 4;
  const sampleIndex = (bytes[offset + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const bitrates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRate = [44100, 48000, 32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const length = Math.floor((version === 3 ? 144 : 72) * bitrates[bitrateIndex] * 1000 / sampleRate) + ((bytes[offset + 2] >> 1) & 1);
  return { length, version, sampleRate };
}

/** ID3 alone is not proof of MP3: require consecutive MPEG Layer III frames. */
export function isRealMp3(bytes: Uint8Array): boolean {
  let start = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    if ([bytes[6], bytes[7], bytes[8], bytes[9]].some((byte) => byte > 0x7f)) return false;
    start = 10 + (bytes[6] << 21) + (bytes[7] << 14) + (bytes[8] << 7) + bytes[9] + ((bytes[5] & 0x10) ? 10 : 0);
    if (start >= bytes.length) return false;
  }
  for (let offset = start; offset < Math.min(bytes.length - 4, start + 128 * 1024); offset++) {
    const frame = mp3Frame(bytes, offset);
    if (!frame || offset + frame.length > bytes.length) continue;
    const next = mp3Frame(bytes, offset + frame.length);
    if (next && next.version === frame.version && next.sampleRate === frame.sampleRate && offset + frame.length + next.length <= bytes.length) return true;
  }
  return false;
}

export function safeFilename(artist: string | undefined, title: string | undefined): string {
  const clean = (value: string | undefined) => new TextDecoder().decode(new TextEncoder().encode(value ?? ""))
    .normalize("NFC").replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/[. ]+$/g, "").slice(0, 100).replace(/[\uD800-\uDBFF]$/g, "");
  const parts = [clean(artist), clean(title)].filter(Boolean);
  let name = parts.join(" - ") || "Ljudfil";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return `${name}.mp3`;
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function trackAttribution(track: Track) {
  return { titel: track.title, artist: track.artist, källa: track.source, original: track.sourceUrl,
    licens: track.license.name, licensUrl: track.license.url ?? null,
    attribution: track.license.attribution ?? `${track.artist} – ${track.title}`,
    nedladdningTillåten: track.downloadAllowed,
    kommentar: "Behåll denna licensinformation och följ villkoren vid vidare användning." };
}

/** HTTP headers have much smaller limits than the license JSON body. */
export function attributionHeader(track: Track): string {
  const full = encodeURIComponent(JSON.stringify(trackAttribution(track)));
  if (full.length <= 5_500) return full;
  const compact = encodeURIComponent(JSON.stringify({ licens: track.license.name.slice(0, 40), licensUrl: track.license.url,
    endpoint: "/api/license", track: trackRef(track) }));
  if (compact.length <= 5_500) return compact;
  return encodeURIComponent(JSON.stringify({ endpoint: "/api/license", track: trackRef(track) }));
}

export async function prepareTrackDownload(ref: TrackRef, bitrate: Bitrate = 192, maxBytes?: number, signal?: AbortSignal): Promise<{
  track: Track; bytes: Buffer; filename: string; contentType: "audio/mpeg";
}> {
  if (signal?.aborted) throw new AppError("Hämtningen avbröts.", 400);
  const { track, url } = await resolveTrack(ref);
  if (!track.downloadAllowed || !track.license.downloadAllowed) {
    throw new AppError(`Nedladdning är inte tillåten: ${track.license.reason}`, 403);
  }
  const remote = await safeAudioFetch(url, { maxBytes, signal });
  let bytes = remote.bytes;
  if (!isRealMp3(bytes)) {
    if (!track.license.conversionAllowed) throw new AppError("Licensen tillåter inte konvertering till MP3. Använd originalkällan.", 403);
    const extension = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    if (extension === "mp3") throw new AppError("Källans fil är inte en giltig MP3. Använd originalkällan.", 502);
    if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) throw new AppError("Detta källformat kan inte konverteras. Använd originalkällan.", 415);
    bytes = await convertToMp3(bytes, bitrate, extension, signal);
    if (!isRealMp3(bytes)) throw new AppError("Konverteringen skapade ingen giltig MP3.", 502);
    if (maxBytes !== undefined && bytes.length > maxBytes) throw new AppError("Den sammanlagda filstorleken är för stor.", 413);
  }
  return { track, bytes, filename: safeFilename(track.artist, track.title), contentType: "audio/mpeg" };
}
