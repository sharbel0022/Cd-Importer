import { z } from "zod";
import { isIP } from "node:net";
import { AppError } from "./errors";
import type { Bitrate, TrackRef } from "./types";

export function uploadLimitMb(): number {
  const value = Number(process.env.MAX_UPLOAD_MB || 100);
  return Number.isFinite(value) ? Math.max(1, Math.min(100, value)) : 100;
}

const refSchema = z.object({
  source: z.enum(["archive", "commons"]),
  id: z.string().min(1).max(300),
  file: z.string().min(1).max(500).optional(),
}).strict();

export function parseTrackRef(input: unknown): TrackRef {
  const value = input instanceof URLSearchParams ? Object.fromEntries(
    ["source", "id", "file"].flatMap(key => input.has(key) ? [[key, input.get(key)]] : [])
  ) : input;
  const result = refSchema.safeParse(value);
  if (!result.success) throw new AppError("Ogiltig låtreferens. Välj en låt från sökresultaten.", 400);
  const ref = result.data;
  if (ref.source === "archive" && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(ref.id) || !ref.file)) {
    throw new AppError("Ogiltig Internet Archive-referens.", 400);
  }
  if (ref.source === "commons" && (!ref.id.startsWith("File:") || ref.id.length < 6 || /[\u0000-\u001f\u007f]/.test(ref.id) || ref.file !== undefined)) {
    throw new AppError("Ogiltig Wikimedia Commons-referens.", 400);
  }
  if (ref.file && (/[\\\u0000-\u001f\u007f]/.test(ref.file) || ref.file.startsWith("/") || ref.file.split("/").some(segment => segment === "." || segment === ".." || !segment))) {
    throw new AppError("Ogiltigt filnamn från källan.", 400);
  }
  return ref;
}

export function parseBitrate(value: unknown = 192): Bitrate {
  const number = Number(value ?? 192);
  if (![128, 192, 256, 320].includes(number)) throw new AppError("Välj 128, 192, 256 eller 320 kbps.", 400);
  return number as Bitrate;
}

export function parseSearch(params: URLSearchParams): { query: string; source: "all" | "archive" | "commons"; page: number; licensedOnly: boolean } {
  const query = (params.get("q") || "").trim().replace(/\s+/g, " ");
  if (query.length < 2 || query.length > 120 || /[\u0000-\u001f\u007f]/.test(query)) throw new AppError("Sökningen måste innehålla 2–120 tecken.", 400);
  const source = params.get("source") || "all";
  if (!["all", "archive", "commons"].includes(source)) throw new AppError("Välj en giltig musikkälla.", 400);
  const rawPage = params.get("page") || "1";
  if (!/^\d+$/.test(rawPage) || Number(rawPage) < 1 || Number(rawPage) > 50) throw new AppError("Ogiltig resultatsida.", 400);
  const licensed = params.get("licensedOnly") ?? "false";
  if (licensed !== "true" && licensed !== "false") throw new AppError("Ogiltigt licensfilter.", 400);
  return { query, source: source as "all" | "archive" | "commons", page: Number(rawPage), licensedOnly: licensed === "true" };
}

const windows = new Map<string, { count: number; reset: number }>();
const limits: Record<string, number> = { search: 30, audio: 120, download: 20, batch: 6, convert: 8, status: 60 };

/** Local single-process app: a bounded global budget, no trust in forwarded IP headers. */
export function guardRequest(request: Request, bucket: string, mutation = false): void {
  if (mutation) {
    const origin = request.headers.get("origin");
    const requestUrl = new URL(request.url);
    const origins = new Set([requestUrl.origin]);
    // Next may build Request.url with localhost even when the browser used the
    // loopback/LAN IP. Only the actual Host header can supply a local alias;
    // untrusted forwarded headers and arbitrary domain aliases are ignored.
    const host = request.headers.get("host");
    if (host) {
      try {
        const local = new URL(`${requestUrl.protocol}//${host}`);
        const hostname = local.hostname.replace(/^\[|\]$/g, "");
        const samePort = local.port === requestUrl.port;
        if (samePort && !local.username && !local.password && local.pathname === "/" && !local.search && !local.hash &&
          (hostname === "localhost" || isIP(hostname))) origins.add(local.origin);
      } catch { /* Invalid Host is never an accepted origin. */ }
    }
    if (origin && !origins.has(origin)) throw new AppError("Förfrågan måste komma från appens egen sida.", 403);
    if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("Förfrågan från en annan webbplats är inte tillåten.", 403);
  }
  const now = Date.now();
  for (const [key, entry] of windows) if (entry.reset <= now) windows.delete(key);
  const entry = windows.get(bucket) || { count: 0, reset: now + 60_000 };
  if (entry.count >= (limits[bucket] || 20)) throw new AppError("För många förfrågningar. Vänta en minut och försök igen.", 429);
  entry.count++;
  windows.set(bucket, entry);
}

/** Streamed read with a hard cap; Content-Length is never trusted as the sole limit. */
export async function limitedBody(request: Request, maxBytes: number): Promise<Buffer> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new AppError("Filen eller förfrågan är för stor.", 413);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel("timeout").catch(() => undefined); }, 60_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError("Filen eller förfrågan är för stor.", 413);
      }
      chunks.push(value);
    }
    if (timedOut) throw new AppError("Överföringen tog för lång tid. Försök igen.", 408);
    if (request.signal.aborted) throw new AppError("Överföringen avbröts.", 400);
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

export async function boundedJson(request: Request, maxBytes = 16_384): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AppError("Förfrågan måste vara JSON.", 415);
  const body = await limitedBody(request, maxBytes);
  try { return JSON.parse(body.toString("utf8")) as unknown; }
  catch { throw new AppError("Förfrågan innehåller ogiltig JSON.", 400); }
}
