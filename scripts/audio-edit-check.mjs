import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import ffmpeg from "ffmpeg-static";
import { isRealMp3 } from "../src/lib/media-format.ts";

const origin = process.env.LIVE_TEST_ORIGIN || "http://127.0.0.1:3003";
const rate = 48000;
const frequencies = [440, 880, 660, 1320, 550, 1100];
// Six seconds of distinct, stereo synthetic tones. No user audio is accessed.
const wav = Buffer.alloc(44 + rate * 6 * 4);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let sample = 0; sample < rate * 6; sample++) {
  const frequency = frequencies[Math.floor(sample / rate)];
  wav.writeInt16LE(Math.round(0.2 * 32767 * Math.sin(sample * frequency * 2 * Math.PI / rate)), 44 + sample * 4);
  wav.writeInt16LE(Math.round(0.1 * 32767 * Math.sin(sample * (frequency + 50) * 2 * Math.PI / rate)), 46 + sample * 4);
}

async function runAudio(bytes, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...args, "pipe:1"], { shell: false, windowsHide: true });
    const chunks = []; let diagnostic = "";
    child.stdout.on("data", chunk => chunks.push(chunk)); child.stderr.on("data", chunk => diagnostic += chunk.toString());
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(diagnostic)));
    child.stdin.on("error", reject); child.stdin.end(bytes);
  });
}

async function decoded(bytes) {
  assert.ok(isRealMp3(bytes), "The file must contain genuine MP3 frames");
  const data = await runAudio(bytes, ["-c:a", "pcm_s16le", "-f", "wav"]);
  let channels, sampleRate, pcm;
  for (let offset = 12; offset + 8 <= data.length;) {
    const name = data.toString("ascii", offset, offset + 4); const size = data.readUInt32LE(offset + 4);
    if (name === "fmt ") { channels = data.readUInt16LE(offset + 10); sampleRate = data.readUInt32LE(offset + 12); }
    if (name === "data") { pcm = data.subarray(offset + 8); break; }
    offset += 8 + size + (size % 2);
  }
  assert.ok(pcm && sampleRate && channels, "Decoded audio header must be valid");
  return { channels, rate: sampleRate, pcm, duration: pcm.length / (sampleRate * channels * 2) };
}

function amplitude(audio, seconds, frequency, channel) {
  const count = Math.floor(audio.rate * 0.2); const first = Math.floor(seconds * audio.rate);
  let sin = 0, cos = 0;
  for (let i = 0; i < count; i++) {
    const sample = audio.pcm.readInt16LE(((first + i) * audio.channels + channel) * 2) / 32768;
    const phase = 2 * Math.PI * frequency * (first + i) / audio.rate;
    sin += sample * Math.sin(phase); cos += sample * Math.cos(phase);
  }
  return 2 * Math.hypot(sin, cos) / count;
}

async function mark(dialog, start, end) {
  await dialog.getByRole("spinbutton", { name: "Start (sekunder)", exact: true }).fill(String(start));
  await dialog.getByRole("spinbutton", { name: "Slut (sekunder)", exact: true }).fill(String(end));
  await dialog.getByRole("button", { name: "Ta bort markerad del", exact: true }).click();
}
async function exportCopy(page, dialog) {
  await dialog.getByRole("checkbox", { name: "Jag äger ljudet" }).check();
  await dialog.getByRole("button", { name: "Spara redigerad kopia", exact: true }).click();
  const link = dialog.getByRole("link", { name: "Ladda ner redigerad MP3", exact: true });
  await expect(link).toBeVisible({ timeout: 180000 });
  const pending = page.waitForEvent("download"); await link.click(); const download = await pending;
  assert.ok(download.suggestedFilename().endsWith(".mp3")); return readFile(await download.path());
}

