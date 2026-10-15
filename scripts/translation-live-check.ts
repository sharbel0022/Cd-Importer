import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { capabilities, transcribe } from "../src/lib/translation/providers";
import { POST } from "../src/app/api/translation/jobs/route";
import { runJob } from "../src/lib/translation/pipeline";
import { jobDir, readJob } from "../src/lib/translation/store";
import { chunk, ffmpeg, inputArgs } from "../src/lib/translation/media";

// Real provider test, explicitly opt-in. Never loads a fake translation.
const media = process.env.STUDIO_TEST_MEDIA;
if (!media) { console.log("SKIP: Ange STUDIO_TEST_MEDIA till en verklig talfil. Inga AI-anrop gjordes."); process.exit(0); }
const reportDir = path.resolve("test-results", `translation-real-${randomUUID()}`); await mkdir(reportDir, { recursive: true });
process.env.STUDIO_DATA_DIR = path.join(reportDir, "jobs");
const caps = await capabilities(); if (!caps.ready) throw new Error(caps.message);
const target = process.env.STUDIO_TEST_TARGET || "en";
const bytes = await readFile(media);
const response = await POST(new Request("http://localhost/api/translation/jobs", { method: "POST", headers: { "x-file-name": encodeURIComponent(path.basename(media)), "x-studio-options": encodeURIComponent(JSON.stringify({ source: process.env.STUDIO_TEST_SOURCE || "auto", targets: [target], rights: true, cloudConsent: caps.cloud, voice: process.env.STUDIO_TEST_VOICE || "auto", diarize: process.env.STUDIO_TEST_DIARIZE === "true" })) }, body: new Uint8Array(bytes) }));
if (!response.ok) throw new Error((await response.json()).error);
const submitted = await response.json(); await runJob(submitted.id); const job = await readJob(submitted.id);
function tokens(text: string) { return text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\p{M}]/gu, " ").split(/\s+/).filter(Boolean); }
function wer(reference: string[], actual: string[]) {
  let row = actual.map((_, i) => i + 1); row.unshift(0);
  for (let i = 1; i <= reference.length; i++) { const next = [i]; for (let j = 1; j <= actual.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (reference[i - 1] === actual[j - 1] ? 0 : 1)); row = next; }
  return row[actual.length] / Math.max(1, reference.length);
}
let asrWer: number | null = null;
if (process.env.STUDIO_TEST_REFERENCE_TXT) asrWer = wer(tokens(await readFile(process.env.STUDIO_TEST_REFERENCE_TXT, "utf8")), tokens(job.segments.map((s) => s.text).join(" ")));
let roundTripRecall: number | null = null;
if (job.outputs[target]?.includes("wav")) {
  const signal = new AbortController().signal; const sample = path.join(reportDir, "roundtrip.wav");
  const first = job.segments.find((s) => s.end <= 230) || job.segments[0];
  await chunk(path.join(jobDir(job.id), `${target}.wav`), sample, first.start, Math.min(240, job.media!.duration - first.start), signal);
  const heard = await transcribe(sample, "auto", signal); const actual = new Set(tokens(heard.segments.map((s) => s.text).join(" ")));
  await writeFile(path.join(reportDir, "roundtrip-transcription.json"), JSON.stringify(heard, null, 2));
  if (heard.language !== target) throw new Error(`Exportens språk identifierades som ${heard.language}, förväntat ${target}.`);
  const expected = tokens(job.translations[target].filter((t) => { const s = job.segments.find((s) => s.id === t.id)!; return s.start >= first.start && s.end <= first.start + 240; }).map((s) => s.text).join(" "));
  roundTripRecall = expected.filter((t) => actual.has(t)).length / Math.max(1, expected.length);
  await ffmpeg([...inputArgs(path.join(jobDir(job.id), `${target}.wav`)), "-af", "astats=metadata=0:reset=0", "-f", "null", "-"], signal);
  if (roundTripRecall < Number(process.env.STUDIO_MIN_ROUNDTRIP_RECALL || 0.45)) throw new Error(`ASR av exporten matchade endast ${(roundTripRecall * 100).toFixed(1)} % av översättningens ord. Granska ljudet.`);
}
const report = { status: job.status, error: job.error, providers: { asr: caps.asr, translation: caps.translation, tts: caps.tts }, sourceLanguage: job.detectedLanguage, target, metrics: job.metrics, quality: { asrWer, exportedSpeechWordRecall: roundTripRecall, translationSemanticQuality: "Kräver mänsklig referensgranskning", voiceMOS: "Kräver lyssningstest" }, outputs: job.outputs, warnings: job.warnings, dataDirectory: jobDir(job.id) };
await writeFile(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
if (job.status !== "completed") process.exitCode = 1;
