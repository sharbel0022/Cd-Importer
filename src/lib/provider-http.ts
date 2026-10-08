import { AppError } from "./errors";

const MAX_JSON_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 12_000;

export function providerUserAgent(): string {
  const configured = typeof process !== "undefined" ? process.env.MUSIC_USER_AGENT?.trim() : undefined;
  return configured && configured.length <= 240 && !/[\r\n]/.test(configured)
    ? configured
    : "Cd-Importer/1.0 (Music search; https://github.com/sharbel0022/Cd-Importer)";
}

/** Only our two fixed official APIs are allowed. API responses cannot redirect to other hosts. */
export function assertProviderApiUrl(value: URL): void {
  const archive = value.hostname === "archive.org"
    && (value.pathname === "/advancedsearch.php" || /^\/metadata\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.pathname));
  const commons = value.hostname === "commons.wikimedia.org" && value.pathname === "/w/api.php";
  if (value.protocol !== "https:" || value.username || value.password || value.port || value.hash || !(archive || commons)) {
    throw new AppError("Ogiltig adress till musikkällan.", 400);
  }
}

/** Limit the actual streamed body as well as Content-Length; a server may omit or lie about its size. */
async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > MAX_JSON_BYTES) throw new AppError("Musikkällans metadata är för stor.", 502);
  if (!response.body) throw new AppError("Musikkällan returnerade ett tomt svar.", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON_BYTES) throw new AppError("Musikkällans metadata är för stor.", 502);
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    let position = 0;
    for (const chunk of chunks) { body.set(chunk, position); position += chunk.byteLength; }
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new AppError("Musikkällan returnerade ogiltig metadata.", 502);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function providerJson(url: URL): Promise<unknown> {
  assertProviderApiUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": providerUserAgent() },
    });
    if (response.status === 429 || response.status === 503) {
      await response.body?.cancel();
      throw new AppError("Musikkällan är tillfälligt upptagen eller begränsar antalet anrop. Försök igen om en stund.", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(response.status === 404 ? "Filen finns inte längre hos musikkällan." : "Musikkällan kunde inte nås. Försök igen senare.", response.status === 404 ? 404 : 502);
    }
    return await readBoundedJson(response);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(controller.signal.aborted ? "Musikkällan svarade inte i tid. Försök igen." : "Ett nätverksfel uppstod när musikkällan kontaktades.", 502);
  } finally {
    clearTimeout(timeout);
  }
}
