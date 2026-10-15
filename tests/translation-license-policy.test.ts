import { afterEach, expect, it, vi } from "vitest";
import { assertCommercialLicense } from "@/lib/translation/license-policy";
afterEach(() => vi.unstubAllEnvs());
it("fails closed for commercial deployment with missing or stale model approval", () => {
  vi.stubEnv("STUDIO_COMMERCIAL_MODE", "true"); vi.stubEnv("STUDIO_LICENSE_APPROVALS_JSON", "{}");
  expect(() => assertCommercialLicense("asr", "large-v3")).toThrow(/licens/);
  vi.stubEnv("STUDIO_LICENSE_APPROVALS_JSON", JSON.stringify({ asr: { model: "medium", license: "MIT", evidence: "https://huggingface.co/openai/whisper-medium", reviewedAt: "2026-10-15", commercial: true } }));
  expect(() => assertCommercialLicense("asr", "large-v3")).toThrow(/licens/);
  expect(() => assertCommercialLicense("asr", "medium")).not.toThrow();
});
it.each(["sv-mms-nc", "xtts", "en-us-ryan"])("blocks restricted %s even with a false permissive approval", (model) => {
  vi.stubEnv("STUDIO_COMMERCIAL_MODE", "true");
  vi.stubEnv("STUDIO_LICENSE_APPROVALS_JSON", JSON.stringify({ voice: { model, license: "MIT", evidence: "https://example.com/review", reviewedAt: "2026-10-15", commercial: true } }));
  expect(() => assertCommercialLicense("voice", model)).toThrow(/licens/);
});
it("keeps local evaluation available without advertising commercial rights", () => {
  vi.stubEnv("STUDIO_COMMERCIAL_MODE", "false"); expect(() => assertCommercialLicense("voice", "sv-mms-nc")).not.toThrow();
});
