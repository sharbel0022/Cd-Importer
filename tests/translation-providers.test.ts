import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { capabilities, providerFetch, repeatedSpeech, resolveVoice, synthesize, transcribe, translate, validateOptions } from "@/lib/translation/providers";
import { optionsSchema } from "@/lib/translation/types";
import { wavBlob } from "@/lib/translation/client";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "cd-provider-")); vi.stubEnv("OPENAI_API_KEY", "secret-test-key"); vi.stubEnv("STUDIO_ASR_PROVIDER", "openai"); vi.stubEnv("STUDIO_TRANSLATION_PROVIDER", "openai"); vi.stubEnv("STUDIO_TTS_PROVIDER", "openai"); });
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
const options = () => optionsSchema.parse({ targets: ["sv"], rights: true, cloudConsent: true });
it("detects likely decoder loops while preserving short real repetitions", () => {
  expect(repeatedSpeech("ايش قد ممكن ".repeat(20))).toBe(true);
  expect(repeatedSpeech("3 أبطال 3 أبطال 3 أبطال")).toBe(false);
});
it("does not approve turning a spoken cardinal into an ordinal to repair grammar", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: "Subtropical storm Jerry is the tenth named storm." }] }) } }] })));
  await expect(translate([{ id: "s1", start: 0, end: 8, text: "عشر عاصفة مسماة العاصفة شبه الاستوائية جيري", speaker: "A" }], "en", { ...options(), source: "ar" }, "", new AbortController().signal)).rejects.toThrow(/stormklassificering/);
});
it("exposes configuration without leaking credentials and requires cloud consent", async () => {
  const caps = await capabilities(); expect(caps.ready).toBe(true); expect(JSON.stringify(caps)).not.toContain("secret-test-key");
  await expect(validateOptions({ ...options(), cloudConsent: false })).rejects.toThrow(/Godkänn/);
  await expect(validateOptions({ ...options(), preserveVoice: true, voiceConsent: true })).rejects.toThrow(/kloningsmodell/);
});
it("uses Whisper verbose timestamps and a server-only bearer token", async () => {
  const file = path.join(dir, "source.wav"); await writeFile(file, new Uint8Array(await wavBlob(new Int16Array(160)).arrayBuffer()));
  const fetch = vi.fn(async (_url: string, init: RequestInit) => { const form = init.body as FormData; expect(form.get("model")).toBe("whisper-1"); expect(form.get("response_format")).toBe("verbose_json"); expect(form.getAll("timestamp_granularities[]")).toEqual(["segment", "word"]); expect(form.get("language")).toBe("ar"); expect(init.headers).toMatchObject({ Authorization: "Bearer secret-test-key" }); return Response.json({ language: "arabic", segments: [{ start: 0, end: 1, text: "مرحبا" }] }); });
  vi.stubGlobal("fetch", fetch); expect((await transcribe(file, "ar", new AbortController().signal)).language).toBe("arabic"); expect(fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/audio/transcriptions");
});
it("translates complete contextual segments and rejects missing IDs", async () => {
  const segment = { id: "s1", start: 0, end: 3, text: "مرحبا بالعالم", speaker: "A" };
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { const body = JSON.parse(init.body); expect(body.messages[0].content).toContain("untrusted data"); expect(JSON.parse(body.messages[1].content).previousContext).toBe("Earlier sentence"); return Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "wrong", text: "Hej" }] }) } }] }); }));
  await expect(translate([segment], "sv", options(), "Earlier sentence", new AbortController().signal)).rejects.toThrow(/ID/);
});
it("rejects non-audio or empty TTS replies without substituting the original", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("not speech")));
  await expect(synthesize("Hej", "sv", "coral", new AbortController().signal)).rejects.toThrow(/WAV/);
});
it("audits the draft against the original and forces an explicit target language", async () => {
  const segment = { id: "s1", start: 0, end: 7, text: "العاصفة شبه الاستوائية", speaker: "A" };
  const fetch = vi.fn().mockImplementationOnce(async (_url, init) => {
    expect(JSON.parse(init.body).messages[0].content).toContain("Swedish (ISO sv)");
    return Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: "Subtropical hurricane" }] }) } }] });
  }).mockImplementationOnce(async (_url, init) => {
    const messages = JSON.parse(init.body).messages;
    expect(messages[0].content).toContain("bilingual accuracy editor");
    const data = JSON.parse(messages[1].content);
    expect(data.segments[0].text).toBe(segment.text); expect(data.drafts[0].text).toBe("Subtropical hurricane");
    return Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: "Den subtropiska stormen" }] }) } }] });
  });
  vi.stubGlobal("fetch", fetch);
  expect(await translate([segment], "sv", options(), "", new AbortController().signal)).toEqual([{ id: "s1", text: "Den subtropiska stormen" }]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("reports invalid API keys clearly", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("private upstream detail", { status: 401 })));
  await expect(synthesize("Hej", "sv", "coral", new AbortController().signal)).rejects.toThrow(/API-nyckel/);
});
it("retries wrong storm terminology and blocks an incorrect category instead of exporting it", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: "Den tropiska orkanen Jerry" }] }) } }] })));
  await expect(translate([{ id: "s1", start: 0, end: 7, text: "العاصفة شبه الاستوائية جيري", speaker: "A" }], "sv", options(), "", new AbortController().signal)).rejects.toThrow(/stormklassificering/);
});
it("retries transient rate limits with a bounded backoff", async () => {
  vi.useFakeTimers(); const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(new Response("ok")); vi.stubGlobal("fetch", fetch);
  const result = providerFetch("https://api.openai.com/v1/test", {}, new AbortController().signal); await vi.advanceTimersByTimeAsync(701); expect((await result).status).toBe(200); expect(fetch).toHaveBeenCalledTimes(2);
});
it("supports mixed providers using only selected local services", async () => {
  vi.stubEnv("STUDIO_TTS_PROVIDER", "local"); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ready: false, services: { asr: false, translation: false, tts: true }, languages: ["sv"], voices: ["sv-lisa"], voiceLanguages: { "sv-lisa": ["sv"] }, diarization: false, cloning: false, separation: false, message: "Piper ready" })));
  const caps = await capabilities(); expect(caps.ready).toBe(true); expect(caps.voices).toEqual(["sv-lisa"]);
  await expect(validateOptions({ ...options(), voice: "sv-lisa", targets: ["ar"] })).rejects.toThrow(/målspråk/);
});
it("automatically chooses a voice with the requested English locale and validates explicit voices", async () => {
  vi.stubEnv("STUDIO_TTS_PROVIDER", "local");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ready: true, languages: ["en", "sv"], voices: ["en-us-ryan", "en-gb-alba", "sv-lisa"], voiceLanguages: { "en-us-ryan": ["en"], "en-gb-alba": ["en"], "sv-lisa": ["sv"] }, voiceLocales: { "en-us-ryan": "en-US", "en-gb-alba": "en-GB", "sv-lisa": "sv-SE" }, diarization: false, cloning: false, separation: false, message: "ready" })));
  const caps = await capabilities();
  expect(resolveVoice("en", { ...options(), targets: ["en"] }, caps)).toBe("en-us-ryan");
  expect(resolveVoice("en", { ...options(), englishLocale: "en-GB" }, caps)).toBe("en-gb-alba");
  expect(() => resolveVoice("en", { ...options(), voice: "sv-lisa" }, caps)).toThrow(/stöder inte/);
  expect(() => resolveVoice("en", { ...options(), voice: "en-gb-alba" }, caps)).toThrow(/accent/);
});
it.each(["en-US", "en-GB"] as const)("requests natural %s in translation and cloud speech", async (englishLocale) => {
  const phrase = englishLocale === "en-GB" ? "British English" : "American English";
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.messages) {
      expect(body.messages[0].content).toContain(phrase);
      expect(body.messages[0].content).not.toContain("never switch to English");
      return Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: "Hello" }] }) } }] });
    }
    expect(body.instructions).toContain(phrase);
    return new Response(await wavBlob(new Int16Array(160)).arrayBuffer());
  }));
  const studioOptions = { ...options(), targets: ["en"], englishLocale };
  await translate([{ id: "s1", start: 0, end: 2, text: "مرحبا", speaker: "unknown" }], "en", studioOptions, "", new AbortController().signal);
  await synthesize("Hello", "en", "coral", new AbortController().signal, undefined, studioOptions);
});
it("blocks repeated factual omissions after bilingual review and a repair attempt", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: "He won titles" }] }) } }] })));
  await expect(translate([{ id: "s1", start: 0, end: 4, text: "Jerry لم يفز بثلاثة ألقاب", speaker: "A" }], "en", options(), "", new AbortController().signal)).rejects.toThrow(/س|siffror/);
});
it("permits local subtitles without installed TTS or consent for an unused cloud TTS provider", async () => {
  vi.stubEnv("OPENAI_API_KEY", ""); vi.stubEnv("STUDIO_ASR_PROVIDER", "local"); vi.stubEnv("STUDIO_TRANSLATION_PROVIDER", "local");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ready: false, services: { asr: true, translation: true, tts: false }, languages: [], voices: [], diarization: false, cloning: false, separation: false, message: "TTS missing" })));
  const caps = await capabilities(); expect(caps).toMatchObject({ ready: false, subtitleReady: true, subtitleCloud: false });
  await expect(validateOptions({ ...options(), mode: "subtitles", cloudConsent: false })).resolves.toMatchObject({ subtitleReady: true });
  await expect(validateOptions({ ...options(), cloudConsent: false })).rejects.toThrow(/saknas/);
});
it.each(["Tropical Depression Jerry is the tenth named storm of the season in the Atlantic today.", "Tropical Disturbance Jerry is the tenth named storm of the season in the Atlantic today.", "A tenth named storm formed in the Atlantic today: subtropical storm Jerry.", "It formed in the Atlantic today, the tenth named subtropical storm of the Atlantic hurricane season, subtropical storm Jerry."])("rejects English weather category or season loss after review, including timing rewrites: %s", async (text) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text }] }) } }] })));
  await expect(translate([{ id: "s1", start: 0, end: 7, text: "اليوم العاصفة شبه الاستوائية جيري العاشرة من العواصف المسماة في موسم الأطلسي", speaker: "A" }], "en", options(), "", new AbortController().signal, true)).rejects.toThrow(/stormklassificering/);
});
it("repairs an English storm category while preserving source-derived ordinal and season", async () => {
  const good = "Subtropical storm Franklin is the seventh named storm of the Atlantic season today.";
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: "Tropical depression Franklin is seventh." }] }) } }] }))
    .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: "Tropical disturbance Franklin is seventh." }] }) } }] }))
    .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: good }] }) } }] }));
  vi.stubGlobal("fetch", fetch);
  expect(await translate([{ id: "s1", start: 0, end: 7, text: "اليوم العاصفة شبه الاستوائية فرانكلين السابعة من العواصف المسماة في موسم الأطلسي", speaker: "A" }], "en", options(), "", new AbortController().signal)).toEqual([{ id: "s1", text: good }]);
  expect(fetch).toHaveBeenCalledTimes(3);
});
it.each(["en", "sv"])("sends explicit %s target metadata for optional local per-language model routing", async (target) => {
  vi.stubEnv("STUDIO_TRANSLATION_PROVIDER", "local");
  const fetch = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    expect(body.targetLanguage).toBe(target);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    return Response.json({ segments: [{ id: "s1", text: target === "en" ? "Hello" : "Hej" }] });
  });
  vi.stubGlobal("fetch", fetch);
  expect(await translate([{ id: "s1", start: 0, end: 2, text: "مرحبا", speaker: "A" }], target, options(), "", new AbortController().signal)).toEqual([{ id: "s1", text: target === "en" ? "Hello" : "Hej" }]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("retains a fact-checked weather draft when the editor introduces a wrong named-subtype scope", async () => {
  const good = "A subtropical storm named Jerry formed in the Atlantic Ocean today. This is the tenth named storm of the Atlantic hurricane season.";
  const bad = "It formed in the Atlantic today, the tenth named subtropical storm of the Atlantic hurricane season, subtropical storm Jerry.";
  const reply = (text: string) => Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text }] }) } }] });
  const fetch = vi.fn().mockResolvedValueOnce(reply(good)).mockResolvedValueOnce(reply(bad)).mockImplementation(async () => reply(bad));
  vi.stubGlobal("fetch", fetch);
  expect(await translate([{ id: "s1", start: 0, end: 7, text: "اليوم العاصفة شبه الاستوائية جيري العاشرة من العواصف المسماة في موسم الأطلسي", speaker: "A" }], "en", options(), "", new AbortController().signal)).toEqual([{ id: "s1", text: good }]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("retains verified drafts by segment even when a repair for another segment corrupts them again", async () => {
  const good = "Subtropical storm Jerry is the tenth named storm of the Atlantic season today.";
  const bad = "Jerry is the tenth named subtropical storm of the Atlantic season today.";
  const reply = (first: string, second: string) => Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: first }, { id: "s2", text: second }] }) } }] });
  const fetch = vi.fn().mockResolvedValueOnce(reply(good, "Tropical depression Donna."))
    .mockResolvedValueOnce(reply(bad, "Tropical disturbance Donna."))
    .mockResolvedValueOnce(reply(bad, "Subtropical storm Donna."));
  vi.stubGlobal("fetch", fetch);
  expect(await translate([{ id: "s1", start: 0, end: 7, text: "اليوم العاصفة شبه الاستوائية جيري العاشرة من العواصف المسماة في موسم الأطلسي", speaker: "A" }, { id: "s2", start: 7, end: 9, text: "العاصفة شبه الاستوائية دونا", speaker: "A" }], "en", options(), "", new AbortController().signal)).toEqual([{ id: "s1", text: good }, { id: "s2", text: "Subtropical storm Donna." }]);
  expect(fetch).toHaveBeenCalledTimes(3);
});
it("never falls back to a weather draft that passes terminology but changes the source count", async () => {
  const draft = "Subtropical storm Jerry is the ninth named storm of the Atlantic season today.";
  const bad = "Jerry is the tenth named subtropical storm of the Atlantic season today.";
  const reply = (text: string) => Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text }] }) } }] });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(draft)).mockImplementation(async () => reply(bad)));
  await expect(translate([{ id: "s1", start: 0, end: 7, text: "اليوم العاصفة شبه الاستوائية جيري العاشرة من العواصف المسماة في موسم الأطلسي", speaker: "A" }], "en", options(), "", new AbortController().signal)).rejects.toThrow(/stormklassificering/);
});

it.each(["faithful", "natural"] as const)("preserves mistaken facts, negation, tense and self-correction in %s mode", async (translationMode) => {
  const phrases = [
    ["Barcelona فاز بخمسة مباريات", "Barcelona won five matches"],
    ["لديه ثلاثة أرجل", "He has three legs"],
    ["لن أسافر غدا", "I will not travel tomorrow"],
    ["ثلاثة لا أربعة", "Three, no, four"],
  ];
  for (const [source, target] of phrases) {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const messages = JSON.parse(init.body).messages;
      expect(messages[0].content).toContain("Never fact-check or silently correct the speaker");
      expect(messages[0].content).toContain(`Translation mode: ${translationMode}`);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ segments: [{ id: "s1", text: target }] }) } }] });
    }));
    expect(await translate([{ id: "s1", start: 0, end: 4, text: source, speaker: "A" }], "en", { ...options(), source: "ar", translationMode }, "", new AbortController().signal)).toEqual([{ id: "s1", text: target }]);
  }
});
