import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import ffmpeg from "ffmpeg-static";
import { isRealMp3 } from "../src/lib/media-format.ts";

const origin = process.env.LIVE_TEST_ORIGIN || "http://127.0.0.1:3003";
const peaks = [0.40, 0.04, 0.70, 0.08, 0.22, 0.55];
const rate = 48_000;
await mkdir("test-results", { recursive: true });
function run(args, input) { return new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], { shell: false, windowsHide: true });
  const output = []; let error = "";
  child.stdout.on("data", bytes => output.push(bytes)); child.stderr.on("data", bytes => error += bytes.toString()); child.on("error", reject);
  child.on("close", code => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(error))); child.stdin.on("error", reject); child.stdin.end(input);
}); }
async function decode(bytes) {
  // Keep the actual encoded channel count; forcing two could conceal mono.
  const wave = await run(["-i", "pipe:0", "-ar", String(rate), "-c:a", "pcm_f32le", "-f", "wav", "pipe:1"], bytes);
  let channels; let pcm;
  for (let offset = 12; offset + 8 <= wave.length;) {
    const name = wave.toString("ascii", offset, offset + 4); const length = wave.readUInt32LE(offset + 4);
    if (name === "fmt ") channels = wave.readUInt16LE(offset + 10);
    if (name === "data") { pcm = wave.subarray(offset + 8); break; }
    offset += 8 + length + (length % 2);
  }
  assert.equal(channels, 2, "The encoded recording and MP3 must both retain stereo");
  assert.ok(pcm, "Decoded WAV needs an audio data chunk");
  const samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
  assert.ok(samples.length > rate * 2 * 5, "Fixture must include all quiet/loud steps");
  return samples;
}
function rms(samples, channel, start, end) {
  const first = Math.floor(start * rate); const last = Math.floor(end * rate); let squared = 0;
  for (let i = first; i < last; i++) squared += samples[i * 2 + channel] ** 2;
  return Math.sqrt(squared / (last - first));
}

