import { afterEach, expect, it, vi } from "vitest";
import { translationDeploymentBlock } from "@/lib/translation/deployment";
afterEach(() => vi.unstubAllEnvs());
it("keeps private filesystem jobs unavailable through hosted mode regardless of guessed IDs", () => {
  vi.stubEnv("STUDIO_DEPLOYMENT_MODE", "hosted");
  expect(translationDeploymentBlock("https://studio.example/api/translation/jobs/00000000-0000-4000-8000-000000000000/file")).toMatch(/Autentisering/);
  expect(translationDeploymentBlock("http://127.0.0.1:3000/api/translation/jobs")).toMatch(/Autentisering/);
});
it("keeps local mode on loopback and rejects an unknown deployment mode", () => {
  vi.stubEnv("STUDIO_DEPLOYMENT_MODE", "local"); expect(translationDeploymentBlock("http://localhost:3000/translation")).toBeUndefined();
  expect(translationDeploymentBlock("https://public.example/translation")).toMatch(/enanvändar/);
  expect(translationDeploymentBlock("http://localhost:3000/api/translation/jobs", "public.example")).toMatch(/enanvändar/);
  expect(translationDeploymentBlock("http://localhost:3000/api/translation/jobs", "localhost:3000")).toBeUndefined();
  vi.stubEnv("STUDIO_DEPLOYMENT_MODE", "invalid"); expect(translationDeploymentBlock("http://localhost:3000/translation")).toBeDefined();
});