const errors = []; const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
await mkdir("test-results", { recursive: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      const nav = page.getByRole("navigation", { name: width < 768 ? "Mobilmeny" : "Huvudmeny" });
      await nav.getByRole("button", { name: /Konvertera/ }).click();
      await page.locator("#audio-upload").setInputFiles({ name: "Testtoner.wav", mimeType: "audio/wav", buffer: wav });
      await page.getByRole("button", { name: "Redigera ljud", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Redigera ljud" });
      await expect(dialog.getByRole("slider", { name: "Startmarkering", exact: true })).toBeEnabled();
      await mark(dialog, 0, 6); await expect(dialog.getByRole("alert")).toContainText("Hela filen kan inte tas bort");
      await mark(dialog, 1, 2); await mark(dialog, 3, 4); await mark(dialog, 5, 6);
      await dialog.getByRole("button", { name: "Ångra", exact: true }).click();
      await expect(dialog.locator(".edit-cut-list li")).toHaveCount(2); await mark(dialog, 5, 6);
      // Rendering and hit targets must stay within the dialog on mobile too.
      assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      await page.screenshot({ path: `test-results/audio-editor-${new URL(origin).port}-${width}.png`, fullPage: true });
      if (width === 1440) {
        await page.evaluate(() => {
          const original = window.fetch;
          window.__resumeEditFetch = () => { window.fetch = original; };
          window.fetch = (input, init) => {
            if (!/\/api\/convert$|\/ffmpeg\/manifest\.json$/.test(String(input))) return original(input, init);
            return new Promise((resolve, reject) => {
              const abort = () => reject(new DOMException("Synthetic cancellation", "AbortError"));
              if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
            });
          };
        });
        await dialog.getByRole("checkbox", { name: "Jag äger ljudet" }).check();
        await dialog.getByRole("button", { name: "Spara redigerad kopia", exact: true }).click();
        await dialog.getByRole("button", { name: "Avbryt redigering", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText("avbröts");
        await expect(dialog.locator(".edit-cut-list li")).toHaveCount(3);
        await page.evaluate(() => window.__resumeEditFetch());
      }
      const output = await exportCopy(page, dialog); const audio = await decoded(output);
      assert.equal(audio.channels, 2, "Editing must preserve actual stereo channels");
      assert.ok(Math.abs(audio.duration - 3) < 0.1, `Three selected seconds must be removed: ${audio.duration}`);
      for (const [index, frequency] of [440, 660, 550].entries()) {
        for (const channel of [0, 1]) {
          const expected = channel === 0 ? 0.2 : 0.1;
          const level = amplitude(audio, index + 0.3, frequency + 50 * channel, channel);
          assert.ok(Math.abs(20 * Math.log10(level / expected)) < 1, "Kept audio level must remain within 1 dB");
          for (const removed of [880, 1320, 1100]) assert.ok(amplitude(audio, index + 0.3, removed + 50 * channel, channel) < 0.01, "Removed tones must not remain");
        }
      }
      await dialog.locator('audio[aria-label="Lyssna på originalet"]').evaluate(audio => audio.play());
      await dialog.locator('audio[aria-label="Lyssna på redigerad MP3"]').evaluate(audio => audio.play());
      assert.equal(await dialog.locator('audio[aria-label="Lyssna på originalet"]').evaluate(audio => audio.paused), true);
      await dialog.getByRole("button", { name: "Stäng ljudredigeraren", exact: true }).click();
      console.log(`Upload editing ${width}px: correct cuts, 3s stereo MP3 and unchanged levels`);

      if (width === 1440) {
        const originalMp3 = await runAudio(wav, ["-c:a", "libmp3lame", "-b:a", "320k", "-f", "mp3"]);
        await page.evaluate(async bytes => {
          const db = await new Promise((resolve, reject) => { const req = indexedDB.open("ton-recordings", 1); req.onupgradeneeded = () => req.result.createObjectStore("recordings", { keyPath: "id" }); req.onerror = () => reject(req.error); req.onsuccess = () => resolve(req.result); });
          await new Promise((resolve, reject) => { const tx = db.transaction("recordings", "readwrite"); tx.objectStore("recordings").put({ id: "original-test", title: "Original test", filename: "Original test.mp3", createdAt: Date.now(), duration: 6, bitrate: 320, blob: new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }) }); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
        }, [...originalMp3]);
        await page.reload({ waitUntil: "networkidle" });
        await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("button", { name: "Spela in ljud", exact: true }).click();
        await page.getByRole("button", { name: "Redigera Original test", exact: true }).click();
        const savedDialog = page.getByRole("dialog", { name: "Redigera ljud" });
        await mark(savedDialog, 0, 1); await mark(savedDialog, 5, 6);
        const savedCopy = await decoded(await exportCopy(page, savedDialog));
        assert.ok(Math.abs(savedCopy.duration - 4) < 0.15);
        await expect(savedDialog.getByRole("status")).toContainText("sparad under Sparade inspelningar");
        await savedDialog.getByRole("button", { name: "Stäng ljudredigeraren" }).click();
        await expect(page.locator(".recording-item")).toHaveCount(2);
        await page.reload({ waitUntil: "networkidle" });
        await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("button", { name: "Spela in ljud", exact: true }).click();
        await expect(page.locator(".recording-item")).toHaveCount(2);
        const unchanged = await page.evaluate(async () => {
          const db = await new Promise(resolve => { const req = indexedDB.open("ton-recordings", 1); req.onsuccess = () => resolve(req.result); });
          const record = await new Promise(resolve => { const req = db.transaction("recordings").objectStore("recordings").get("original-test"); req.onsuccess = () => resolve(req.result); }); db.close(); return [...new Uint8Array(await record.blob.arrayBuffer())];
        });
        assert.deepEqual(Buffer.from(unchanged), originalMp3, "Original saved MP3 must remain byte-identical");
        console.log("Saved recording editing: new copy persists after reload, original unchanged");

        // Actual MediaRecorder from a synthetic display stream: no real devices.
        await page.evaluate(() => {
          navigator.mediaDevices.getDisplayMedia = async () => {
            const canvas = document.createElement("canvas"); canvas.width = 10; canvas.height = 10;
            const stream = canvas.captureStream(1); const audio = new AudioContext();
            const oscillator = audio.createOscillator(); oscillator.frequency.value = 440;
            const gain = audio.createGain(); gain.gain.value = 0.2;
            const destination = audio.createMediaStreamDestination(); oscillator.connect(gain); gain.connect(destination); oscillator.start(); await audio.resume();
            destination.stream.getAudioTracks().forEach(track => stream.addTrack(track)); window.__editCapture = stream; return stream;
          };
        });
        await page.getByRole("radio", { name: "Datorljud", exact: true }).check();
        await page.getByRole("button", { name: "Starta inspelning", exact: true }).click();
        await expect(page.getByRole("button", { name: "Stoppa inspelning", exact: true })).toBeVisible();
        await page.waitForTimeout(3200); await page.getByRole("button", { name: "Stoppa inspelning", exact: true }).click();
        await page.getByRole("button", { name: "Redigera ljud", exact: true }).click();
        const rawDialog = page.getByRole("dialog", { name: "Redigera ljud" });
        await mark(rawDialog, 1, 2); const rawCopy = await decoded(await exportCopy(page, rawDialog));
        assert.ok(rawCopy.duration > 1.8 && rawCopy.duration < 3, "A second must be removed from the new recording");
        assert.equal(await page.evaluate(() => window.__editCapture.getTracks().every(track => track.readyState === "ended")), true);
        await rawDialog.getByRole("button", { name: "Stäng ljudredigeraren" }).click();
        await expect(page.locator(".recording-item")).toHaveCount(3);
        await expect(page.locator('audio[aria-label="Lyssna på inspelningen"]')).toBeVisible();
        console.log("New recording editing: actual MediaRecorder → cut → saved MP3; raw take retained");
      }
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, [], "No browser runtime errors");
} finally { await browser.close(); }
