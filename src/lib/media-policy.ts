import { AppError } from "./errors";
const MEDIA_HOST = /^(?:archive\.org|ia\d+\.(?:us|eu)\.archive\.org|dn\d+\.ca\.archive\.org|upload\.wikimedia\.org)$/;

/** The URL must come from fresh provider metadata, never from a request body. */
function validateMediaPath(input: string): void {
  const rawPath = input.split(/[?#]/, 1)[0].replace(/^https?:\/\/[^/]+/i, "");
  let decodedPath = rawPath;
  for (let i = 0; i < 8; i++) {
    try { const decoded = decodeURIComponent(decodedPath); if (decoded === decodedPath) break; decodedPath = decoded; }
    catch { throw new AppError("Ljudkällans sökväg är ogiltig.", 502); }
  }
  if (decodedPath.includes("\\") || /[\x00-\x1f\x7f]/.test(decodedPath) || decodedPath.split("/").some((part) => part === ".." || part === ".")) {
    throw new AppError("Ljudkällans sökväg är inte tillåten.", 502);
  }
}

export function validateMediaUrl(input: string | URL): URL {
  validateMediaPath(input instanceof URL ? input.pathname : input);
  let url: URL;
  try { url = new URL(input); } catch { throw new AppError("Ljudkällans adress är ogiltig.", 502); }
  if (url.protocol !== "https:" || !MEDIA_HOST.test(url.hostname) ||
      url.username || url.password || url.hash || (url.port && url.port !== "443")) {
    throw new AppError("Ljudkällans adress är inte tillåten.", 502);
  }
  if (url.hostname === "archive.org" && !url.pathname.startsWith("/download/")) {
    throw new AppError("Endast Internet Archives ljudfiler får hämtas.", 502);
  }
  if (url.hostname === "upload.wikimedia.org" && !url.pathname.startsWith("/wikipedia/commons/")) {
    throw new AppError("Endast filer från Wikimedia Commons får hämtas.", 502);
  }
  if (url.hostname !== "archive.org" && url.hostname !== "upload.wikimedia.org" && !/^\/\d+\/items\//.test(url.pathname)) {
    throw new AppError("Internet Archives lagringsadress är inte tillåten.", 502);
  }
  return url;
}

export function validateRange(range: string | null): string | undefined {
  if (!range) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) throw new AppError("Tidsintervallet är ogiltigt.", 416);
  const start = match[1] ? Number(match[1]) : undefined;
  const end = match[2] ? Number(match[2]) : undefined;
  if ((start !== undefined && !Number.isSafeInteger(start)) || (end !== undefined && !Number.isSafeInteger(end)) ||
      (start !== undefined && end !== undefined && end < start) || (start === undefined && end === 0)) {
    throw new AppError("Tidsintervallet är ogiltigt.", 416);
  }
  return range;
}

export function validateMediaRedirect(location: string, current: string | URL): URL {
  validateMediaPath(location);
  let url: URL;
  try { url = new URL(location, current); }
  catch { throw new AppError("Ljudkällan gav en ogiltig omdirigering.", 502); }
  return validateMediaUrl(url);
}

export function validateContentRange(contentRange: string | undefined, range: string | undefined, size: number): string {
  const match = contentRange && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  if (!range || !match) throw new AppError("Ljudkällan returnerade ett ogiltigt ljudintervall.", 502);
  const [start, end, total] = match.slice(1).map(Number);
  const requested = /^bytes=(\d*)-(\d*)$/.exec(range)!;
  const requestedStart = requested[1] ? Number(requested[1]) : undefined;
  const requestedEnd = requested[2] ? Number(requested[2]) : undefined;
  if (![start, end, total].every(Number.isSafeInteger) || end < start || end >= total || size !== end - start + 1 ||
      (requestedStart !== undefined && start !== requestedStart) ||
      (requestedStart !== undefined && requestedEnd !== undefined && end > requestedEnd) ||
      (requestedStart === undefined && (end !== total - 1 || size > requestedEnd!))) {
    throw new AppError("Ljudkällan returnerade ett ogiltigt ljudintervall.", 502);
  }
  return contentRange!;
}

export function looksLikeDocument(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  return /^(?:<|[\[{]|#EXTM3U)/i.test(prefix);
}

