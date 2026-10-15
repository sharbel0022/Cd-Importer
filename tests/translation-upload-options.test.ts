import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as preflight } from "@/app/api/translation/options/route";
import { POST as upload } from "@/app/api/translation/jobs/route";
import { AppError } from "@/lib/errors";
import { consumeUploadOptions, createUploadOptions, UPLOAD_OPTIONS_MAX_TOKENS, UPLOAD_OPTIONS_TTL_MS, uploadOptionsFromRequest } from "@/lib/translation/upload-options";
import { enforceQuota, jobDir } from "@/lib/translation/store";
import { optionsSchema } from "@/lib/translation/types";

vi.mock("@/lib/translation/providers", () => ({ validateOptions: vi.fn(async () => ({ ready: true })) }));
vi.mock("@/lib/translation/store", async (importOriginal) => { const actual = await importOriginal<typeof import("@/lib/translation/store")>(); return { ...actual, enforceQuota: vi.fn(actual.enforceQuota) }; });
const basic = { targets: ["en"], rights: true };
const rich = { ...basic, source: "ar", translationMode: "professional", domain: "sports", glossary: Array.from({ length: 100 }, (_, index) => ({ source: `مصطلح ${index} ${"عربي".repeat(15)}`, translation: `ترجمة ${index} ${"المفضلة".repeat(10)}`, target: "en", protect: false })) };
function jsonRequest(body: unknown, headers?: Record<string, string>) { return new Request("http://localhost/api/translation/options", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }); }

describe("bounded translation upload option preflight", () => {
  let root: string;
  beforeEach(async () => {
    vi.clearAllMocks(); const actual = await vi.importActual<typeof import("@/lib/translation/store")>("@/lib/translation/store"); vi.mocked(enforceQuota).mockImplementation(actual.enforceQuota);
    root = await mkdtemp(path.join(os.tmpdir(), "translation-options-")); vi.stubEnv("STUDIO_DATA_DIR", root);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  it("roundtrips 100 Arabic terms beyond header limits while streaming the untouched media body", async () => {
    expect(encodeURIComponent(JSON.stringify(rich)).length).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(rich))).toBeLessThan(128 * 1024);
    const response = await preflight(jsonRequest(rich)); expect(response.status).toBe(201);
    const metadata = await response.json(); expect(metadata.token).toMatch(/^[0-9a-f-]{36}$/); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const chunks = [Buffer.from("first private media bytes"), Buffer.from("second private media bytes")];
    const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
    const result = await upload(new Request("http://localhost/api/translation/jobs", { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-file-name": "arabic.mp4", "x-studio-options-token": metadata.token }, body: stream, duplex: "half" } as RequestInit));
    expect(result.status).toBe(201); const job = await result.json(); expect(job.options).toEqual(optionsSchema.parse(rich));
    expect(await readFile(path.join(jobDir(job.id), "original.mp4"))).toEqual(Buffer.concat(chunks));
    expect(await readdir(path.join(root, ".upload-options"))).toEqual([]);
  });
  it("claims a token atomically so concurrent/repeated uploads cannot reuse it", async () => {
    const { token } = await createUploadOptions(basic);
    const results = await Promise.allSettled([consumeUploadOptions(token), consumeUploadOptions(token)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 410 } });
    await expect(consumeUploadOptions(token)).rejects.toMatchObject({ status: 410 }); expect(await readdir(path.join(root, ".upload-options"))).toEqual([]);
  });
  it("expires tokens after five minutes and lazily removes expired metadata before new preflights", async () => {
    const expired = await createUploadOptions(basic); const expiredFile = path.join(root, ".upload-options", `${expired.token}.json`);
    await writeFile(expiredFile, JSON.stringify({ expiresAt: Date.now() - 1, options: optionsSchema.parse(basic) }));
    await expect(consumeUploadOptions(expired.token)).rejects.toMatchObject({ status: 410 });
    const stale = await createUploadOptions(basic); await writeFile(path.join(root, ".upload-options", `${stale.token}.json`), JSON.stringify({ expiresAt: Date.now() - 1, options: optionsSchema.parse(basic) }));
    const next = await createUploadOptions(basic); expect(await readdir(path.join(root, ".upload-options"))).toEqual([`${next.token}.json`]);
    expect(Date.parse(next.expiresAt) - Date.now()).toBeLessThanOrEqual(UPLOAD_OPTIONS_TTL_MS);
  });
  it("caps outstanding tokens and releases a slot after consumption", async () => {
    const entries = [];
    for (let index = 0; index < UPLOAD_OPTIONS_MAX_TOKENS; index++) entries.push(await createUploadOptions(basic));
    await expect(createUploadOptions(basic)).rejects.toMatchObject({ status: 429 });
    expect((await readdir(path.join(root, ".upload-options"))).filter((name) => name.endsWith(".json"))).toHaveLength(32);
    await consumeUploadOptions(entries[0].token); await expect(createUploadOptions(basic)).resolves.toHaveProperty("token");
  });
  it("rejects traversal, malformed and expired token headers before accessing arbitrary files", async () => {
    for (const token of ["../secret", "C:\\private\\keys", "00000000-0000-0000-0000-000000000000", "", "a".repeat(200)]) await expect(consumeUploadOptions(token)).rejects.toMatchObject({ status: 400 });
    expect(await readdir(root)).toEqual([]);
    const response = await upload(new Request("http://localhost/api/translation/jobs", { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-file-name": "test.mp3", "x-studio-options-token": "../secret" }, body: "media" }));
    expect(response.status).toBe(400); expect(await readdir(root)).toEqual([]);
  });
  it("retains small legacy options header compatibility and refuses oversized legacy metadata", async () => {
    const request = new Request("http://localhost/upload", { headers: { "x-studio-options": encodeURIComponent(JSON.stringify(basic)) } });
    expect(await uploadOptionsFromRequest(request)).toEqual(optionsSchema.parse(basic));
    await expect(uploadOptionsFromRequest(new Request("http://localhost/upload", { headers: { "x-studio-options": encodeURIComponent(JSON.stringify(rich)) } }))).rejects.toMatchObject({ status: 413 });
  });
  it("enforces schema, same-origin, JSON content type and streamed request size limits", async () => {
    expect((await preflight(jsonRequest({ ...basic, rights: false }))).status).toBe(400);
    expect((await preflight(jsonRequest(basic, { Origin: "https://attacker.example" }))).status).toBe(403);
    expect((await preflight(new Request("http://localhost/api/translation/options", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(basic) }))).status).toBe(415);
    expect((await preflight(new Request("http://localhost/api/translation/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(128 * 1024 + 1) }))).status).toBe(413);
    expect(await readdir(root)).toEqual([]);
  });
  it("applies storage quota before creating any token and cleans its lock after rejection", async () => {
    vi.mocked(enforceQuota).mockRejectedValueOnce(new AppError("Storage quota", 507));
    expect((await preflight(jsonRequest(basic))).status).toBe(507);
    expect(await readdir(path.join(root, ".upload-options"))).toEqual([]);
    await expect(createUploadOptions(basic)).resolves.toHaveProperty("token");
  });
  it("does not write a token for a cancelled preflight", async () => {
    const controller = new AbortController(); controller.abort(); await expect(createUploadOptions(basic, controller.signal)).rejects.toThrow();
    expect(await readdir(path.join(root, ".upload-options"))).toEqual([]);
  });
});
