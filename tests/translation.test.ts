import { describe, expect, it } from "vitest";
import { optionsSchema, subtitles, timingPlan, type Segment } from "@/lib/translation/types";
import { assignSpeakers, phraseSegments, safeChunkPlan, speechWindow } from "@/lib/translation/pipeline";
import { jobDir } from "@/lib/translation/store";
import { wavBlob } from "@/lib/translation/client";

describe("translation validation and synchronization", () => {
  it("requires rights and supported, unique target languages", () => {
    expect(optionsSchema.safeParse({ targets: ["sv"], rights: false }).success).toBe(false);
    expect(optionsSchema.safeParse({ targets: ["sv", "sv"], rights: true }).success).toBe(false);
    expect(optionsSchema.safeParse({ targets: ["xx"], rights: true }).success).toBe(false);
    expect(optionsSchema.parse({ targets: ["sv", "en", "ar"], rights: true }).source).toBe("auto");
    expect(optionsSchema.parse({ targets: ["en"], rights: true })).toMatchObject({ voice: "auto", englishLocale: "en-US", speechRate: 1 });
    expect(optionsSchema.safeParse({ targets: ["en"], rights: true, speechRate: 1.5 }).success).toBe(false);
  });
  it("caps natural time stretching and flags oversize speech", () => {
    expect(timingPlan(3, 3).review).toBe(false);
    expect(timingPlan(3.6, 3).tempo).toBe(1.2);
    expect(timingPlan(6, 3)).toMatchObject({ tempo: 1.2, review: true, deviationMs: 2000 });
    expect(timingPlan(1, 3).tempo).toBe(1);
    expect(timingPlan(1, 3, 1.2, 0.9).tempo).toBe(0.9);
    expect(timingPlan(3.65, 3, 1.2).review).toBe(true);
    expect(() => timingPlan(0, 3)).toThrow();
  });
  it("rejects traversal and malformed job IDs", () => {
    for (const id of ["../secrets", "C:\\Windows", "f".repeat(36), "00000000-0000-0000-0000-000000000000"]) expect(() => jobDir(id)).toThrow();
  });
  it("groups fragments into phrases without crossing speakers or pauses, and borrows only silence", () => {
    const segments: Segment[] = [
      { id: "a", start: 0, end: 0.4, text: "Imagine", speaker: "A" },
      { id: "b", start: 0.4, end: 2, text: "being there", speaker: "A" },
      { id: "c", start: 2, end: 3.2, text: "yesterday.", speaker: "A" },
      { id: "d", start: 3.2, end: 4, text: "No", speaker: "B" },
      { id: "e", start: 5.5, end: 7, text: "Never", speaker: "B" },
    ];
    const phrases = phraseSegments(segments);
    expect(phrases).toHaveLength(3); expect(phrases[0].text).toBe("Imagine being there yesterday.");
    expect(segments[0].text).toBe("Imagine");
    expect(speechWindow(phrases, 0, 10)).toBe(3.2);
    expect(speechWindow(phrases, 1, 10)).toBeCloseTo(1.55);
    expect(speechWindow(phrases, 2, 7.2)).toBeCloseTo(1.7);
    expect(speechWindow([{ ...segments[0], start: 0, end: 2 }, { ...segments[1], start: 1, end: 3 }], 0, 3)).toBe(1);
  });
  it("exports precise SRT/VTT, escapes cue injection and preserves RTL text", () => {
    const source: Segment[] = [{ id: "s1", start: 3723.456, end: 3724.9996, speaker: "A", text: "مرحبا" }];
    const result = subtitles(source, [{ id: "s1", text: "<b>Hej</b>\n\n00:00 --> 99:00" }], "srt");
    expect(result).toContain("01:02:03,456 --> 01:02:05,000"); expect(result).not.toContain("<b>"); expect(result.match(/-->/g)).toHaveLength(1);
    expect(subtitles(source, [], "vtt")).toContain("WEBVTT\n\n1\n01:02:03.456"); expect(subtitles(source, [], "vtt")).toContain("مرحبا");
  });
  it("chunks long audio at nearby silence without gaps and flags unavoidable hard boundaries", () => {
    expect(safeChunkPlan(130, 60, [52, 58, 111])).toEqual([{ start: 0, duration: 58, hardBoundary: false }, { start: 58, duration: 53, hardBoundary: false }, { start: 111, duration: 19, hardBoundary: false }]);
    expect(safeChunkPlan(65, 60, [])).toEqual([{ start: 0, duration: 60, hardBoundary: true }, { start: 60, duration: 5, hardBoundary: false }]);
  });
  it("splits speakers at word boundaries and marks ambiguous overlap", () => {
    const source: Segment[] = [{ id: "s1", start: 0, end: 4, speaker: "unknown", text: "hello there", words: [{ start: 0, end: 1, word: "hello" }, { start: 2, end: 3, word: "there" }] }];
    const result = assignSpeakers(source, [{ start: 0, end: 1.5, speaker: "A" }, { start: 1.8, end: 4, speaker: "B" }]);
    expect(result.map((s) => s.speaker)).toEqual(["A", "B"]); expect(result.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(assignSpeakers(source, [{ start: 0, end: 4, speaker: "A" }, { start: 0, end: 4, speaker: "B" }])[0].uncertain).toBe(true);
  });
  it("creates independently decodable 16 kHz microphone blocks", async () => {
    const bytes = Buffer.from(await wavBlob(new Int16Array([0, 1000, -1000])).arrayBuffer());
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF"); expect(bytes.readUInt32LE(24)).toBe(16000); expect(bytes.readInt16LE(48)).toBe(-1000);
  });
});
