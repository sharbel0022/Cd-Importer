import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/translation/live/route";
import * as media from "@/lib/translation/media";
import * as providers from "@/lib/translation/providers";
import { liveRequestBody } from "@/lib/translation/request-options";
import { optionsSchema } from "@/lib/translation/types";

vi.mock("@/lib/translation/providers", () => ({ validateOptions: vi.fn(), transcribe: vi.fn(), translate: vi.fn(), synthesize: vi.fn(), resolveVoice: vi.fn(() => "fixture-voice") }));
vi.mock("@/lib/translation/media", () => ({ inspect: vi.fn(), normalize: vi.fn(), inputArgs: (file: string) => ["-i", file], speechDuration: vi.fn(), ffmpeg: vi.fn() }));
const globalLive = globalThis as typeof globalThis & { studioLiveActive?: number };
function request(signal?: AbortSignal) { return new Request("http://localhost/api/translation/live", { method: "POST", signal, headers: { "Content-Type": "audio/wav", "x-studio-options": encodeURIComponent(JSON.stringify({ targets: ["en"], rights: true })) }, body: new Uint8Array([1, 2, 3]) }); }

describe("block translation timing events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalLive.studioLiveActive = 0;
    vi.mocked(providers.validateOptions).mockResolvedValue({ ready: true } as Awaited<ReturnType<typeof providers.validateOptions>>);
    vi.mocked(media.inspect).mockResolvedValue({ duration: 4 } as Awaited<ReturnType<typeof media.inspect>>);
    vi.mocked(media.normalize).mockResolvedValue(undefined);
    vi.mocked(media.speechDuration).mockResolvedValue(1);
    vi.mocked(media.ffmpeg).mockImplementation(async (args) => { await writeFile(args.at(-1)!, Buffer.from("fixture encoded speech")); return ""; });
    vi.mocked(providers.transcribe).mockResolvedValue({ language: "ar", segments: [{ start: 0, end: 2, text: "خمسة ألقاب" }] });
    vi.mocked(providers.translate).mockResolvedValue([{ id: "s1", text: "Five titles" }]);
    vi.mocked(providers.synthesize).mockResolvedValue(Buffer.from("fixture synthesis"));
  });
  afterEach(async () => { await vi.waitFor(() => expect(globalLive.studioLiveActive).toBe(0)); });
  it("emits measured completed-stage timings alongside final text and playable audio without fake partials", async () => {
    const response = await POST(request()); expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(["timing", "transcript", "translation", "timing", "timing", "audio"]);
    const timings = events.filter((event) => event.type === "timing");
    expect(timings.map((event) => event.stage)).toEqual(["asr-final", "translation-final", "tts-ready"]);
    let previous = 0;
    for (const timing of timings) { expect(timing.elapsedMs).toBeGreaterThanOrEqual(previous); expect(timing.durationMs).toBeGreaterThanOrEqual(0); expect(Number.isFinite(timing.elapsedMs + timing.durationMs)).toBe(true); previous = timing.elapsedMs; }
    expect(events.find((event) => event.type === "transcript").text).toBe("خمسة ألقاب");
    expect(events.find((event) => event.type === "translation").text).toBe("Five titles");
    expect(Buffer.from(events.at(-1).audio, "base64").toString()).toBe("fixture encoded speech");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("reports uncertain ASR as review-required error before translating or synthesizing", async () => {
    vi.mocked(providers.transcribe).mockResolvedValue({ language: "ar", segments: [{ start: 0, end: 2, text: "غير واضح", uncertain: true }] });
    const response = await POST(request()); const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(["timing", "error"]);
    expect(events[1].error).toContain("osäkert"); expect(providers.translate).not.toHaveBeenCalled(); expect(providers.synthesize).not.toHaveBeenCalled();
  });
  it("cancels in-flight ASR when the browser closes the response, without producing later translation/audio", async () => {
    let providerSignal: AbortSignal | undefined;
    vi.mocked(providers.transcribe).mockImplementation(async (_file, _source, signal) => { providerSignal = signal; return await new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); });
    const response = await POST(request()); await vi.waitFor(() => expect(providerSignal).toBeDefined());
    await response.body!.cancel(); expect(providerSignal!.aborted).toBe(true);
    expect(providers.translate).not.toHaveBeenCalled(); expect(providers.synthesize).not.toHaveBeenCalled();
  });
  it("accepts 100 Arabic glossary terms and long Unicode context through a bounded real multipart body", async () => {
    const options = optionsSchema.parse({ targets: ["en"], source: "ar", rights: true, glossary: Array.from({ length: 100 }, (_, index) => ({ source: `مصطلح ${index} ${"عربي".repeat(15)}`, translation: `term ${index}`, target: "en" })) });
    const audio = new Blob([new Uint8Array([4, 3, 2, 1])], { type: "audio/wav" });
    const body = liveRequestBody(options, "", audio); const longContext = "سياق عربي ".repeat(1000); body.set("context", longContext);
    vi.mocked(media.inspect).mockImplementation(async (file) => { expect(await (await import("node:fs/promises")).readFile(file)).toEqual(Buffer.from([4, 3, 2, 1])); return { duration: 4 } as Awaited<ReturnType<typeof media.inspect>>; });
    const incoming = new Request("http://localhost/api/translation/live", { method: "POST", body }); expect(incoming.headers.get("x-studio-options")).toBeNull();
    const response = await POST(incoming); expect(response.status).toBe(200); const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.at(-1).type).toBe("audio"); expect(vi.mocked(providers.translate).mock.calls[0][2].glossary).toHaveLength(100); expect(vi.mocked(providers.translate).mock.calls[0][3]).toBe(longContext.slice(-2000));
  });
  it("rejects malformed multipart, repeated fields and non-WAV blobs before reserving inference", async () => {
    const malformed = await POST(new Request("http://localhost/api/translation/live", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=missing" }, body: "broken" })); expect(malformed.status).toBe(400);
    const options = optionsSchema.parse({ targets: ["en"], rights: true });
    const repeated = liveRequestBody(options, "", new Blob(["audio"], { type: "audio/wav" })); repeated.append("options", JSON.stringify(options));
    expect((await POST(new Request("http://localhost/api/translation/live", { method: "POST", body: repeated }))).status).toBe(400);
    const wrongAudio = liveRequestBody(options, "", new Blob(["video"], { type: "video/mp4" }));
    expect((await POST(new Request("http://localhost/api/translation/live", { method: "POST", body: wrongAudio }))).status).toBe(415);
    expect(providers.validateOptions).not.toHaveBeenCalled(); expect(globalLive.studioLiveActive).toBe(0);
  });
  it("bounds the entire multipart request before parsing or invoking a provider", async () => {
    const options = optionsSchema.parse({ targets: ["en"], rights: true });
    const oversized = liveRequestBody(options, "", new Blob([new Uint8Array(2 * 1024 ** 2 + 1)], { type: "audio/wav" }));
    const response = await POST(new Request("http://localhost/api/translation/live", { method: "POST", body: oversized }));
    expect(response.status).toBe(413); expect(providers.validateOptions).not.toHaveBeenCalled(); expect(globalLive.studioLiveActive).toBe(0);
  });
});
