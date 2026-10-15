export type LiveServerStage = "asr-final" | "translation-final" | "tts-ready";
export interface LiveServerTiming { stage: LiveServerStage; elapsedMs: number; durationMs: number }
export interface LiveBlockMetrics {
  id: number; captureMs: number; queueMs?: number;
  transcriptMs?: number; translationMs?: number; audioReadyMs?: number; audibleMs?: number;
  server?: Partial<Record<LiveServerStage, { elapsedMs: number; durationMs: number }>>;
}
export interface LiveCapture { id: number; capturedAt: number; captureMs: number }
export function liveCapture(id: number, sampleCount: number, sampleRate: number, capturedAt: number): LiveCapture {
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(sampleCount) || sampleCount < 1 || !(sampleRate > 0) || !Number.isFinite(sampleRate + capturedAt)) throw new Error("Ogiltig liveinspelning.");
  return { id, capturedAt, captureMs: sampleCount / sampleRate * 1000 };
}
export function liveElapsed(capture: LiveCapture, now: number) {
  return Math.round(Math.max(0, now - capture.capturedAt) + capture.captureMs);
}
export function liveQueueDelay(capture: LiveCapture, requestAt: number) { return Math.round(Math.max(0, requestAt - capture.capturedAt)); }
export function liveTiming(value: unknown): LiveServerTiming | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  if (!["asr-final", "translation-final", "tts-ready"].includes(String(candidate.stage)) || typeof candidate.elapsedMs !== "number" || typeof candidate.durationMs !== "number" || !Number.isFinite(candidate.elapsedMs + candidate.durationMs) || candidate.elapsedMs < 0 || candidate.durationMs < 0) return;
  return { stage: candidate.stage as LiveServerStage, elapsedMs: candidate.elapsedMs, durationMs: candidate.durationMs };
}
