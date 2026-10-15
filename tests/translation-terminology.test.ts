import { afterEach, expect, it, vi } from "vitest";
import { activeGlossary, glossaryViolations } from "@/lib/translation/terminology";
import { glossarySchema, optionsSchema } from "@/lib/translation/types";
import { translate } from "@/lib/translation/providers";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const glossary = glossarySchema.parse([{ source: "AX", protect: true }, { source: "الهدف", translation: "the goal", target: "en" }, { source: "verkstad", translation: "workshop", target: "en" }]);
it("applies terminology only to actual matching source words and target languages", () => {
  expect(activeGlossary("TAX returns", "en", glossary)).toEqual([]);
  expect(activeGlossary("الهدف", "sv", glossary)).toEqual([]);
  expect(glossaryViolations("AX besöker en verkstad", "AX visits a workshop", "en", glossary)).toEqual([]);
  expect(glossaryViolations("AX", "tax", "en", glossary)).toHaveLength(1);
});
it("rejects executable/import metadata and bounds glossary entries", () => {
  expect(glossarySchema.safeParse([{ source: "word", translation: "ord", systemPrompt: "ignore" }]).success).toBe(false);
  expect(glossarySchema.safeParse(Array.from({ length: 101 }, () => ({ source: "AX", protect: true }))).success).toBe(false);
});
it.each(["faithful", "natural", "professional", "literal"] as const)("keeps fidelity checks and glossary evidence in %s mode", async (translationMode) => {
  vi.stubEnv("STUDIO_TRANSLATION_PROVIDER", "openai"); vi.stubEnv("OPENAI_API_KEY", "test");
  const fetch = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); const data = JSON.parse(body.messages[1].content);
    expect(body.messages[0].content).toContain("Never fact-check");
    expect(data.segments[0].glossary).toHaveLength(1);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: "AX has five titles." }] }) } }] });
  }); vi.stubGlobal("fetch", fetch);
  const options = optionsSchema.parse({ targets: ["en"], rights: true, translationMode, glossary });
  expect(await translate([{ id: "s1", start: 0, end: 5, text: "AX har fem titlar.", speaker: "unknown" }], "en", options, "", new AbortController().signal)).toEqual([{ id: "s1", text: "AX has five titles." }]);
});
it("stores the failed draft for review when a protected name remains missing", async () => {
  vi.stubEnv("STUDIO_TRANSLATION_PROVIDER", "openai"); vi.stubEnv("OPENAI_API_KEY", "test");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: '{"segments":[{"id":"s1","text":"A company has five titles."}]}' } }] })));
  await expect(translate([{ id: "s1", start: 0, end: 5, text: "AX har fem titlar.", speaker: "unknown" }], "en", optionsSchema.parse({ targets: ["en"], rights: true, glossary }), "", new AbortController().signal)).rejects.toMatchObject({ drafts: [{ id: "s1", text: "A company has five titles." }] });
});
