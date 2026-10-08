import path from "node:path";
import { resolveTrack } from "./catalog";
import { AppError } from "./errors";
import { convertToMp3, SUPPORTED_UPLOAD_EXTENSIONS } from "./ffmpeg";
import { safeAudioFetch } from "./safe-download";
import type { Bitrate, Track, TrackRef } from "./types";
import { isRealMp3, safeFilename } from "./media-format";
export { isRealMp3, safeFilename, contentDisposition, trackAttribution, attributionHeader } from "./media-format";

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
