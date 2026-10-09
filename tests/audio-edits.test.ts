import { describe, expect, it } from "vitest";
import { audioEditArguments, editedDuration, parseAudioCuts } from "../src/lib/audio-edits";

describe("audio cut validation", () => {
  it("merges overlaps and touching cuts without double-counting duration", () => {
    const cuts = parseAudioCuts('[{"start":4,"end":6},{"start":1,"end":3},{"start":2,"end":4}]');
    expect(cuts).toEqual([{ start: 1, end: 6 }]);
    expect(editedDuration(10, cuts)).toBe(5);
    expect(editedDuration(3, cuts)).toBe(1);
    expect(editedDuration(0.5, cuts)).toBe(0.5);
  });
  it.each(["bad JSON", "{}", "null", [{ start: "1", end: 2 }], [{ start: -1, end: 2 }], [{ start: 2, end: 1 }], [{ start: 0, end: 0 }], [{ start: 0, end: Infinity }], [{ start: NaN, end: 2 }], [{ start: 0, end: 86401 }], [{ start: "0;amovie=http://localhost", end: 1 }], new Blob(["[]"])])("rejects invalid or injectable cut data: %j", value => {
    expect(() => parseAudioCuts(value)).toThrow();
  });
  it("bounds filter complexity and request size", () => {
    expect(() => parseAudioCuts(Array.from({ length: 33 }, (_, start) => ({ start, end: start + 0.5 })))).toThrow();
    expect(() => parseAudioCuts(" ".repeat(8193))).toThrow();
  });
  it("preserves ordinary conversion when cuts are absent", () => {
    expect(parseAudioCuts(null)).toEqual([]);
    expect(audioEditArguments([])).toEqual(["-map", "0:a:0"]);
  });
});
