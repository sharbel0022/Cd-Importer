import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import ffmpeg from "ffmpeg-static";
import { isRealMp3 } from "../src/lib/media.ts";

// The fake-device flag is required on EVERY launched browser. This test never
// accesses the operator's physical microphone or opens a real permission prompt.
const origin = process.env.LIVE_TEST_ORIGIN || "http://127.0.0.1:3000";
const rightsLabel = "Jag äger inspelningen eller har tillstånd att spela in och konvertera ljudet.";
await mkdir("test-results", { recursive: true });
const errors = [];
const fakeDeviceArgs = ["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"];

function decodeMp3(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "pipe", "-f", "mp3", "-i", "pipe:0", "-f", "s16le", "pipe:1"], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const pcm = [];
    let diagnostic = "";
    child.stdout.on("data", chunk => pcm.push(chunk));
    child.stderr.on("data", chunk => { diagnostic += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(Buffer.concat(pcm)) : reject(new Error(diagnostic || `FFmpeg exited with ${code}`)));
    child.stdin.on("error", reject);
    child.stdin.end(bytes);
  });
}

async function observeMicrophone(context) {
  await context.addInitScript(() => {
    window.__recordingTestStreams = [];
    const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (original) navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await original(...args);
      window.__recordingTestStreams.push(stream);
      return stream;
    };
  });
}

async function openRecorder(page, mobile = false) {
  await page.getByRole("navigation", { name: mobile ? "Mobilmeny" : "Huvudmeny" })
    .getByRole("button", { name: "Spela in ljud", exact: true }).click();
  await expect(page.getByRole("button", { name: "Starta inspelning", exact: true })).toBeVisible();
}

async function assertMicrophoneStopped(page) {
  await page.waitForFunction(() => window.__recordingTestStreams.length > 0 &&
    window.__recordingTestStreams.every(stream => stream.getTracks().every(track => track.readyState === "ended")));
}

async function savedRecords(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("ton-recordings", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("recordings", "readonly");
      const query = transaction.objectStore("recordings").getAll();
      query.onsuccess = () => resolve(query.result.map(record => ({
        id: record.id, title: record.title, filename: record.filename,
        bitrate: record.bitrate, size: record.blob.size, type: record.blob.type,
      })));
      query.onerror = () => reject(query.error);
      transaction.oncomplete = () => db.close();
    };
  }));
}

