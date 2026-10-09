import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import ffmpeg from "ffmpeg-static";
import { unzipSync, strFromU8 } from "fflate";
import { isRealMp3 } from "../src/lib/media-format.ts";
const origin = process.env.LIVE_TEST_ORIGIN || "http://127.0.0.1:3003";
function audio(args, input) { return new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], { shell: false, windowsHide: true });
  const output = []; let error = ""; child.stdout.on("data", data => output.push(data)); child.stderr.on("data", data => error += data); child.on("error", reject); child.on("close", code => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(error))); child.stdin.on("error", reject); child.stdin.end(input);
}); }
async function decode(bytes) { assert.ok(isRealMp3(bytes)); const pcm = await audio(["-f", "mp3", "-i", "pipe:0", "-f", "s16le", "pipe:1"], bytes); assert.ok(pcm.length > 24000); }
const status = await (await fetch(origin + "/api/status")).json(); assert.equal(status.conversionLocation, "browser");
for (const query of ["source=archive&id=http://127.0.0.1&file=x.mp3", "source=commons&id=https://evil.example/a.mp3", "source=archive&id=valid&file=../x.mp3"]) assert.equal((await fetch(origin + "/api/download?" + query)).status, 400);
const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } }); const errors = []; page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("button", { name: "Konvertera & CD" }).click();
  for (const [extension, format, codec, extra] of [["flac", "flac", "flac", []], ["m4a", "mp4", "aac", ["-movflags", "frag_keyframe+empty_moov"]], ["mp3", "mp3", "libmp3lame", ["-b:a", "320k"]], ["ogg", "ogg", "libopus", []]]) {
    const file = await audio(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", codec, ...extra, "-f", format, "pipe:1"]);
    await page.locator('input[type="file"]').setInputFiles({ name: `egen.${extension}`, mimeType: "audio/" + format, buffer: file });
    await page.getByLabel(/Artist/).fill("Test"); await page.getByLabel(/Låttitel/).fill(extension.toUpperCase());
    await page.getByRole("radio", { name: /128 kbps/ }).check({ force: true });
    await page.getByLabel("Jag äger filen eller har uttryckligt tillstånd att konvertera den.").check();
    const next = page.waitForEvent("download", { timeout: 150_000 }); await page.getByRole("button", { name: "Konvertera till MP3", exact: true }).click();
    const download = await next; assert.equal(download.suggestedFilename(), `Test - ${extension.toUpperCase()}.mp3`);
    const output = await readFile(await download.path()); await decode(output);
    if (extension === "mp3") assert.ok(output.length < file.length, "320 kbps MP3 input must really be re-encoded at selected 128 kbps quality");
    console.log(`OK: ${extension.toUpperCase()} → FFmpeg WASM → avkodningsbar MP3`);
  }
  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("button", { name: "Upptäck musik" }).click();
  await page.getByRole("button", { name: "Wikimedia Commons", exact: true }).click();
  await page.getByRole("searchbox").fill("Beethoven");
  const result = page.waitForResponse(response => response.url().includes("/api/search?") && response.status() === 200);
  await page.getByRole("button", { name: "Sök musik", exact: true }).click();
  const data = await (await result).json();
  const track = data.tracks.filter(item => item.downloadAllowed && item.size < 2 * 1024 * 1024).sort((a,b) => a.size-b.size)[0];
  assert.ok(track, "Commons måste lämna minst ett verkligt licensierat ljud under 2 MB.");
  const row = page.locator(".track-row").filter({ has: page.getByRole("heading", { name: track.title, exact: true }) }).first();
  const next = page.waitForEvent("download", { timeout: 150_000 }); await row.getByRole("button", { name: `Ladda ner ${track.title} som MP3` }).click();
  const download = await next; await decode(await readFile(await download.path()));
  await row.getByRole("button", { name: `Lägg till ${track.title} i nedladdningslistan` }).click();
  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("button", { name: /Nedladdningslista/ }).click();
  const zipped = page.waitForEvent("download", { timeout: 150_000 }); await page.getByRole("button", { name: "Hämta som ZIP", exact: true }).click();
  const entries = unzipSync(await readFile(await (await zipped).path()));
  const music = Object.keys(entries).filter(name => name.endsWith(".mp3")); assert.equal(music.length, 1); await decode(entries[music[0]]);
  const license = JSON.parse(strFromU8(entries["LICENSER.json"])); assert.equal(license.låtar[0].original, track.sourceUrl); assert.equal(license.låtar[0].licensUrl, track.license.url); assert.deepEqual(JSON.parse(strFromU8(entries["FEL.json"])), []);
  console.log(`OK: Commons ${track.format} → riktig MP3 och ZIP med samma källans licens`);
  assert.deepEqual(errors, []); console.log("PASS: Sites-format, verkliga källor, MP3, ZIP, licenser och validering");
} finally { await browser.close(); }
