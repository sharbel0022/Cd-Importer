import { describe, expect, it } from "vitest";
import { liveCapture, liveElapsed, liveQueueDelay, liveTiming } from "@/lib/translation/live-metrics";

describe("measured block translation latency", () => {
  it("uses actual captured samples instead of assuming every block lasted four seconds", () => {
    const full = liveCapture(1, 64000, 16000, 10000); const partial = liveCapture(2, 24000, 16000, 15000);
    expect(full.captureMs).toBe(4000); expect(partial.captureMs).toBe(1500);
    expect(liveElapsed(full, 11250)).toBe(5250); expect(liveElapsed(partial, 15750)).toBe(2250);
  });
  it("measures queue delay separately from capture and includes both in audible latency", () => {
    const capture = liveCapture(1, 64000, 16000, 1000);
    expect(liveQueueDelay(capture, 3500)).toBe(2500);
    expect(liveElapsed(capture, 6000)).toBe(9000);
  });
  it("does not create negative queue delay or negative post-capture time", () => {
    const capture = liveCapture(1, 16000, 16000, 1000);
    expect(liveQueueDelay(capture, 999)).toBe(0); expect(liveElapsed(capture, 999)).toBe(1000);
  });
  it("rejects invalid capture metadata", () => {
    expect(() => liveCapture(0, 16000, 16000, 0)).toThrow(); expect(() => liveCapture(1, 0, 16000, 0)).toThrow();
    expect(() => liveCapture(1, 16000, 0, 0)).toThrow(); expect(() => liveCapture(1, 16000, 16000, NaN)).toThrow();
  });
  it("accepts only finite known server timing stages, without manufacturing partial transcript times", () => {
    expect(liveTiming({ stage: "asr-final", elapsedMs: 1200, durationMs: 800 })).toEqual({ stage: "asr-final", elapsedMs: 1200, durationMs: 800 });
    expect(liveTiming({ stage: "partial", elapsedMs: 10, durationMs: 10 })).toBeUndefined();
    expect(liveTiming({ stage: "tts-ready", elapsedMs: Infinity, durationMs: 10 })).toBeUndefined();
    expect(liveTiming({ stage: "translation-final", elapsedMs: 10, durationMs: -1 })).toBeUndefined();
  });
});