const browser = await chromium.launch({ headless: true, args: [...fakeDeviceArgs, "--use-fake-ui-for-media-stream"] });
try {
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    const mobile = width < 768;
    const title = mobile ? "Mobil inspelning" : "Min inspelning";
    const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, permissions: ["microphone"] });
    await observeMicrophone(context);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(origin, { waitUntil: "networkidle", timeout: 60_000 });
      await openRecorder(page, mobile);
      await expect(page.getByRole("button", { name: "Spara som MP3", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Starta inspelning", exact: true }).click();
      await expect(page.getByRole("button", { name: "Stoppa inspelning", exact: true })).toBeVisible();
      await page.waitForTimeout(2200);
      await page.getByRole("button", { name: "Stoppa inspelning", exact: true }).click();
      const preview = page.getByLabel("Lyssna på inspelningen", { exact: true });
      await expect(preview).toBeVisible();
      await assertMicrophoneStopped(page);
      await expect(page.getByRole("button", { name: "Spara som MP3", exact: true })).toBeDisabled();
      await page.getByLabel("Namn på inspelningen", { exact: true }).fill(title);
      await page.getByText("Hög kvalitet", { exact: true }).click();
      await expect(page.getByRole("radio", { name: "256 kbps, Hög kvalitet", exact: true })).toBeChecked();
      await page.getByLabel(rightsLabel, { exact: true }).check();
      await expect(page.getByRole("button", { name: "Spara som MP3", exact: true })).toBeEnabled();
      if (!mobile) {
        const fingerprint = () => preview.evaluate(async audio => {
          const blob = await (await fetch(audio.src)).blob();
          const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
          return { src: audio.src, size: blob.size, hash: Array.from(new Uint8Array(hash)).join(",") };
        });
        const originalRecording = await fingerprint();
        await page.evaluate(() => {
          const original = MediaRecorder.prototype.start;
          let failOnce = true;
          MediaRecorder.prototype.start = function (...args) {
            if (failOnce) {
              failOnce = false;
              throw new DOMException("Synthetic recorder startup failure", "NotSupportedError");
            }
            return original.apply(this, args);
          };
        });
        await page.getByRole("button", { name: "Ny inspelning", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: /Inspelningen kunde inte startas/ })).toBeVisible();
        await expect(preview).toBeVisible();
        assert.deepEqual(await fingerprint(), originalRecording, "Ett startfel får inte radera eller ersätta den tidigare ljudfilen");
        await page.waitForFunction(() => window.__recordingTestStreams.length === 2);
        await assertMicrophoneStopped(page);
        await expect(page.getByLabel(rightsLabel, { exact: true })).toBeChecked();
        await expect(page.getByRole("button", { name: "Spara som MP3", exact: true })).toBeEnabled();
        console.log("OK: MediaRecorder-startfel bevarar föregående ljudfil, förhandslyssning och sparmöjlighet; ny mikrofon stoppas");
      }
      const conversionResponse = page.waitForResponse(response => response.url().endsWith("/api/convert") && response.request().method() === "POST", { timeout: 60_000 });
      await page.getByRole("button", { name: "Spara som MP3", exact: true }).click();
      const response = await conversionResponse;
      assert.equal(response.status(), 200, response.ok() ? "" : await response.text());
      assert.match(response.headers()["content-type"], /audio\/mpeg/);
      const row = page.getByRole("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
      await expect(row).toBeVisible({ timeout: 30_000 });
      const downloadEvent = page.waitForEvent("download");
      await row.getByRole("link", { name: "Ladda ner MP3", exact: true }).click();
      const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), `${title}.mp3`);
      const output = await readFile(await download.path());
      assert.equal(isRealMp3(output), true, "MP3 måste innehålla riktiga MPEG Layer III-ljudramar");
      const pcm = await decodeMp3(output);
      assert.ok(pcm.length > 48_000, "Den nedladdade MP3-filen måste kunna avkodas som ljud");
      assert.ok(pcm.some(byte => byte !== 0), "Chromiums syntetiska inspelning måste innehålla ljud");
      const saved = await savedRecords(page);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].title, title);
      assert.equal(saved[0].bitrate, 256);
      assert.equal(saved[0].size, output.length);
      assert.match(saved[0].type, /audio\/mpeg/);
      const player = row.getByLabel(`Lyssna på ${title}`, { exact: true });
      await player.evaluate(audio => audio.play());
      await page.waitForFunction(name => {
        const audio = [...document.querySelectorAll("audio")].find(item => item.getAttribute("aria-label") === `Lyssna på ${name}`);
        return audio && !audio.paused && audio.currentTime > 0;
      }, title);
      await player.evaluate(audio => audio.pause());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width}px horisontell overflow`);
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      await page.waitForFunction(() => window.scrollY === 0);
      await page.screenshot({ path: `test-results/recording-${width}.png`, fullPage: true });
      await page.reload({ waitUntil: "networkidle" });
      await openRecorder(page, mobile);
      await expect(page.getByRole("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) })).toBeVisible();
      assert.equal((await savedRecords(page)).length, 1, "Sparad MP3 måste överleva en uppdatering av sidan");
      await page.getByRole("button", { name: `Ta bort ${title}`, exact: true }).click();
      await expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
      assert.equal((await savedRecords(page)).length, 0);

      // A menu action must not accidentally discard an active recording.
      await page.getByRole("button", { name: "Starta inspelning", exact: true }).click();
      await expect(page.getByRole("button", { name: "Stoppa inspelning", exact: true })).toBeVisible();
      await page.getByRole("navigation", { name: mobile ? "Mobilmeny" : "Huvudmeny" })
        .getByRole("button", { name: mobile ? "Upptäck" : "Upptäck musik", exact: true }).click();
      await expect(page.getByRole("button", { name: "Stoppa inspelning", exact: true })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Avsluta inspelningen eller bearbetningen innan du byter sida." })).toBeVisible();
      await page.getByRole("button", { name: "Stoppa inspelning", exact: true }).click();
      await assertMicrophoneStopped(page);
      await expect(page.getByLabel("Lyssna på inspelningen", { exact: true })).toBeVisible();
      await page.getByRole("navigation", { name: mobile ? "Mobilmeny" : "Huvudmeny" })
        .getByRole("button", { name: mobile ? "Upptäck" : "Upptäck musik", exact: true }).click();
      await expect(page.getByRole("heading", { name: /Hitta ljud/ })).toBeVisible();
      await assertMicrophoneStopped(page);
      console.log(`OK ${width}px: syntetisk mikrofon → förhandslyssning → FFmpeg → sparad MP3 → nedladdning/uppspelning; beständighet, borttagning och mikrofonstopp`);
    } finally { await context.close(); }
  }

  // Capabilities are replaced only for error branches; no microphone call occurs.
  for (const capability of ["MediaRecorder", "isSecureContext"]) {
    const context = await browser.newContext();
    await context.addInitScript(name => Object.defineProperty(window, name, { configurable: true, value: name === "isSecureContext" ? false : undefined }), capability);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(origin, { waitUntil: "networkidle" });
      await openRecorder(page);
      await page.getByRole("button", { name: "Starta inspelning", exact: true }).click();
      const notice = page.getByRole("alert");
      await expect(notice.filter({ hasText: capability === "isSecureContext" ? /HTTPS|localhost|127\.0\.0\.1/ : /webbläsare|stöder/ }).first()).toBeVisible();
      console.log(`OK: användbar förklaring när ${capability} saknas`);
    } finally { await context.close(); }
  }

  const pendingContext = await browser.newContext({ permissions: ["microphone"] });
  await pendingContext.addInitScript(() => {
    window.__recordingTestStreams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      await new Promise(resolve => { window.__finishRecordingPermission = resolve; });
      const stream = await original(...args);
      window.__recordingTestStreams.push(stream);
      return stream;
    };
  });
  const pendingPage = await pendingContext.newPage();
  pendingPage.on("pageerror", error => errors.push(error.message));
  try {
    await pendingPage.goto(origin, { waitUntil: "networkidle" });
    await openRecorder(pendingPage);
    await pendingPage.getByRole("button", { name: "Starta inspelning", exact: true }).click();
    await expect(pendingPage.getByRole("button", { name: "Väntar på mikrofon…", exact: true })).toBeVisible();
    await pendingPage.getByRole("button", { name: "Avbryt", exact: true }).click();
    await expect(pendingPage.getByRole("button", { name: "Starta inspelning", exact: true })).toBeEnabled();
    await pendingPage.evaluate(() => window.__finishRecordingPermission());
    await assertMicrophoneStopped(pendingPage);
    await expect(pendingPage.getByRole("button", { name: "Stoppa inspelning", exact: true })).toHaveCount(0);
    console.log("OK: avbruten behörighetsfråga stänger även en mikrofon som beviljas senare");
  } finally { await pendingContext.close(); }

  // Exercise a genuine IndexedDB QuotaExceededError, rather than inventing a
  // successful save. The converted MP3 must remain available for direct download.
  const quotaContext = await browser.newContext({ permissions: ["microphone"], acceptDownloads: true });
  await observeMicrophone(quotaContext);
  const quotaPage = await quotaContext.newPage();
  quotaPage.on("pageerror", error => errors.push(error.message));
  try {
    await quotaPage.goto(origin, { waitUntil: "networkidle" });
    await openRecorder(quotaPage);
    await expect(quotaPage.getByText("Din första MP3 visas här när du har spelat in och sparat.", { exact: true })).toBeVisible();
    const cdp = await quotaContext.newCDPSession(quotaPage);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1 });
    await quotaPage.getByRole("button", { name: "Starta inspelning", exact: true }).click();
    await expect(quotaPage.getByRole("button", { name: "Stoppa inspelning", exact: true })).toBeVisible();
    await quotaPage.waitForTimeout(1500);
    await quotaPage.getByRole("button", { name: "Stoppa inspelning", exact: true }).click();
    await expect(quotaPage.getByLabel("Lyssna på inspelningen", { exact: true })).toBeVisible();
    await assertMicrophoneStopped(quotaPage);
    await quotaPage.getByLabel("Namn på inspelningen", { exact: true }).fill("Full lagring");
    await quotaPage.getByLabel(rightsLabel, { exact: true }).check();
    await quotaPage.getByRole("button", { name: "Spara som MP3", exact: true }).click();
    await expect(quotaPage.getByText("MP3 klar — kunde inte sparas i webbläsaren", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(quotaPage.getByRole("alert").filter({ hasText: /lagringsutrymme är fullt/i })).toBeVisible();
    const downloadEvent = quotaPage.waitForEvent("download");
    await quotaPage.getByRole("link", { name: "Ladda ner MP3", exact: true }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), "Full lagring.mp3");
    const mp3 = await readFile(await download.path());
    assert.equal(isRealMp3(mp3), true);
    assert.ok((await decodeMp3(mp3)).length > 48_000);
    assert.equal((await savedRecords(quotaPage)).length, 0);
    console.log("OK: full IndexedDB-lagring ger ett begripligt fel och en riktig MP3 för direktnedladdning");
  } finally { await quotaContext.close(); }
} finally { await browser.close(); }

// This browser intentionally omits fake-UI auto-grant. CDP explicitly denies
// microphone permission, and the fake-device flag still prevents real capture.
const deniedBrowser = await chromium.launch({ headless: true, args: fakeDeviceArgs });
try {
  const context = await deniedBrowser.newContext();
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  await cdp.send("Browser.setPermission", { permission: { name: "microphone" }, setting: "denied", origin, browserContextId: targetInfo.browserContextId });
  await page.goto(origin, { waitUntil: "networkidle" });
  assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: "microphone" })).state), "denied");
  await openRecorder(page);
  await page.getByRole("button", { name: "Starta inspelning", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /mikrofon|tillåtelse|behörighet/i }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Starta inspelning", exact: true })).toBeEnabled();
  console.log("OK: nekad mikrofonbehörighet visas begripligt och går att försöka igen");
} finally { await deniedBrowser.close(); }
assert.deepEqual(errors, [], "Inga okontrollerade JavaScript-fel");
console.log("PASS: inspelning i desktop/mobil, verklig MP3, lokalt sparande, behörigheter och städning");
