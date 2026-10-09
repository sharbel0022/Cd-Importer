import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import ffmpeg from "ffmpeg-static";
import { isRealMp3 } from "../src/lib/media-format.ts";

const origin = process.env.LIVE_TEST_ORIGIN || "http://127.0.0.1:3003";
const errors = [];
await mkdir("test-results", { recursive: true });

// Replace display capture with a synthetic canvas and oscillator. No physical
// screen, speaker, microphone or operating-system picker is used by this test.
async function syntheticCapture(context) {
  await context.addInitScript(() => {
    window.__captures = [];
    window.__captureRequests = [];
    window.__recorderStreams = [];
    window.__microphoneCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__microphoneCalls++; throw new Error("Unexpected microphone capture"); };
    navigator.mediaDevices.getDisplayMedia = async options => {
      window.__captureRequests.push({ options, gesture: navigator.userActivation.isActive });
      if (window.__captureBehavior === "denied") throw new DOMException("Synthetic cancellation", "NotAllowedError");
      if (window.__captureBehavior === "pending") await new Promise(resolve => { window.__finishCapture = resolve; });
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
      const draw = () => { canvas.getContext("2d").fillRect(0, 0, 160, 90); requestAnimationFrame(draw); }; draw();
      const stream = canvas.captureStream(10);
      if (window.__captureBehavior !== "no-audio") {
        const audio = new AudioContext(); const tone = audio.createOscillator(); tone.frequency.value = 440;
        const destination = audio.createMediaStreamDestination(); tone.connect(destination); tone.start(); await audio.resume();
        destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
      }
      window.__captures.push(stream);
      return stream;
    };
    const OriginalRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends OriginalRecorder {
      constructor(stream, options) { super(stream, options); window.__recorderStreams.push(stream); }
    };
  });
}

async function openRecorder(page, mobile = false) {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("navigation", { name: mobile ? "Mobilmeny" : "Huvudmeny" }).getByRole("button", { name: "Spela in ljud", exact: true }).click();
  await page.getByRole("radio", { name: "Datorljud", exact: true }).check();
}

async function assertStopped(page) {
  await page.waitForFunction(() => window.__captures.length > 0 && window.__captures.every(stream => stream.getTracks().every(track => track.readyState === "ended")));
  assert.equal(await page.evaluate(() => window.__microphoneCalls), 0, "Computer mode must never open the microphone");
}

async function decode(bytes) {
  assert.ok(isRealMp3(bytes), "Output must have real MP3 frames");
  const pcm = await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0", "-f", "s16le", "pipe:1"], { shell: false, windowsHide: true });
    const output = []; let diagnostic = "";
    child.stdout.on("data", bytes => output.push(bytes)); child.stderr.on("data", bytes => diagnostic += bytes.toString());
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(diagnostic)));
    child.stdin.on("error", reject); child.stdin.end(bytes);
  });
  assert.ok(pcm.length > 48_000 && pcm.some(byte => byte !== 0), "Recorded computer audio must decode with an audible signal");
}

