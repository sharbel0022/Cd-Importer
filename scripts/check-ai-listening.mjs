import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import console from 'node:console';
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const results = [];
try {
  await page.goto('http://127.0.0.1:8769/');
  for (const extension of ['mp3', 'mp4']) {
    const url = `http://127.0.0.1:8769/en-dub.${extension}`;
    const response = await page.request.get(url);
    assert.equal(response.status(), 200);
    const downloaded = await response.body();
    assert(downloaded.equals(await readFile(`test-results/ai-listening/en-dub.${extension}`)));
    const range = await page.request.get(url, { headers: { Range: 'bytes=0-15' } });
    assert.equal(range.status(), 206);
    assert.equal(range.headers()['content-range'], `bytes 0-15/${downloaded.length}`);
    assert((await range.body()).equals(downloaded.subarray(0, 16)));
    const invalidRange = await page.request.get(url, { headers: { Range: `bytes=${downloaded.length}-` } });
    assert.equal(invalidRange.status(), 416);
    const traversal = await page.request.get('http://127.0.0.1:8769/..%2f..%2f.env.local');
    assert.equal(traversal.status(), 404);
    const playback = await page.evaluate(async extension => {
      const { document, AudioContext, setTimeout } = globalThis;
      const media = document.querySelector(`[src="en-dub.${extension}"]`);
      const context = new AudioContext();
      const source = context.createMediaElementSource(media);
      const analyser = context.createAnalyser();
      source.connect(analyser); analyser.connect(context.destination);
      await context.resume();
      await media.play();
      let peakRms = 0;
      const samples = new Float32Array(analyser.fftSize);
      for (let i = 0; i < 25; i++) {
        await new Promise(r => setTimeout(r, 80));
        analyser.getFloatTimeDomainData(samples);
        peakRms = Math.max(peakRms, Math.sqrt(samples.reduce((n, value) => n + value * value, 0) / samples.length));
      }
      const playedTo = media.currentTime;
      media.currentTime = 5;
      await new Promise(r => setTimeout(r, 400));
      const result = { duration: media.duration, playedTo, soughtTo: media.currentTime, peakRms,
        sampleRate: context.sampleRate, mediaError: media.error?.message || null,
        videoWidth: media.videoWidth || null, videoHeight: media.videoHeight || null };
      media.pause(); await context.close(); return result;
    }, extension);
    console.log(extension, JSON.stringify(playback));
    assert(playback.playedTo > 1.4 && playback.soughtTo >= 5);
    assert(playback.peakRms > .001 && playback.mediaError === null);
    assert(Math.abs(playback.duration - 8.16) < .05);
    if (extension === 'mp4') assert(playback.videoWidth === 640 && playback.videoHeight === 360);
    results.push({ extension, sha256: createHash('sha256').update(downloaded).digest('hex'), ...playback });
  }
  assert.equal(errors.length, 0);
  await writeFile('test-results/ai-listening/browser-report.json', JSON.stringify({ passed: true, results, errors,
    scope: 'Actual browser decoding, sample energy, playback, seek and byte identity. Not a human listening result.' }, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); }
