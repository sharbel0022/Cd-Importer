import { describe, expect, it } from "vitest";
import { boundedLiveContext, liveRequestBody, voiceSampleOptions } from "@/lib/translation/request-options";
import { optionsSchema } from "@/lib/translation/types";

const options = optionsSchema.parse({ targets: ["en", "sv"], rights: true, englishLocale: "en-GB", voice: "en-uk-alba", speechRate: 1.1, cloudConsent: true, domain: "sports", glossary: Array.from({ length: 100 }, (_, index) => ({ source: `مصطلح ${index} ${"العربي".repeat(15)}`, translation: `translation ${index}`, target: "en" })), mix: { speechGainDb: 3 }, subtitles: { bilingual: true }, speakerVoices: { A: "different-speaker-voice" } });
describe("bounded browser AI request metadata", () => {
  it("sends only relevant synthesis options for voice samples, independent of glossary size", () => {
    const sample = voiceSampleOptions(options);
    expect(sample).toMatchObject({ targets: ["en"], voice: "en-uk-alba", speechRate: 1.1, englishLocale: "en-GB", cloudConsent: true, speakerVoices: {}, preserveBackground: false });
    for (const field of ["glossary", "domain", "mix", "subtitles"]) expect(sample).not.toHaveProperty(field);
    expect(Buffer.byteLength(JSON.stringify({ text: "A voice preview.", options: sample }))).toBeLessThan(16_384);
    expect(options.glossary).toHaveLength(100); expect(options.targets).toEqual(["en", "sv"]);
  });
  it("places large Unicode options and context in a real multipart body with WAV bytes", async () => {
    const audio = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/wav" });
    const body = liveRequestBody(options, "سياق ".repeat(1000), audio);
    const request = new Request("http://localhost/api/translation/live", { method: "POST", body });
    expect(request.headers.get("x-studio-options")).toBeNull(); expect(request.headers.get("x-studio-context")).toBeNull(); expect(request.headers.get("content-type")!.length).toBeLessThan(128);
    const parsed = await request.formData(); expect(JSON.parse(parsed.get("options") as string).glossary).toHaveLength(100); expect((parsed.get("context") as string).length).toBe(2000);
    expect(await (parsed.get("audio") as Blob).arrayBuffer()).toEqual(await audio.arrayBuffer());
  });
  it("clips context without exposing an incomplete UTF-16 surrogate", () => {
    const clipped = boundedLiveContext(`😀${"a".repeat(1999)}`); expect(clipped).toBe("a".repeat(1999));
    expect(boundedLiveContext("معنى واضح 😀")).toBe("معنى واضح 😀");
  });
});