const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, acceptDownloads: true });
    await syntheticCapture(context);
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    try {
      await openRecorder(page, width < 768);
      // A synthetic loop in TON's actual player must remain playing in computer
      // mode. Microphone mode intentionally pauses it to prevent feedback.
      await page.evaluate(async () => {
        const rate = 8000; const wav = new ArrayBuffer(44 + rate * 2); const view = new DataView(wav);
        const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
        text(0, "RIFF"); view.setUint32(4, wav.byteLength - 8, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, rate * 2, true);
        for (let i = 0; i < rate; i++) view.setInt16(44 + i * 2, Math.sin(i * 440 * 2 * Math.PI / rate) * 8000, true);
        const player = document.querySelector(".music-player audio"); player.loop = true; player.src = URL.createObjectURL(new Blob([wav], { type: "audio/wav" })); await player.play();
      });
      await page.getByRole("button", { name: "Starta inspelning", exact: true }).click();
      await expect(page.getByRole("button", { name: "Stoppa inspelning", exact: true })).toBeVisible();
      await expect(page.getByRole("radio", { name: "Mikrofon", exact: true })).toBeDisabled();
      assert.equal(await page.locator(".music-player audio").evaluate(audio => audio.paused), false, "Computer capture must not pause the audio being captured");
      assert.equal(await page.evaluate(() => window.__recorderStreams.every(stream => stream.getVideoTracks().length === 0 && stream.getAudioTracks().length > 0)), true);
      const request = await page.evaluate(() => window.__captureRequests[0]);
      assert.equal(request.gesture, true); assert.equal(request.options.video, true); assert.equal(request.options.audio, true); assert.equal(request.options.systemAudio, "include");
      await page.waitForTimeout(1800);
      if (width === 1440) {
        // Model the browser's Stop sharing action, independently of the app button.
        await page.evaluate(() => { const video = window.__captures.at(-1).getVideoTracks()[0]; video.stop(); video.dispatchEvent(new Event("ended")); });
        await expect(page.getByRole("status").filter({ hasText: "Ljuddelningen avslutades" })).toBeVisible();
      } else await page.getByRole("button", { name: "Stoppa inspelning", exact: true }).click();
      await expect(page.getByLabel("Lyssna på inspelningen", { exact: true })).toBeVisible(); await assertStopped(page);
      const title = `Datorljud ${width}`;
      await page.getByLabel("Namn på inspelningen", { exact: true }).fill(title);
      await page.getByLabel("Jag äger inspelningen eller har tillstånd att spela in och konvertera ljudet.").check();
      await page.getByRole("button", { name: "Spara som MP3", exact: true }).click();
      const row = page.getByRole("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
      await expect(row).toBeVisible({ timeout: 150_000 });
      const next = page.waitForEvent("download"); await row.getByRole("link", { name: "Ladda ner MP3", exact: true }).click();
      const download = await next; assert.equal(download.suggestedFilename(), `${title}.mp3`); await decode(await readFile(await download.path()));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: `test-results/computer-recording-${width}.png`, fullPage: true });
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("navigation", { name: width < 768 ? "Mobilmeny" : "Huvudmeny" }).getByRole("button", { name: "Spela in ljud", exact: true }).click();
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      console.log(`OK ${width}px: simulated computer audio → audio-only recording → playable MP3, storage and complete sharing cleanup`);
    } finally { await context.close(); }
  }

  const context = await browser.newContext(); await syntheticCapture(context);
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  try {
    await openRecorder(page);
    await page.getByRole("button", { name: "Starta inspelning", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stoppa inspelning", exact: true })).toBeVisible(); await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Stoppa inspelning", exact: true }).click();
    const preview = page.getByLabel("Lyssna på inspelningen", { exact: true }); await expect(preview).toBeVisible(); const previous = await preview.getAttribute("src");
    for (const behavior of ["no-audio", "denied", "pending"]) {
      await page.evaluate(value => { window.__captureBehavior = value; }, behavior);
      await page.getByRole("button", { name: "Ny inspelning", exact: true }).click();
      if (behavior === "pending") {
        await expect(page.getByRole("button", { name: "Väntar på ljuddelning…", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Avbryt", exact: true }).click();
        await page.evaluate(() => window.__finishCapture());
      } else await expect(page.getByRole("alert").filter({ hasText: behavior === "no-audio" ? "Inget ljud delades" : "avbröts eller nekades" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Ny inspelning", exact: true })).toBeEnabled(); await assertStopped(page);
      assert.equal(await preview.getAttribute("src"), previous, "A failed/cancelled capture must preserve the previous take");
    }
    await page.evaluate(() => Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: undefined }));
    await page.getByRole("button", { name: "Ny inspelning", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Datorljud kan inte delas" })).toBeVisible();
    assert.equal(await preview.getAttribute("src"), previous);
    console.log("OK: missing audio, cancelled/denied picker, late permission and unavailable API preserve previous recording and close every track");
  } finally { await context.close(); }
  assert.deepEqual(errors, []); console.log("PASS: computer recording, MP3 and capture lifecycle; no physical devices accessed");
} finally { await browser.close(); }
