import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { unzipSync, strFromU8 } from "fflate";
import { ffmpegPath } from "../src/lib/ffmpeg";
import { isRealMp3 } from "../src/lib/media";
import { trackQuery, trackRef, type Track, type SearchResponse } from "../src/lib/types";

const origin = process.env.LIVE_TEST_ORIGIN || "http://127.0.0.1:3000";
async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(180_000) });
}
async function checked(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response;
}
function wav(): Buffer {
  const sampleRate = 22050;
  const samples = sampleRate;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 8000), 44 + i * 2);
  return bytes;
}
async function decode(bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "null", "-"], { shell: false, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let diagnostic = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("FFmpeg-avkodningen tog för lång tid.")); }, 60_000);
    child.stderr.on("data", chunk => diagnostic += String(chunk).slice(0, 2000));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(diagnostic || "MP3-avkodning misslyckades")); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(bytes);
  });
}
async function main() {
  const status = await (await checked(await call("/api/status"))).json();
  assert.equal(status.ffmpeg.available, true, status.ffmpeg.message);
  assert.equal((await call("/api/search?q=a")).status, 400);
  assert.equal((await call("/api/download?source=archive&id=https%3A%2F%2Flocalhost&file=a.mp3")).status, 400);
  console.log("OK: FFmpeg och validering");

  const search = await (await checked(await call("/api/search?q=Kevin%20MacLeod&source=archive&page=1&licensedOnly=true"))).json() as SearchResponse;
  const track = search.tracks.filter((entry: Track) => entry.downloadAllowed && entry.format === "MP3").sort((a, b) => (a.size || 50e6) - (b.size || 50e6))[0];
  assert.ok(track, "Den verkliga sökningen gav ingen tillåten MP3. Prova senare.");
  assert.ok(track.license.url && track.sourceUrl);
  console.log(`OK: Internet Archive ${search.tracks.length} spår; väljer ${track.artist} – ${track.title}`);

  const download = await checked(await call("/api/download?" + trackQuery(track)));
  assert.match(download.headers.get("content-type") || "", /audio\/mpeg/);
  assert.match(download.headers.get("content-disposition") || "", /\.mp3/);
  const mp3 = new Uint8Array(await download.arrayBuffer());
  assert.ok(isRealMp3(mp3));
  await decode(mp3);
  const license = await (await checked(await call("/api/license?" + trackQuery(track)))).json();
  assert.equal(license.original, track.sourceUrl);
  assert.equal(license.licensUrl, track.license.url);
  console.log(`OK: riktig MP3 ${mp3.length} byte, avkodad av FFmpeg, källa/licens bevarad`);

  const audio = await checked(await call("/api/audio?" + trackQuery(track), { headers: { Range: "bytes=0-1023" } }));
  assert.equal(audio.status, 206);
  assert.match(audio.headers.get("content-range") || "", /^bytes 0-1023\/\d+$/);
  assert.equal((await audio.arrayBuffer()).byteLength, 1024);
  console.log("OK: uppspelningens Range-anrop");

  const commons = await (await checked(await call("/api/search?q=Beethoven&source=commons&page=1&licensedOnly=false"))).json() as SearchResponse;
  assert.ok(commons.tracks.length, "Wikimedia Commons gav inga riktiga ljudresultat.");
  assert.ok(commons.tracks.every(entry => entry.source === "commons"));
  const commonsTrack = commons.tracks.find(entry => entry.downloadAllowed && (entry.size || Infinity) < 10 * 1024 * 1024);
  if (commonsTrack) {
    const converted = new Uint8Array(await (await checked(await call("/api/download?" + trackQuery(commonsTrack)))).arrayBuffer());
    assert.ok(isRealMp3(converted)); await decode(converted);
    console.log(`OK: Commons ${commonsTrack.format} → verklig avkodningsbar MP3`);
  }
  console.log(`OK: Wikimedia Commons ${commons.tracks.length} spår med verkliga källuppgifter`);

  const form = new FormData();
  form.set("file", new File([new Uint8Array(wav())], "test.wav", { type: "audio/wav" }));
  form.set("bitrate", "256"); form.set("artist", "Testartist"); form.set("title", "Egen ljudfil");
  assert.equal((await call("/api/convert", { method: "POST", body: form })).status, 403);
  form.set("rightsConfirmed", "true");
  const conversion = await checked(await call("/api/convert", { method: "POST", body: form }));
  assert.match(conversion.headers.get("content-disposition") || "", /Testartist - Egen ljudfil/);
  const converted = new Uint8Array(await conversion.arrayBuffer());
  assert.ok(isRealMp3(converted)); await decode(converted);
  console.log("OK: egen WAV → MP3 256 kbps och rättighetsbekräftelse");

  const batch = await checked(await call("/api/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    tracks: [trackRef(track), { source: "archive", id: "cd-importer-test-missing-20261008", file: "missing.mp3" }], bitrate: 192,
  }) }));
  const zip = unzipSync(new Uint8Array(await batch.arrayBuffer()));
  assert.ok(zip["LICENSER.json"] && zip["FEL.json"]);
  assert.ok(Object.keys(zip).some(name => name.endsWith(".mp3")));
  const failures = JSON.parse(strFromU8(zip["FEL.json"]));
  assert.equal(failures.length, 1);
  const attribution = JSON.parse(strFromU8(zip["LICENSER.json"]));
  assert.equal(attribution.låtar[0].original, track.sourceUrl);
  assert.equal(JSON.parse(decodeURIComponent(batch.headers.get("x-skipped-tracks") || "[]")).length, 1);
  console.log("OK: ZIP med MP3, licensmanifest och separat felrapport");
  console.log(JSON.stringify({ result: "PASS", archiveTrack: trackRef(track), archiveTitle: track.title, commonsTracks: commons.tracks.length, mp3Bytes: mp3.length }, null, 2));
}
main().catch(error => { console.error("Live-kontrollen misslyckades:", error instanceof Error ? error.message : error); process.exitCode = 1; });
