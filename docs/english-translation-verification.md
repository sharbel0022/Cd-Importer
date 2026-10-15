# English-priority translation verification — 2026-10-15

This report records the current run separately from earlier Arabic–Swedish experiments. Original saved jobs and the actual WhatsApp file were preserved. The working tree was clean on `main` at `26f1d8c` before this work.

## Changes

- `/translation` defaults to English (US), with English (UK), Swedish, Arabic and the installed provider languages. Voice selection follows real language/accent metadata; automatic selection is available. Speech rate is adjustable from 0.85 to 1.20. A preview button synthesizes actual audio.
- Original and translated players appear side by side with synchronized comparison. Transcript, translation and timing are editable. An uncertain transcript requires explicit review before translation/dubbing. Source corrections invalidate the affected translation rows; unchanged TTS remains cached.
- Whisper retains acoustic word probabilities, original words, raw text, quality reasons and language confidence. Linguistic corrections are reviewable. VAD and bounded long-file chunking remain part of the existing worker.
- Translation uses a bilingual model review and deterministic number, polarity and defensible name checks. These checks cannot prove full semantic equivalence or Arabic name transliteration.
- Timing uses absolute sample positions and checks measured stretched audio. Speech cannot silently extend beyond its allocated window or disappear at the end of the video. Overlap or unfit speech prevents final media publication.
- MP4 export keeps the original video bitstream and duration and encodes AAC audio. Voice-over and separate SRT/VTT subtitles retain their existing distinct behavior.
- Missing models, malformed provider responses and invalid media produce explicit failures. Real tests caught a NumPy scalar JSON serialization failure which was fixed before rerunning.

## Installed and independently exercised models

ASR: faster-whisper large-v3, CPU int8. Translation: local Ollama `translategemma:12b` for English through the optional `OLLAMA_ENGLISH_MODEL` setting; `gemma3:12b` remains selected for Swedish and image context. The override was enabled after Gemma repeatedly changed storm terminology/scope. TranslateGemma can also make errors: the fact guard still applies, and a correct original draft is retained if its editing pass introduces a detected factual error. English Piper voices: `en-us-lessac`, `en-us-ryan`, `en-gb-alba`, `en-gb-alan`. Swedish/Arabic voices remain installed. Model files and private configuration are ignored by Git; local hashes and revisions are in `local-ai/models/manifest.json`.

All four English voices generated valid WAV audio. In separate, unprompted medium-model ASR runs, all identified as English and retained the preview's quantity, weekday, time and negation. Only Alba reproduced the name Ahmed exactly; the others produced different spellings. This is a pronunciation/transcription limitation requiring review, not evidence of a measured naturalness score. Evidence: `test-results/english-voice-verification/independent-asr.json`.

Model licences differ. Ryan's card states CC BY-NC-SA 4.0; Alba states CC BY 4.0. Lessac's card links a research-only training-data licence; Alan's card refers to its Mimic3 source. Read the downloaded model cards before selecting a voice for distribution or commercial use. This run establishes synthesis capability, not additional usage rights. OpenAI TTS, XTTS, Demucs and real diarization were not exercised because their credentials/models were not installed/configured for this run.

## Raw ASR comparison

