import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
const origin = process.env.LIVE_TEST_ORIGIN || "http://127.0.0.1:3000";
await mkdir("test-results", { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
function wav() {
  const samples = 22050; const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(samples, 24); bytes.writeUInt32LE(samples * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i=0;i<samples;i++) bytes.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/samples)*8000),44+i*2);
  return bytes;
}
try {
  await page.goto(origin, { waitUntil: "networkidle", timeout: 60_000 });
  assert.equal(await page.locator("html").getAttribute("lang"), "sv");
  assert.ok((await page.locator("h1").textContent()).includes("Hitta ljud."));
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
  console.log("OK: svensk startsida, desktop");

  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("button", { name: "Konvertera & CD" }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "egen.wav", mimeType: "audio/wav", buffer: wav() });
  await page.getByText("Bäst kvalitet", { exact: true }).click();
  assert.ok(await page.getByRole("radio", { name: /320 kbps/ }).isChecked());
  await page.getByLabel(/Artist/).fill("UI-test");
  await page.getByLabel(/Låttitel/).fill("Egen ljudfil");
  await page.getByLabel("Jag äger filen eller har uttryckligt tillstånd att konvertera den.").check();
  const conversionDownload = page.waitForEvent("download", { timeout: 45_000 });
  await page.getByRole("button", { name: "Konvertera till MP3", exact: true }).click();
  const ownDownload = await conversionDownload;
  assert.equal(ownDownload.suggestedFilename(), "UI-test - Egen ljudfil.mp3");
  await page.getByText("Din MP3 är klar", { exact: true }).waitFor();
  console.log("OK: formulär → FFmpeg → riktig MP3-nedladdning i webbläsaren");

  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("button", { name: "Upptäck musik" }).click();
  await page.getByRole("button", { name: "Internet Archive", exact: true }).click();
  await page.getByRole("searchbox", { name: "Låtnamn eller artist" }).fill("Kevin MacLeod");
  const searchResponse = page.waitForResponse(response => response.url().includes("/api/search?") && response.status() === 200, { timeout: 60_000 });
  await page.getByRole("button", { name: "Sök musik", exact: true }).click();
  const result = await (await searchResponse).json();
  await page.locator(".track-row").first().waitFor();
  const selected = result.tracks.filter(track => track.playbackAllowed && track.downloadAllowed && track.format === "MP3").sort((a,b)=>(a.size||50e6)-(b.size||50e6))[0];
  assert.ok(selected);
  const row = page.locator(".track-row").filter({ has: page.getByRole("heading", { name: selected.title, exact: true }) }).first();
  await row.getByRole("button", { name: `Visa källa och licens för ${selected.title}` }).click();
  await page.getByRole("dialog").waitFor();
  assert.ok(await page.getByRole("dialog").getByRole("link", { name: /Visa originalkällan/ }).getAttribute("href"));
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: `Lägg till ${selected.title} i nedladdningslistan` }).click();

  await row.getByRole("button", { name: `Spela ${selected.title}` }).click();
  await page.waitForFunction(() => { const audio=document.querySelector("audio"); return audio && !audio.paused && audio.currentTime>0; }, undefined, { timeout: 60_000 });
  await page.getByRole("button", { name: "Pausa musiken", exact: true }).click();
  assert.ok(await page.locator("audio").evaluate(audio=>audio.paused));
  await page.getByRole("slider", { name: "Volym", exact: true }).press("ArrowLeft");
  assert.ok(await page.locator("audio").evaluate(audio => audio.volume < 0.75));
  console.log("OK: verkliga sökresultat, licensdialog, spela/pausa och volym");

  const mp3Download = page.waitForEvent("download", { timeout: 90_000 });
  await row.getByRole("button", { name: `Ladda ner ${selected.title} som MP3` }).click();
  assert.match((await mp3Download).suggestedFilename(), /\.mp3$/);
  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("button", { name: /Nedladdningslista/ }).click();
  assert.equal(await page.locator(".track-row").count(), 1);
  console.log("OK: verklig MP3-nedladdning och nedladdningslista");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("navigation", { name: "Huvudmeny" }).getByRole("button", { name: /Nedladdningslista/ }).click();
  assert.equal(await page.locator(".track-row").count(), 1);

  for (const [width,height] of [[390,844],[360,800],[768,1024]]) {
    await page.setViewportSize({width,height});
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow,false,`Horisontell overflow vid ${width}px`);
    await page.screenshot({ path: `test-results/mobile-${width}.png`, fullPage:true });
    const mobile = await page.getByRole("navigation", { name: "Mobilmeny" }).isVisible();
    const nav = page.getByRole("navigation", { name: mobile ? "Mobilmeny" : "Huvudmeny" });
    await nav.getByRole("button", { name: mobile ? "Konvertera" : "Konvertera & CD", exact:true }).click();
    assert.ok(await page.getByRole("button", { name:"Konvertera till MP3", exact:true }).isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),false);
    await nav.getByRole("button", { name: mobile ? "Din lista" : /Nedladdningslista/ }).click();
  }
  assert.deepEqual(errors,[]);
  console.log("PASS: gränssnitt, beständig lista, desktop +390/360/768px, inga JavaScript-fel");
} finally { await browser.close(); }