// Only synthetic video and a two-channel Web Audio fixture are used. Audio is
// connected to a stream destination, never the operator's speakers/microphone.
const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ acceptDownloads: true });
await context.addInitScript(({ peaks, rate }) => {
  window.__levelStreams = []; window.__microphoneCalls = 0;
  navigator.mediaDevices.getUserMedia = async () => { window.__microphoneCalls++; throw new Error("Physical input must not be used"); };
  navigator.mediaDevices.getDisplayMedia = async options => {
    window.__captureOptions = options;
    const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
    const stream = canvas.captureStream(10);
    const audio = new AudioContext({ sampleRate: rate }); await audio.resume();
    const buffer = audio.createBuffer(2, peaks.length * rate, rate);
    for (let ch = 0; ch < 2; ch++) {
      const samples = buffer.getChannelData(ch); const frequency = ch === 0 ? 440 : 660;
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(2 * Math.PI * frequency * i / rate) * peaks[Math.floor(i / rate)] * (ch === 0 ? 1 : 0.55);
    }
    const source = audio.createBufferSource(); source.buffer = buffer;
    const destination = audio.createMediaStreamDestination(); source.connect(destination);
    destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    window.__fixtureAudio = audio; window.__fixtureStart = audio.currentTime + 0.3;
    source.onended = () => { window.__fixtureDone = true; }; source.start(window.__fixtureStart);
    window.__levelStreams.push(stream); return stream;
  };
  const NativeRecorder = MediaRecorder;
  window.MediaRecorder = class extends NativeRecorder {
    constructor(stream, options) { super(stream, options); window.__encoderOptions = options; }
    start(...args) { window.__recordingStart = window.__fixtureAudio.currentTime; return super.start(...args); }
  };
}, { peaks, rate });
const page = await context.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("button", { name: "Spela in ljud", exact: true }).click();
  await page.getByRole("radio", { name: "Datorljud", exact: true }).check();
  await expect(page.getByRole("radio", { name: /320 kbps/ })).toBeChecked();
  const playbackVolume = await page.locator(".music-player audio").evaluate(audio => audio.volume);
  await page.getByRole("button", { name: "Starta inspelning", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stoppa inspelning", exact: true })).toBeVisible();
  await page.waitForFunction(() => window.__fixtureDone, undefined, { timeout: 15000 }); await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Stoppa inspelning", exact: true }).click();
  const preview = page.getByLabel("Lyssna på inspelningen", { exact: true }); await expect(preview).toBeVisible();
  const fixture = await page.evaluate(async () => ({
    offset: window.__fixtureStart - window.__recordingStart,
    raw: [...new Uint8Array(await (await fetch(document.querySelector('audio[aria-label="Lyssna på inspelningen"]').src)).arrayBuffer())],
    options: window.__captureOptions, encoder: window.__encoderOptions,
    stopped: window.__levelStreams.every(stream => stream.getTracks().every(track => track.readyState === "ended")), microphoneCalls: window.__microphoneCalls,
  }));
  assert.equal(fixture.stopped, true); assert.equal(fixture.microphoneCalls, 0);
  assert.equal(fixture.options.audio.autoGainControl, false); assert.equal(fixture.options.audio.noiseSuppression, false); assert.equal(fixture.options.audio.echoCancellation, false);
  assert.equal(fixture.encoder.audioBitsPerSecond, 320_000);
  assert.equal(await page.locator(".music-player audio").evaluate(audio => audio.volume), playbackVolume, "Capture must not change source-player volume");
  const raw = await decode(Buffer.from(fixture.raw));
  await page.getByLabel("Namn på inspelningen", { exact: true }).fill("Nivåtest stereo");
  await page.getByLabel("Jag äger inspelningen eller har tillstånd att spela in och konvertera ljudet.").check();
  await page.getByRole("button", { name: "Spara som MP3", exact: true }).click();
  const row = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Nivåtest stereo", exact: true }) });
  await expect(row).toBeVisible({ timeout: 150_000 });
  const next = page.waitForEvent("download"); await row.getByRole("link", { name: "Ladda ner MP3", exact: true }).click();
  const bytes = await readFile(await (await next).path()); assert.ok(isRealMp3(bytes)); const mp3 = await decode(bytes);
  const report = [];
  for (let channel = 0; channel < 2; channel++) {
    const deviations = [];
    for (let step = 0; step < peaks.length; step++) {
      // Use the centers of each step to exclude encoder padding and transitions.
      const from = fixture.offset + step + 0.35; const to = fixture.offset + step + 0.75;
      const expected = peaks[step] * (channel === 0 ? 1 : 0.55) / Math.sqrt(2);
      const rawRms = rms(raw, channel, from, to); const mp3Rms = rms(mp3, channel, from, to);
      const captureDb = 20 * Math.log10(rawRms / expected); const outputDb = 20 * Math.log10(mp3Rms / expected); const conversionDb = 20 * Math.log10(mp3Rms / rawRms);
      assert.ok(Math.abs(captureDb) < 1, `Capture step ${step}, channel ${channel}: ${captureDb.toFixed(3)} dB`);
      assert.ok(Math.abs(outputDb) < 1, `MP3 step ${step}, channel ${channel}: ${outputDb.toFixed(3)} dB`);
      assert.ok(Math.abs(conversionDb) < 0.5, `Conversion must not change gain: ${conversionDb.toFixed(3)} dB`);
      deviations.push(outputDb); report.push({ channel, step, captureDb, outputDb, conversionDb });
    }
    assert.ok(Math.max(...deviations) - Math.min(...deviations) < 0.5, "Quiet/loud levels must retain their relative dynamics without pumping");
  }
  await writeFile(`test-results/audio-level-${new URL(origin).port || "site"}.json`, JSON.stringify(report, null, 2));
  console.log(`OK: 6 quiet/loud steps × 2 distinct stereo channels; largest total RMS change ${Math.max(...report.map(item => Math.abs(item.outputDb))).toFixed(3)} dB`);
  // Imported loudness tags must not silently attenuate the exported MP3.
  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("button", { name: "Konvertera & CD", exact: true }).click();
  const tagged = await run(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-metadata", "REPLAYGAIN_TRACK_GAIN=-12 dB", "-metadata", "REPLAYGAIN_ALBUM_GAIN=-9 dB", "-c:a", "flac", "-f", "flac", "pipe:1"]);
  await page.locator('input[type="file"]').setInputFiles({ name: "tagged.flac", mimeType: "audio/flac", buffer: tagged });
  await page.getByLabel("Jag äger filen eller har uttryckligt tillstånd att konvertera den.").check();
  const taggedDownload = page.waitForEvent("download", { timeout: 150_000 }); await page.getByRole("button", { name: "Konvertera till MP3", exact: true }).click();
  const result = await readFile(await (await taggedDownload).path());
  const metadata = (await run(["-i", "pipe:0", "-f", "ffmetadata", "pipe:1"], result)).toString();
  assert.doesNotMatch(metadata, /REPLAYGAIN_(TRACK|ALBUM)_GAIN/i);
  assert.deepEqual(errors, []); console.log("PASS: stereo level preservation, real MP3 and removal of inherited gain tags");
} finally { await context.close(); await browser.close(); }
