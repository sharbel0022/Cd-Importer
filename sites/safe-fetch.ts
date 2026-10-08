import { AppError } from "../src/lib/errors";
import { providerUserAgent } from "../src/lib/provider-http";
import { validateMediaUrl, validateMediaRedirect, validateRange, validateContentRange, looksLikeDocument } from "../src/lib/media-policy";
export const MAX_REMOTE_BYTES = 20 * 1024 * 1024;

/** Only fresh official-source URLs, with every redirect checked before fetch. */
export async function fetchAudio(input: string, signal: AbortSignal, requestedRange?: string) {
  const range = validateRange(requestedRange ?? null);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 45_000);
  try {
    let url = validateMediaUrl(input);
    for (let redirects = 0; redirects <= 4; redirects++) {
      const response = await fetch(url, { redirect: "manual", signal: controller.signal,
        headers: { Accept: "audio/*,application/octet-stream;q=0.8", "User-Agent": providerUserAgent(), ...(range ? { Range: range } : {}) } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === 4) throw new AppError("Ljudkällan gav för många eller ogiltiga omdirigeringar.", 502);
        url = validateMediaRedirect(location, url); continue;
      }
      if (![200, 206].includes(response.status)) {
        await response.body?.cancel();
        throw new AppError(response.status === 404 ? "Ljudfilen finns inte längre hos källan." : "Ljudkällan kunde inte lämna ut filen. Försök igen senare.", response.status === 404 ? 404 : 502);
      }
      if (!response.body) throw new AppError("Ljudfilen är tom.", 502);
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        if (Number(response.headers.get("content-length")) > MAX_REMOTE_BYTES) throw new AppError("Filen är större än Sites-gränsen på 20 MB. Använd originalkällan eller den lokala appen.", 413);
        while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
          if (size > MAX_REMOTE_BYTES) throw new AppError("Filen är större än 20 MB. Använd originalkällan.", 413); chunks.push(next.value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim() || "application/octet-stream";
      const contentRange = response.status === 206 ? validateContentRange(response.headers.get("content-range") ?? undefined, range, size) : undefined;
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && !response.headers.get("content-encoding") && Number(declaredLength) !== size) throw new AppError("Ljudfilen är ofullständig. Försök igen.", 502);
      const audioType = /^audio\//i.test(contentType) || ["application/octet-stream", "application/ogg", "video/mp4", "video/webm"].includes(contentType.toLowerCase());
      const beginsAtStart = response.status === 200 || !contentRange || /^bytes 0-/.test(contentRange);
      if (!size || !audioType || (beginsAtStart && looksLikeDocument(bytes))) throw new AppError("Källan skickade inte en giltig ljudfil.", 502);
      return { bytes, status: response.status, contentType, contentRange };
    }
    throw new AppError("Ljudfilen kunde inte hämtas.", 502);
  } catch (error) {
    if (controller.signal.aborted) throw new AppError("Ljudkällan svarade inte i tid eller hämtningen avbröts.", 504);
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
