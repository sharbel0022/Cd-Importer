import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { capabilities, providerFetch, synthesize, transcribe, translate, validateOptions } from "@/lib/translation/providers";
import { optionsSchema } from "@/lib/translation/types";
import { wavBlob } from "@/lib/translation/client";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "cd-provider-")); vi.stubEnv("OPENAI_API_KEY", "secret-test-key"); vi.stubEnv("STUDIO_ASR_PROVIDER", "openai"); vi.stubEnv("STUDIO_TRANSLATION_PROVIDER", "openai"); vi.stubEnv("STUDIO_TTS_PROVIDER", "openai"); });
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
const options = () => optionsSchema.parse({ targets: ["sv"], rights: true, cloudConsent: true });
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
