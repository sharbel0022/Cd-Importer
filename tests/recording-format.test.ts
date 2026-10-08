import { describe, expect, it } from "vitest";
import { microphoneError, recordingExtension, selectRecordingMime } from "@/lib/recording-format";
import { isStoredRecording, MAX_RECORDINGS, MAX_STORAGE_BYTES } from "@/lib/recordings-store";

describe("browser recording formats", () => {
  it("prefers supported WebM Opus, otherwise a supported real container", () => {
    expect(selectRecordingMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(selectRecordingMime((mime) => mime === "audio/mp4")).toBe("audio/mp4");
    expect(selectRecordingMime((mime) => mime === "audio/ogg;codecs=opus")).toBe("audio/ogg;codecs=opus");
    expect(selectRecordingMime(() => false)).toBeUndefined();
  });
  it.each([["audio/webm;codecs=opus", "webm"], ["audio/mp4;codecs=mp4a.40.2", "m4a"], ["audio/x-m4a", "m4a"], ["audio/ogg;codecs=opus", "ogg"], [" AUDIO/WEBM ", "webm"]])("preserves container for %s", (mime, extension) => {
    expect(recordingExtension(mime)).toBe(extension);
  });
  it.each(["", "audio/mpeg", "video/webm", "text/html", "audio/wav"])("refuses unsupported capture container %s instead of renaming it", (mime) => {
    expect(() => recordingExtension(mime)).toThrow("inspelningsformat");
  });
  it("gives actionable microphone failures", () => {
    expect(microphoneError({ name: "NotAllowedError" })).toContain("nekades");
    expect(microphoneError({ name: "NotFoundError" })).toContain("Ingen mikrofon");
    expect(microphoneError({ name: "NotReadableError" })).toContain("andra appar");
    expect(microphoneError({ name: "SecurityError" })).toContain("HTTPS");
    expect(microphoneError(undefined)).toContain("Kontrollera mikrofonen");
  });
});

describe("persisted recordings", () => {
  const valid = { id: "recording-1", title: "Min idé", filename: "Min idé.mp3", createdAt: 1, duration: 3, bitrate: 192, blob: new Blob(["MP3 data"], { type: "audio/mpeg" }) };
  it("accepts bounded MP3 recording metadata", () => {
    expect(isStoredRecording(valid)).toBe(true);
    expect(MAX_RECORDINGS).toBe(20);
    expect(MAX_STORAGE_BYTES).toBe(100 * 1024 * 1024);
  });
  it.each([{ blob: new Blob([]) }, { blob: new Blob(["raw"], { type: "audio/webm" }) }, { filename: "audio.webm" }, { duration: NaN }, { title: "" }, { title: "x".repeat(151) }, { bitrate: 500 }, { id: "" }])("refuses invalid persisted record %o", (invalid) => {
    expect(isStoredRecording({ ...valid, ...invalid })).toBe(false);
  });
});
