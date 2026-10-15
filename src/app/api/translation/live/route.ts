import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, errorResponse } from "@/lib/errors";
import { guardRequest, limitedBody } from "@/lib/request";
import { ffmpeg, inputArgs, normalize, inspect } from "@/lib/translation/media";
import { optionsSchema } from "@/lib/translation/types";
import { resolveVoice, synthesize, transcribe, translate, validateOptions } from "@/lib/translation/providers";
import { boundedLiveContext } from "@/lib/translation/request-options";
export const runtime = "nodejs";
export const maxDuration = 300;
const globalLive = globalThis as typeof globalThis & { studioLiveActive?: number };
export async function POST(request: Request) {
  const receivedAt = performance.now();
  try {
    guardRequest(request, "studio-live", true);
    // Bound the complete request before asking the multipart parser to allocate.
    const body = await limitedBody(request, 2 * 1024 ** 2);
    const contentType = request.headers.get("content-type") || "";
    let raw: unknown; let bytes: Buffer; let context = "";
    if (/^multipart\/form-data(?:;|$)/i.test(contentType)) {
      let form: FormData;
      try { form = await new Response(new Uint8Array(body), { headers: { "Content-Type": contentType } }).formData(); }
      catch { throw new AppError("Live-blocket innehåller ogiltiga formulärdata."); }
      if ([...form.keys()].some((key) => !["options", "context", "audio"].includes(key)) || form.getAll("options").length !== 1 || form.getAll("audio").length !== 1 || form.getAll("context").length > 1) throw new AppError("Live-blocket har ogiltiga eller upprepade fält.");
      const metadata = form.get("options"); const prior = form.get("context"); const audio = form.get("audio");
      if (typeof metadata !== "string" || new TextEncoder().encode(metadata).byteLength > 128 * 1024 || (prior !== null && typeof prior !== "string")) throw new AppError("Live-inställningarna är ogiltiga.");
      try { raw = JSON.parse(metadata); } catch { throw new AppError("Live-inställningarna är ogiltiga."); }
      if (!(audio instanceof Blob) || !audio.size || !["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"].includes(audio.type.toLowerCase().split(";", 1)[0])) throw new AppError("Live-blocket måste innehålla WAV-ljud.", 415);
      bytes = Buffer.from(await audio.arrayBuffer()); context = boundedLiveContext(prior || "");
    } else {
      // Existing small raw-WAV clients remain supported.
      const metadata = request.headers.get("x-studio-options") || ""; const prior = request.headers.get("x-studio-context") || "";
      if (metadata.length + prior.length > 12_000) throw new AppError("Använd formulärdata för större live-inställningar.", 413);
      try { raw = JSON.parse(decodeURIComponent(metadata)); context = boundedLiveContext(decodeURIComponent(prior)); } catch { throw new AppError("Live-inställningarna är ogiltiga."); }
      bytes = body;
    }
    const parsed = optionsSchema.safeParse(raw); if (!parsed.success) throw new AppError("Välj giltiga språk och bekräfta dina rättigheter.");
    const options = parsed.data;
    if (options.targets.length !== 1 || options.preserveVoice || options.diarize || options.preserveBackground) throw new AppError("Live använder ett målspråk och en AI-standardröst.");
    const caps = await validateOptions(options);
    if ((globalLive.studioLiveActive || 0) >= 2) throw new AppError("Live-bearbetningen är upptagen.", 429);
    globalLive.studioLiveActive = (globalLive.studioLiveActive || 0) + 1;
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
            const asrStarted = performance.now();
            const result = await transcribe(normalized, options.source, signal);
            send({ type: "timing", stage: "asr-final", elapsedMs: Math.round(performance.now() - receivedAt), durationMs: Math.round(performance.now() - asrStarted) });
            if (result.segments.some((s) => s.uncertain || (s.avg_logprob !== undefined && s.avg_logprob < -1) || (s.no_speech_prob || 0) > 0.5)) throw new AppError("Talet är osäkert. Spela in en fil och granska transkriptet före dubbning.", 422);
            const segments = result.segments.filter((s) => s.text.trim() && (s.no_speech_prob || 0) <= 0.8).map((s, n) => ({ id: `s${n + 1}`, start: s.start, end: s.end, text: s.text, speaker: "unknown" }));
            if (!segments.length) { send({ type: "silence", processingMs: Date.now() - started }); return; }
            send({ type: "transcript", text: segments.map((s) => s.text).join(" "), language: result.language });
            const translationStarted = performance.now();
            const translated = await translate(segments, options.targets[0], options, context, signal);
            const text = translated.map((s) => s.text).join(" "); if (text.length > 4000) throw new AppError("Live-översättningen blev för lång.", 422);
            send({ type: "translation", text });
            send({ type: "timing", stage: "translation-final", elapsedMs: Math.round(performance.now() - receivedAt), durationMs: Math.round(performance.now() - translationStarted) });
            const ttsStarted = performance.now();
            const audio = await synthesize(text, options.targets[0], resolveVoice(options.targets[0], options, caps), signal, undefined, options);
            const output = path.join(dir, "speech.wav"); await writeFile(output, audio);
            const { speechDuration } = await import("@/lib/translation/media"); await speechDuration(output, signal);
            const rendered = path.join(dir, "playback.wav");
            await ffmpeg([...inputArgs(output), "-af", `atempo=${options.speechRate},loudnorm=I=-16:TP=-1.5:LRA=11`, "-c:a", "pcm_s16le", rendered], signal);
            send({ type: "timing", stage: "tts-ready", elapsedMs: Math.round(performance.now() - receivedAt), durationMs: Math.round(performance.now() - ttsStarted) });
            send({ type: "audio", audio: (await readFile(rendered)).toString("base64"), processingMs: Date.now() - started });
          } catch (e) { if (!signal.aborted) send({ type: "error", error: e instanceof AppError ? e.message : "Live-bearbetningen misslyckades." }); }
          finally { globalLive.studioLiveActive = Math.max(0, (globalLive.studioLiveActive || 1) - 1); if (dir) await rm(dir, { recursive: true, force: true }); if (!signal.aborted) controller.close(); }
        })();
      },
      cancel() { abort.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  } catch (e) { return errorResponse(e); }
}
