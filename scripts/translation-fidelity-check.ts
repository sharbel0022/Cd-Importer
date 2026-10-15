import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { capabilities, translate } from "../src/lib/translation/providers";
import { optionsSchema } from "../src/lib/translation/types";

// Real local-model text probes. These complement media tests; they are not an
// acoustic accent benchmark or proof that every semantic claim is protected.
assert(!(await capabilities()).cloud, "Configure local providers for this diagnostic.");
const cases = [
  { id: "s1", text: "فاز Barcelona بخمس مباريات.", checks: [/Barcelona/iu, /\b(?:five|5)\b/iu] },
  { id: "s2", text: "لدي ثلاثة أرجل.", checks: [/\b(?:three|3)\b/iu, /\blegs\b/iu] },
  { id: "s3", text: "لن أسافر غدا.", checks: [/\b(?:not|won't)\b/iu, /\btomorrow\b/iu] },
  { id: "s4", text: "ثلاثة، لا، أقصد أربعة.", checks: [/\b(?:three|3)\b.*\bno\b.*\b(?:four|4)\b/iu] },
];
const results = [];
for (const translationMode of ["faithful", "natural"] as const) {
  const translated = await translate(cases.map((c, i) => ({ ...c, start: i * 5, end: i * 5 + 4, speaker: "A" })), "en", optionsSchema.parse({ source: "ar", targets: ["en"], translationMode, rights: true }), "", AbortSignal.timeout(600_000));
  for (const source of cases) {
    const output = translated.find((t) => t.id === source.id)!;
    const passed = source.checks.every((pattern) => pattern.test(output.text));
    results.push({ translationMode, source: source.text, translation: output.text, passed });
  }
}
const directory = path.resolve("test-results", `fidelity-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, "report.json"), JSON.stringify({ passed: results.every((r) => r.passed), scope: "Real installed local translator; mistaken counts, unusual facts, future negation and self-correction. No ASR or TTS measured by these text probes.", results }, null, 2));
console.log(JSON.stringify({ passed: results.every((r) => r.passed), checks: results.length, directory }));
assert(results.every((r) => r.passed), "A real-model fidelity probe failed; inspect the report.");