Both models ran without text prompts or language hints, using CPU int8, beam 5, temperature fallback, VAD and word timestamps. Human reference: [Google FLEURS](https://huggingface.co/datasets/google/fleurs), Arabic `ar_eg` test row 0 (CC BY 4.0). Raw WER was 20% for medium and 13.33% for large-v3. The latter took 26.77 seconds on this short clip. WER is calculated before the bounded ordinal correction; it is not a semantic score.

The actual 49.67-second WhatsApp file was found as `.translation-data/5e114396-c5ad-4244-be1c-6b78ef4c456d/original.mp4`. Medium took 44.23 seconds; large-v3 took 266.99 seconds and produced 34 words below 0.5 acoustic probability versus medium's 24. Both transcripts contained uncertain and inconsistent dialectal phrases. There is no authoritative verbatim reference for this clip, so neither accuracy nor factual correctness can be scored. Large-v3's lower error on the weather clip does not establish superiority on this conversation.

Raw evidence: `test-results/asr-comparison-20261015T124229Z/report.json`. Reproduce with:

```powershell
local-ai/.venv/Scripts/python.exe scripts/compare-translation-asr.py local-ai/fixtures/fleurs-ar-eg-test-0.wav path/to/your-video.mp4
```

## End-to-end results

| Test | Actual result and evidence |
| --- | --- |
| A: Arabic MP3 → English | **32/32 fact checks passed**, WAV/MP3/M4A independently detected as English. WER 4.5%, due to `tenth` versus `10th`. Ryan US voice. Report: `test-results/local-translation-en-2026-10-15T13-26-24-594Z/report.json`. |
| B/E: Arabic video → English, name and ordinal | **39/39 fact checks passed** across text/WAV/MP3/M4A/MP4, including Jerry, tenth, season, today, Atlantic and subtropical storm. WER 3.6%, the same ordinal spelling difference. Lessac US voice. Video duration 8.16 s, matching source. Measured speech 9.03 s fitted at ×1.1503, no measured window overflow. Report: `test-results/local-translation-en-2026-10-15T13-21-27-406Z/report.json`. |
| C: Human Swedish WAV → English | **34/34 checks passed**, 0% WER in WAV/MP3/M4A. Report: `test-results/local-translation-en-2026-10-15T13-13-54-041Z/report.json`. |
| D: Human English MP3 → Swedish | **19/19 checks passed**, 15.4% WER. ASR rendered `mil bort` as `milbarn`; pronunciation versus recognition remains uncertain. Correct 6.62 s WAV duration after the FFmpeg timestamp fix. Report: `test-results/local-translation-sv-2026-10-15T13-13-54-136Z/report.json`. |
| F: Five-minute timing | Constructed video with the same real human English utterance every 30 s. After explicitly correcting five erroneous ASR starts against the known construction, WAV/MP4 are exactly 300 s. All ten audible starts were 40 ms after the reference positions, including the final one at 270.82 s: no accumulated drift, no audible samples outside the expected windows. Independent ASR in five 60 s chunks gave 0% WER for both WAV and MP4. Report: `test-results/local-translation-en-2026-10-15T13-23-15-189Z/report.json`. This is an identity-language timing test, not five minutes of spontaneous Arabic conversation. |
| G: Two speakers with real diarization | **Not verified**: no real diarization provider/model was enabled. The interface disables it. Automated provider/FFmpeg tests use explicitly mocked speaker turns. |
| H: Invalid media/missing model | Covered by real FFmpeg invalid-input tests and gateway/provider contract tests; missing configured English/Whisper models and malformed responses cannot produce a successful export. No unavailable cloud credentials were invented. |

Arabic source audio is human-recorded FLEURS `ar_eg` test row 0. The video wraps that recording in a generated solid-color picture; it is **not the WhatsApp video**. Swedish and English clips are FLEURS validation row 0, downloaded with `scripts/fetch-translation-fixtures.py`, with references and attribution under `local-ai/fixtures/`. Arabic source transcripts were explicitly corrected to the official reference and approved in the app before dubbing; these Arabic runs are **not fully automatic ASR successes**. No manual English target text was substituted in the passing A/B/E tests. The timing test used explicit manual timestamp correction, saved in `test-results/english-inputs/long-timing-review.json`.

The reference video was genuinely uploaded through the browser UI; upload evidence is `test-results/local-translation-en-2026-10-15T13-10-32-528Z/report.json` (the initial run stopped for source review). After review, the actual downloaded MP4 played at 640×360 in Chromium without page errors. Separate bitstream comparison confirmed identical H.264 video bytes, AAC LC at 48 kHz, and −16.0 LUFS in the output; see the successful video's `media-verification.json`.

Approved English downloads:

- MP3 from the Arabic MP3: `test-results/local-translation-en-2026-10-15T13-26-24-594Z/en-export.mp3`.
- MP4 from the reference video: `test-results/local-translation-en-2026-10-15T13-21-27-406Z/en-export.mp4`.
- The same video report directory also contains English WAV, MP3 and M4A.

The actual WhatsApp job is `2356e578-9bb3-4438-a33c-b42791e2ea44` in the isolated `test-results/english-priority-jobs` directory. It has status **review**, no approved dubbed output, and its source remains intact. The user explicitly chose “Behåll videon för granskning.” No claim of verified WhatsApp English content or dubbing is made.

## Rejected runs and remaining limits

Earlier real runs exposed and reproduced NumPy JSON HTTP500, ambiguous Jerry synthesis, omitted season scope during shortening, an editor worsening an accurate draft, a 25-second VAD word-timing gap, and a 6.62→6.54 s FFmpeg output timestamp error. These results were not counted as passes. The new quality/timing guards, measured sample clock and explicit correction paths were added from those failures.

One unchunked ASR pass over the repetitive five-minute output omitted three repeated sentences (30% WER), despite all ten audible positions being present. The final verification therefore independently transcribes the entire output in bounded 60-second chunks without text or language hints. The earlier partial diagnostic remains under `test-results/local-translation-en-2026-10-15T13-13-54-075Z`; the final report records the actual chunk method. This is an ASR limitation, not permission to ignore missing speech.

There was no human listening panel, MOS score, authorized cloning test, real diarization, Demucs evaluation, noisy dialect benchmark or general translation-quality score. Word probabilities are review signals, not calibrated correctness probabilities. Proper names and arbitrary semantic facts can still be wrong; the passing results apply to the disclosed recordings. Standard OpenAI adapters remain available but were not exercised with real credentials.

## Automated checks and changed files

Final checks: **317 JavaScript/TypeScript tests**, **23 Python tests**, lint, typecheck, production build, and the full fixture browser flow passed. Automated AI responses are explicit fixtures; FFmpeg, codecs, routes, disk jobs and browser actions are real. Browser coverage includes English US/UK, speed, compatible voices, actual preview generation, manual missing-target repair, source approval, downloads, comparison players, Live capture/playback and mobile layouts. Subtitle mode was verified without TTS and made zero synthesis calls. Latest browser fixture: `test-results/translation-ui-3d10aeb5-a375-40ff-8342-de1e091c0b53/report.json`. Final command logs: `test-results/final-checks/`.

The final production server was restarted with the current build and normal single-gateway configuration. `test-results/final-checks/real-browser.json` confirms correct computed text styling, no failed script/stylesheet responses, no page errors, and synchronized original→English MP4 playback. `real-browser.png` records that final interface.

Changed implementation files: `local-ai/{server.py,asr_quality.py,asr_cleanup.py,mms_voice.py,setup_models.py}`; `src/lib/translation/{types,providers,pipeline,media,meaning}.ts`; `src/app/api/translation/jobs/[id]/route.ts`, `live/route.ts`, new `preview/route.ts`; `src/components/translation-{studio,editor,voice-preview}.tsx`; translation CSS and guide. Updated/added Python and translation regression tests, real verification scripts, model comparison/fixture download helpers, local configuration, `.env.example`, README and translation documentation. Music/CD/recording/notation implementation files were not rewritten, and their existing automated tests passed.

## Windows usage

From the repository directory, run these in three PowerShell terminals:

```powershell
npm.cmd run studio:gateway
```

```powershell
npm.cmd run studio:worker
```

```powershell
npm.cmd run build
npm.cmd start -- --port 3012
```

Open `http://127.0.0.1:3012/translation`. Select English (US), choose automatic voice or an installed English voice, confirm media rights, upload and start translation. If the source needs review, listen to the original, edit uncertain words, save, and explicitly approve the transcript. Preview the output and download MP3/WAV/M4A or MP4 for video. Download the files you want to keep; normal inactive-job retention is 24 hours. Gateway, worker and frontend must read the same configuration. Use another port if 3012 is occupied.

To recreate English voice installation: run `local-ai/.venv/Scripts/python.exe local-ai/setup_models.py`, `ollama pull gemma3:12b`, `ollama pull translategemma:12b`, then `npm.cmd run studio:configure-local`. Add `OLLAMA_ENGLISH_MODEL=translategemma:12b` to `.env.local` and restart the processes. Downloads require internet; configured inference runs locally. Configuration retains the existing gateway token, optional model override and custom voices.

## Sites status

The Sites API confirmed existing project `appgprj_6ac7b4be7e588191b146990bfc07c089`, **TON · Music Downloader**, active/public, version 5, at [TON on Sites](https://ton-cd-importer.asdasdsa213.chatgpt.site). No new version was published. The existing Site cannot execute the native Python/FFmpeg worker or reach this computer's loopback services. No authenticated public translation backend, job ownership or remote media storage was configured. Publishing this local translation UI as working hosted dubbing would be incorrect; the current music Site remains available.
