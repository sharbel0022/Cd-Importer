import https from "node:https";
import { lookup as resolveDns } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { AppError } from "./errors";
import { providerUserAgent } from "./provider-http";

const MEDIA_HOST = /^(?:archive\.org|ia\d+\.(?:us|eu)\.archive\.org|dn\d+\.ca\.archive\.org|upload\.wikimedia\.org)$/;
const configuredRemoteMb = Number(process.env.MAX_REMOTE_MB ?? 50);
export const MAX_REMOTE_BYTES = (Number.isFinite(configuredRemoteMb) ? Math.min(100, Math.max(1, configuredRemoteMb)) : 50) * 1024 * 1024;

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

function ipv6Parts(address: string): number[] | null {
  if (address.includes("%")) return null;
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const octets = normalized.slice(lastColon + 1).split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255 || !Number.isInteger(octet))) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").map((x) => parseInt(x, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").map((x) => parseInt(x, 16)) : [];
  const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
  return parts.length === 8 && parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 65535) ? parts : null;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const parts = ipv6Parts(address);
    if (!parts) return false;
    // Accept current global unicast only. Reject mapped addresses, local ranges,
    // documentation networks, transition protocols and IANA special-use space.
    return parts[0] >= 0x2000 && parts[0] <= 0x3fff &&
      !(parts[0] === 0x2001 && (parts[1] < 0x0200 || parts[1] === 0x0db8)) &&
      parts[0] !== 0x2002 && !(parts[0] === 0x3fff && parts[1] < 0x1000);
  }
  return false;
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

export interface SafeAudioResponse {
  bytes: Buffer;
  status: number;
  contentType: string;
  contentRange?: string;
  acceptRanges?: string;
  url: string;
}

export async function safeAudioFetch(input: string, options: {
  range?: string; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<SafeAudioResponse> {
  const maxBytes = Math.min(options.maxBytes ?? MAX_REMOTE_BYTES, MAX_REMOTE_BYTES);
  const deadline = Date.now() + Math.min(options.timeoutMs ?? 45_000, 90_000);
  const range = validateRange(options.range ?? null);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  try {
    let url = validateMediaUrl(input);
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (controller.signal.aborted) throw new AppError("Hämtningen avbröts eller tog för lång tid.", 504);
      const addresses = await Promise.race([
        resolveDns(url.hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted) reject(new AppError("Ljudkällan svarade inte i tid.", 504));
          else controller.signal.addEventListener("abort", () => reject(new AppError("Ljudkällan svarade inte i tid.", 504)), { once: true });
        }),
      ]);
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new AppError("Ljudkällan kunde inte verifieras säkert.", 502);
      }
      const pinned = addresses.find((entry) => entry.family === 4) ?? addresses[0];
      const result = await new Promise<SafeAudioResponse | { redirect: string }>((resolve, reject) => {
        const request = https.request(url, {
          method: "GET", signal: controller.signal, family: pinned.family,
          lookup: ((_hostname, _options, callback) => callback(null, pinned.address, pinned.family)) as LookupFunction,
          headers: { "User-Agent": providerUserAgent(), Accept: "audio/*,application/octet-stream;q=0.8", ...(range ? { Range: range } : {}) },
        }, (response) => {
          const status = response.statusCode ?? 502;
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = response.headers.location;
            response.destroy();
            if (!location) reject(new AppError("Ljudkällan gav en ogiltig omdirigering.", 502));
            else resolve({ redirect: location });
            return;
          }
          if (status !== 200 && status !== 206) {
            response.destroy();
            reject(new AppError(status === 404 ? "Ljudfilen finns inte längre hos källan." : status === 416 ? "Ljudintervallet finns inte." : "Ljudkällan kunde inte leverera filen. Försök igen senare.", status === 416 ? 416 : 502));
            return;
          }
          const length = Number(response.headers["content-length"]);
          if (Number.isFinite(length) && length > maxBytes) {
            response.destroy(); reject(new AppError("Ljudfilen är för stor. Använd länken till originalkällan.", 413)); return;
          }
          const type = (response.headers["content-type"] ?? "application/octet-stream").split(";")[0].toLowerCase();
          if (type.includes("mpegurl") || type.includes("dash") || (!type.startsWith("audio/") && !["application/octet-stream", "application/ogg", "video/ogg", "video/webm"].includes(type))) {
            response.destroy(); reject(new AppError("Källan levererade ingen ljudfil.", 502)); return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) response.destroy(new AppError("Ljudfilen är för stor. Använd originalkällan.", 413));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            if (!size) { reject(new AppError("Ljudfilen är tom.", 502)); return; }
            if (Number.isFinite(length) && length > 0 && length !== size) { reject(new AppError("Ljudfilen kunde inte hämtas fullständigt.", 502)); return; }
            let contentRange: string | undefined;
            try {
              if (status === 206) contentRange = validateContentRange(response.headers["content-range"], range, size);
              const bytes = Buffer.concat(chunks);
              const beginsAtStart = status === 200 || !!contentRange?.startsWith("bytes 0-");
              if (beginsAtStart && looksLikeDocument(bytes)) throw new AppError("Källan levererade ett dokument eller en spellista i stället för ljud.", 502);
              resolve({ bytes, status, contentType: type, contentRange,
                acceptRanges: response.headers["accept-ranges"], url: url.toString() });
            } catch (error) { reject(error); }
          });
        });
        request.on("error", reject);
        request.end();
      });
      if (!("redirect" in result)) return result;
      if (redirects === 4) throw new AppError("Ljudkällan omdirigerade för många gånger.", 502);
      url = validateMediaRedirect(result.redirect, url);
    }
    throw new AppError("Ljudfilen kunde inte hämtas.", 502);
  } catch (error) {
    if (options.signal?.aborted) throw new AppError("Hämtningen avbröts.", 400);
    if (error instanceof AppError) throw error;
    if (controller.signal.aborted) throw new AppError("Ljudkällan svarade inte i tid. Försök igen.", 504);
    throw new AppError("Ett nätverksfel uppstod vid hämtning av ljudfilen.", 502);
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
}
