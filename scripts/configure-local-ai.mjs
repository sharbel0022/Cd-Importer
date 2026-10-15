import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
let config = await readFile(".env.local", "utf8").catch(() => readFile(".env.example", "utf8"));
const modelPath = (value) => path.resolve(value).replaceAll("\\", "/");
const installedVoices = [
  { id: "en-us-lessac", language: "en", locale: "en-US", gender: "female", model: "en/en_US/lessac/high/en_US-lessac-high.onnx" },
  { id: "en-us-ryan", language: "en", locale: "en-US", gender: "male", model: "en/en_US/ryan/high/en_US-ryan-high.onnx" },
  { id: "en-gb-alba", language: "en", locale: "en-GB", gender: "female", model: "en/en_GB/alba/medium/en_GB-alba-medium.onnx" },
  { id: "en-gb-alan", language: "en", locale: "en-GB", gender: "male", model: "en/en_GB/alan/medium/en_GB-alan-medium.onnx" },
  { id: "sv-nst", language: "sv", model: "sv/sv_SE/nst/medium/sv_SE-nst-medium.onnx" },
  { id: "sv-lisa", language: "sv", model: "sv/sv_SE/lisa/medium/sv_SE-lisa-medium.onnx" },
  { id: "ar-kareem", language: "ar", model: "ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx" },
].map((voice) => ({ ...voice, model: modelPath(`local-ai/models/piper/${voice.model}`) }))
  .filter((voice) => existsSync(voice.model) && existsSync(`${voice.model}.json`));
// Retain operator-installed voices rather than replacing their configuration.
const priorVoiceConfig = config.match(/^STUDIO_PIPER_VOICES_JSON=(.*)$/m)?.[1];
if (priorVoiceConfig) {
  const priorVoices = JSON.parse(priorVoiceConfig);
  if (!Array.isArray(priorVoices)) throw new Error("STUDIO_PIPER_VOICES_JSON must be an array.");
  for (const voice of priorVoices) if (!installedVoices.some((v) => v.id === voice.id)) installedVoices.push(voice);
}
const values = {
  STUDIO_ASR_PROVIDER: "local", STUDIO_TRANSLATION_PROVIDER: "local", STUDIO_TTS_PROVIDER: "local",
  STUDIO_LOCAL_URL: "http://127.0.0.1:8765", WHISPER_MODEL: modelPath("local-ai/models/faster-whisper-large-v3"),
  WHISPER_DEVICE: "cpu", WHISPER_COMPUTE_TYPE: "int8", OLLAMA_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: process.env.OLLAMA_MODEL || "gemma3:12b",
  PYTHONUTF8: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_OFFLINE: "1",
  STUDIO_MMS_ENABLED: "true", MMS_MODEL: modelPath("local-ai/models/mms-tts-swe"), MMS_SEED: "555",
  STUDIO_PIPER_VOICES_JSON: JSON.stringify(installedVoices),
};
if (!/^STUDIO_LOCAL_TOKEN=\s*\S+/m.test(config)) values.STUDIO_LOCAL_TOKEN = randomBytes(24).toString("hex");
for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  config = pattern.test(config) ? config.replace(pattern, () => `${key}=${value}`) : `${config.trimEnd()}\n${key}=${value}\n`;
}
await writeFile(".env.local", config);
console.log("Lokala providers konfigurerade i .env.local. Befintlig gateway-token bevaras. Inga hemligheter visas. Starta om webbserver, gateway och worker.");
