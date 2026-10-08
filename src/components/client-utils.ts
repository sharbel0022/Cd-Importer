import type { Track } from "@/lib/types";

export function durationLabel(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return "–:––";
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, "0")}`;
}

export function playbackTime(seconds: number): string {
  return seconds > 0 ? durationLabel(seconds) : "0:00";
}

export function sourceLabel(source: Track["source"]): string {
  return source === "archive" ? "Internet Archive" : "Wikimedia Commons";
}

export function readableBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} MB`;
}

export function safeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 160) || "musik";
}

export function responseFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try { return safeFilename(decodeURIComponent(encoded)); } catch { /* Use plain filename. */ }
  }
  return safeFilename(/filename="([^"]+)"/i.exec(disposition)?.[1] ?? fallback);
}

export function saveBlob(blob: Blob, filename: string): string {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  return url;
}

export async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record.error === "string") return record.error;
      if (typeof record.message === "string") return record.message;
    }
  } catch { /* An upstream error need not contain JSON. */ }
  return `${fallback} (${response.status}).`;
}

export function isStoredTrack(value: unknown): value is Track {
  if (typeof value !== "object" || value === null) return false;
  const track = value as Partial<Track>;
  return (track.source === "archive" || track.source === "commons") &&
    typeof track.id === "string" && typeof track.key === "string" &&
    (track.file === undefined || typeof track.file === "string") &&
    typeof track.title === "string" && typeof track.artist === "string" &&
    (track.album === undefined || typeof track.album === "string") &&
    typeof track.format === "string" && typeof track.sourceUrl === "string" &&
    /^https:\/\/(archive\.org|commons\.wikimedia\.org)\//.test(track.sourceUrl) &&
    (track.artworkUrl === undefined || (typeof track.artworkUrl === "string" && /^https:\/\/([a-z0-9-]+\.)*(archive\.org|wikimedia\.org)\//.test(track.artworkUrl))) &&
    (track.duration === undefined || (typeof track.duration === "number" && Number.isFinite(track.duration) && track.duration >= 0)) &&
    (track.size === undefined || (typeof track.size === "number" && Number.isFinite(track.size) && track.size >= 0)) &&
    typeof track.downloadAllowed === "boolean" && typeof track.playbackAllowed === "boolean" &&
    typeof track.license === "object" && track.license !== null &&
    typeof track.license.name === "string" && typeof track.license.reason === "string" &&
    typeof track.license.downloadAllowed === "boolean" && typeof track.license.conversionAllowed === "boolean" &&
    (track.license.attribution === undefined || typeof track.license.attribution === "string") &&
    (track.license.url === undefined || (typeof track.license.url === "string" && /^https:\/\//.test(track.license.url)));
}
