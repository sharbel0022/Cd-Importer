import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, errorResponse } from "@/lib/errors";
import { guardRequest, limitedBody } from "@/lib/request";
import { normalize, inspect } from "@/lib/translation/media";
import { optionsSchema } from "@/lib/translation/types";
import { synthesize, transcribe, translate, validateOptions } from "@/lib/translation/providers";
export const runtime = "nodejs";
export const maxDuration = 300;
const globalLive = globalThis as typeof globalThis & { studioLiveActive?: number };
export async function POST(request: Request) {
  try {
    guardRequest(request, "studio-live", true);
    let raw: unknown; try { raw = JSON.parse(decodeURIComponent(request.headers.get("x-studio-options") || "")); } catch { throw new AppError("Live-inställningarna är ogiltiga."); }
    const parsed = optionsSchema.safeParse(raw); if (!parsed.success) throw new AppError("Välj giltiga språk och bekräfta dina rättigheter.");
    const options = parsed.data;
    if (options.targets.length !== 1 || options.preserveVoice || options.diarize || options.preserveBackground) throw new AppError("Live använder ett målspråk och en AI-standardröst.");
    await validateOptions(options);
    if ((globalLive.studioLiveActive || 0) >= 2) throw new AppError("Live-bearbetningen är upptagen.", 429);
    globalLive.studioLiveActive = (globalLive.studioLiveActive || 0) + 1;
    let bytes: Buffer;
    try { bytes = await limitedBody(request, 2 * 1024 ** 2); } catch (e) { globalLive.studioLiveActive--; throw e; }
    const abort = new AbortController(); const signal = AbortSignal.any([abort.signal, request.signal]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const send = (value: unknown) => { signal.throwIfAborted(); controller.enqueue(encoder.encode(JSON.stringify(value) + "\n")); };
        void (async () => {
          let dir: string | undefined; const started = Date.now();
          try {
            dir = await mkdtemp(path.join(os.tmpdir(), "cd-live-")); const source = path.join(dir, "input.wav"); const normalized = path.join(dir, "normalized.wav");
            await writeFile(source, bytes); const info = await inspect(source, signal); if (info.duration > 12) throw new AppError("Ett liveblock får vara högst 12 sekunder.", 413);
            await normalize(source, normalized, signal, 12);
            const result = await transcribe(normalized, options.source, signal);
            const segments = result.segments.filter((s) => s.text.trim() && (s.no_speech_prob || 0) <= 0.8).map((s, n) => ({ id: `s${n + 1}`, start: s.start, end: s.end, text: s.text, speaker: "unknown" }));
            if (!segments.length) { send({ type: "silence", processingMs: Date.now() - started }); return; }
            send({ type: "transcript", text: segments.map((s) => s.text).join(" "), language: result.language });
            const translated = await translate(segments, options.targets[0], options, decodeURIComponent(request.headers.get("x-studio-context") || "").slice(-2000), signal);
            const text = translated.map((s) => s.text).join(" "); if (text.length > 4000) throw new AppError("Live-översättningen blev för lång.", 422);
            send({ type: "translation", text });
            const audio = await synthesize(text, options.targets[0], options.voice, signal);
            const output = path.join(dir, "speech.wav"); await writeFile(output, audio);
            const { speechDuration } = await import("@/lib/translation/media"); await speechDuration(output, signal);
            send({ type: "audio", audio: audio.toString("base64"), processingMs: Date.now() - started });
          } catch (e) { if (!signal.aborted) send({ type: "error", error: e instanceof AppError ? e.message : "Live-bearbetningen misslyckades." }); }
          finally { globalLive.studioLiveActive = Math.max(0, (globalLive.studioLiveActive || 1) - 1); if (dir) await rm(dir, { recursive: true, force: true }); if (!signal.aborted) controller.close(); }
        })();
      },
      cancel() { abort.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  } catch (e) { return errorResponse(e); }
}
