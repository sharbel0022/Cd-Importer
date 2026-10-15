# Ultimate Studio – baseline gap analysis

Audit date: 2026-10-15. Repository and remote `main` both resolve to `69fe3dfb05cc06785d584b2ee4ab2e02c54dda7e`; the worktree was clean. The request's `2afab81` is an older baseline. This audit was completed before new implementation. Subsequent work and current statuses belong in [ultimate-studio-progress.md](ultimate-studio-progress.md).

Classification meanings: `IMPLEMENTED_AND_VERIFIED` has recorded tests for the stated scope; `IMPLEMENTED_NOT_VERIFIED` has code without the relevant real validation; `PARTIALLY_IMPLEMENTED` covers only part of the requested behavior; `MISSING` has no connected implementation; `BLOCKED` identifies a concrete dependency or unavailable evidence. Historical test artifacts were inspected, not rerun during this audit. Fixture AI responses establish plumbing, not real AI quality.

## Inventory and evidence

The repository retains its Next.js music search/download/CD conversion, microphone/computer recording, original audio editor and separate notation/studio prototype. Translation uses Node route handlers, a disk JSON job queue, a single separately running worker, FFmpeg, a loopback FastAPI gateway and optional cloud adapters. `node_modules/next/dist/docs/.../route.md` was read for the installed Next 16.4 contract.

Evidence keys:

- **A**: `src/lib/translation/{types,providers,pipeline,media,meaning,store}.ts`, `src/app/api/translation/`, `scripts/translation-worker.ts`.
- **B**: `src/components/translation-{studio,editor,voice-preview,live}.tsx`, `src/app/translation/translation.css`.
- **C**: `local-ai/{server,asr_quality,asr_cleanup,speech_text,mms_voice,setup_models}.py`, installed model cards and `local-ai/models/manifest.json` (ignored).
- **D**: `tests/translation*.test.ts`, Python tests, `scripts/translation-ui-check.mjs`; historical baseline **330 JS/TS + 23 Python passes**, lint/typecheck/build.
- **E**: `docs/faithful-translation-verification.md`, `test-results/final-faithful-browser/report.json`, real FLEURS and fidelity reports. Arabic MP4 success included an explicit published-reference source correction; no broad unattended ASR claim.
- **F**: `src/components/audio-editor.tsx`, `public/studio/{app.js,index.html}`, music/recording/notation test scripts. The separate studio's AI panel is disconnected and is not counted as Translation Studio integration.

## Capability matrix at baseline

| Capability | Classification | Evidence / exact gap |
| --- | --- | --- |
| Existing music, recording, CD conversion and notation retained | IMPLEMENTED_AND_VERIFIED | F; regression sources and historical suite. Not a new translation feature. |
| Upload, format limits, progress, filename/size/duration | IMPLEMENTED_AND_VERIFIED | A/B/D/E; real streaming upload, validation and worker media inspection. |
| Automatic language ID, word timestamps, VAD | IMPLEMENTED_AND_VERIFIED | C/D/E for disclosed recordings; decoder scores are not calibrated accuracy. |
| Long-audio chunks at silence, bounded resources | IMPLEMENTED_AND_VERIFIED | A/D; whole-hour absolute sample-position test is synthetic, not an hour-long conversation benchmark. |
| Raw acoustic text, separate source edits and approvals | IMPLEMENTED_AND_VERIFIED | A/B/D/E; raw JSON and edit history retained. |
| Hallucination/repetition, low scores and timing-gap review | IMPLEMENTED_AND_VERIFIED | C/D/E; heuristics flag, never replace words. |
| Arabic/English code switching | PARTIALLY_IMPLEMENTED | Multilingual decoding and Arabic/Latin script indicator; no code-switching reference benchmark. |
| Swedish/English code switching | PARTIALLY_IMPLEMENTED | Multilingual model can decode it; Latin script alone cannot identify a language switch. |
| MSA, Lebanese, Syrian, Egyptian, Iraqi, Gulf, Palestinian accuracy | PARTIALLY_IMPLEMENTED | Acoustic model and review cover languages/dialects; no verified per-dialect accuracy or equivalent-quality claim. |
| Mispronunciation versus genuinely wrong words/facts | PARTIALLY_IMPLEMENTED | Faithfulness policy and uncertainty controls exist; acoustic interpretation still needs real human references. |
| Names, numbers, ordinals, dates, negations and contradictions | PARTIALLY_IMPLEMENTED | Deterministic anchors + model review tested for bounded cases; no complete semantic correctness proof. |
| Medium/large-v3 comparison | PARTIALLY_IMPLEMENTED | Two CLI scripts and saved alternatives exist; not integrated with segment work requests. |
| Turbo/Distil/alternative ASR evaluation | MISSING | No local weights or comparative measurements. English-oriented distillation is not evidence for Arabic quality. |
| Targeted ASR rerun and multi-model review per segment | MISSING | Existing regenerate action changes TTS only. |
| Optional ASR denoising / recording-quality analysis | MISSING | Normalization/VAD exist; no selectable denoise or measured clipping/noise diagnostics. |
| Stable long conversational ASR | IMPLEMENTED_NOT_VERIFIED | Chunk code exists; no appropriate human conversation reference or drift/content evaluation. |
| Modular local/Ollama and OpenAI translation adapters | IMPLEMENTED_AND_VERIFIED | A/D/E for local pairs; cloud contracts fixture-tested, real cloud account not exercised. |
| Arabic→English US, Swedish→English, English→Swedish | IMPLEMENTED_AND_VERIFIED | E, explicitly limited to disclosed recordings and corrections. |
| English UK / Arabic→Swedish | IMPLEMENTED_AND_VERIFIED | Prior disclosed voice/translation reports; no general language-quality score. |
| English→Arabic and all additional language pairs | IMPLEMENTED_NOT_VERIFIED | Capability checks/installed Arabic voice exist; new pair needs real validation. |
| Faithful and Natural modes | IMPLEMENTED_AND_VERIFIED | A/B/D/E, eight bounded real-model probes. |
| Professional and Literal modes | PARTIALLY_IMPLEMENTED | Legacy style values exist; selected translation mode exposes only two modes. |
| Reusable glossary, protected terms, abbreviations, import/export | MISSING | No persistent terminology interface or enforcement. |
| Domain context and correction memory | MISSING | Automatic picture/sports hints intentionally removed; no explicit user glossary/domain system. |
| Model-based semantic review and visible integrity disagreement | PARTIALLY_IMPLEMENTED | Unsafe drafts stay reviewable; deterministic checks do not cover every clause, scope or tense. |
| English/Arabic/Swedish voice selection, US/UK, speed and preview | IMPLEMENTED_AND_VERIFIED | A/B/C/D/E for installed Piper voices; no MOS panel. |
| Stable speaker-to-voice mapping | IMPLEMENTED_AND_VERIFIED | Contract/mocked-turn tests; real diarization remains separate. |
| Voice favorites | MISSING | No persistence/UI. |
| Emotion/style/intonation controls | MISSING | No capability-supported connected controls; do not add decorative settings. |
| Voice profile lifecycle and authorized reusable references | MISSING | Per-job references only; no reusable profile/consent/revocation model. |
| XTTS cloning adapter, consent and language gate | IMPLEMENTED_NOT_VERIFIED | C/A, XTTS correctly excludes Swedish; package/model absent. |
| Real English/Swedish/Arabic cross-language voice preservation | BLOCKED | No installed suitable cloning model or consented reference; no similarity listening evaluation. |
| Voice reference quality analysis and ordinary-voice fallback | PARTIALLY_IMPLEMENTED | Minimum duration and clear model errors exist; no SNR/clipping quality or explicit fallback workflow. |
| Real multi-speaker diarization and overlap handling | BLOCKED | Adapter and assignment code exist; pyannote package/authorized weights absent; turn fixtures are not real diarization. |
| Manual speaker/timing changes and per-speaker voices | IMPLEMENTED_AND_VERIFIED | A/B/D; actual speaker identity remains `unknown` when not measured. |
| Lip-sync model, face tracking, camera cuts, A/V association | MISSING | No connected model/render/visual evaluation. |
| Commercially usable, visually verified lip sync on local GPU | BLOCKED | No installed runtime/weights or cleared dependency license chain; do not enable unsupported models. |
| Replace voice and voice-over | IMPLEMENTED_AND_VERIFIED | A/B/D/E; voice-over uses fixed original gain. |
| Demucs separation / preserved background | IMPLEMENTED_NOT_VERIFIED | Endpoint and mixer path exist; package/model absent and tests use fixture stems. |
| Independent speech/music/noise/environment stems | MISSING | Existing two-stem vocals/background interface is not full scene decomposition. |
| Mixer gains, fades, noise reduction, clarity and loudness controls | PARTIALLY_IMPLEMENTED | Fixed 15% original mix and global normalization; no actual editable mixer. |
| Original waveform and audio/video comparison | IMPLEMENTED_AND_VERIFIED | B/D/E; browser-compatible source preview, seeking and matched timing. |
| Integrated video timeline, zoom, frames, tracks and clip editing | MISSING | Segment time fields are not a video editor. F's separate prototype cannot satisfy this. |
| Nondestructive source retention and selective segment TTS regeneration | IMPLEMENTED_AND_VERIFIED | A/D/E; original hashes, content caches, revision rejection. |
| Translation editor undo/redo and draft autosave/recovery | MISSING | Drafts live only in React state and can be discarded by navigation/remount. |
| Subtitle SRT/VTT/TXT/JSON and source/translation editing | IMPLEMENTED_AND_VERIFIED | A/B/D/E; RTL text and validated cue escaping. |
| Subtitle-only jobs / selectable MP4 subtitles | IMPLEMENTED_AND_VERIFIED | A/D; TTS unnecessary in subtitle-only mode. |
| Subtitles retained after TTS failure | MISSING | Text artifacts are written after TTS; failed status has no outputs. |
| Bilingual/speaker/word subtitles, search/replace | MISSING | No export modes or integrated search. |
| Subtitle styling, fonts, outline/position/safe area and burn-in | MISSING | No renderer/options. |
| Absolute sample timing, pitch-preserving atempo, no clipping/overlap | IMPLEMENTED_AND_VERIFIED | A/D/E for tests; no lip-motion coordination. |
| Duration/stream/decode checks and exact preview/download revision | IMPLEMENTED_AND_VERIFIED | A/D/E; browser byte equality and Range tested. |
| Persistent output checksum/provenance manifest | PARTIALLY_IMPLEMENTED | Revision exists; verification scripts hash files but API does not expose a durable manifest. |
| Four-second live capture, silence gate, queue, abort and bilingual text | IMPLEMENTED_AND_VERIFIED | B/D fixture browser evidence; not a real-time quality benchmark. |
| Incremental ASR/translation/TTS and bidirectional streaming | MISSING | NDJSON streams final block events, not incremental acoustic inference. |
| Separate live partial/final/text/audio latency metrics | PARTIALLY_IMPLEMENTED | One actual audible-start latency only. |
| Reconnect, device selection and interruption-aware live streaming | PARTIALLY_IMPLEMENTED | Abort/bounded queues exist; no reconnect or output selection. |
| Responsive desktop/tablet/mobile interface | IMPLEMENTED_AND_VERIFIED | Chromium widths 1440/768/390/360 and real desktop files; not physical mobile validation. |
| iPhone Safari / Android Chrome / macOS end-to-end | IMPLEMENTED_NOT_VERIFIED | Responsive code and playsInline exist; no devices/browser evidence. |
| PWA | MISSING | No manifest/service worker. |
| Job create/list/open/delete/pause/resume/cancel | IMPLEMENTED_AND_VERIFIED | A/B/D/E. |
| Project rename/duplicate/search/dashboard/media library | PARTIALLY_IMPLEMENTED | Jobs/recent list are a base; no connected full project operations. |
| Server-saved corrections and checkpoint reuse | IMPLEMENTED_AND_VERIFIED | A/D; ASR chunk/per-row translation/content-based TTS caches. |
| Worker interruption/restart preserving corrections | IMPLEMENTED_NOT_VERIFIED | Startup pauses running jobs; no dedicated process restart test. |
| Corrupt checkpoint validation and actual model fingerprint | MISSING | Cached ASR JSON is cast; key lacks source hash and actual gateway configuration. |
| Version history / download history / notifications | MISSING | Monotonic job revision only, without historical snapshot UI. |
| Collaboration roles, invitation, comments, revocation | BLOCKED | No authentication/ownership; must remain disabled in current single-user mode. |
| Authenticated public API and private user projects | MISSING | GET list/job/file lack ownership. Same-origin mutation guard is not authentication. |
| Secure distributed queue/DB/object storage/signed URLs | MISSING | Disk JSON and one worker are local, not a scalable hosted system. |
| Retention, user deletion, bounded upload/FFmpeg | IMPLEMENTED_AND_VERIFIED | A/D; retention defaults to 24 hours, not permanent backup. |
| Per-user quotas, audit log, voice consent records and revocation | PARTIALLY_IMPLEMENTED | Global process rate limits/disk scan, per-job consent booleans; no users/audit/profile lifecycle. |
| Hosted deployment, monitoring, autoscaling and Sites integration | BLOCKED | No selected authenticated inference/GPU host and storage deployment; existing Site must stay unchanged. |
| Model reuse, streaming disk I/O, cached unchanged speech | IMPLEMENTED_AND_VERIFIED | A/C/D; no advertised unmeasured speedup. |
| Parallel independent inference / batching / GPU optimization | PARTIALLY_IMPLEMENTED | Serial local semaphore, 4 CPU ASR threads, optional CUDA; GPU runtime not validated. |
| Hardware and provider report / measured quality modes | PARTIALLY_IMPLEMENTED | Health lists services, not hardware/latency/quality modes. |
| Model/provider settings, operational cost and metering | PARTIALLY_IMPLEMENTED | Environment config only; no safe settings page or metered usage. |
| Commercial license enforcement and billing interfaces | MISSING | Some enabled voices are noncommercial/unclear; no commercial gate. No customer billing configured. |
| Human listening/MOS, voice similarity, lip visual quality and dialect QA | BLOCKED | Requires authorized references, installed models and human evaluation; synthetic outputs cannot prove these. |

## Concrete baseline risks

1. Private jobs are protected by local deployment assumptions, not login or ownership. Never expose this gateway/server directly to the internet.
2. ASR cache keys use worker-side configuration, not actual gateway model/source fingerprints; cache JSON is not schema-validated. Voice references are cached by speaker ID alone and can become stale after timing changes.
3. Good translations become unavailable as subtitles when downstream TTS fails. Text exports must be published independently of successful speech generation.
4. Unsaved editor state can be lost on target/job switching or status remount. Persisted correction history does not protect those drafts.
5. Commercial use is not currently enforced. Ryan is NC-SA, MMS is NC, Lessac refers to restrictive dataset terms, and several voice cards require further license resolution. Installed is not commercially cleared.
6. The historical comparison script uses previous-text conditioning while production disables it. New benchmarks must capture matching decoder/model configuration and both raw/edited WER.

## Runtime and model constraints

Read-only runtime evidence: Python 3.13.15; 28 logical CPUs; RTX 5070 with 12,227 MiB / driver 617.42; CTranslate2 detects one CUDA device. Configured Whisper is CPU int8. Installed Torch is 2.14.1+cpu and reports no CUDA, so Torch model GPU execution is not currently available. Current RAM information was inaccessible in sandbox; earlier machine documentation is not fresh evidence.

Local ASR medium/large-v3/large-v2 weights are present. Piper has English US/UK, Swedish and Arabic voices. MMS Swedish is enabled. XTTS, pyannote and Demucs packages/models are not active. Historical WhatsApp comparison measured medium 32.73 s versus large-v3 231.73 s for approximately 49.69 s audio, **without a human reference and therefore without an accuracy score**. Its 14/15 source reviews remain unresolved.

Primary licensing/runtime sources checked during this audit: [pyannote Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) requires model access conditions; [Wav2Lip](https://github.com/Rudrabha/Wav2Lip) restricts its released result/model use; [MuseTalk](https://github.com/TMElyralab/MuseTalk) and [Chatterbox](https://github.com/resemble-ai/chatterbox) need their full runtime/model/dependency chain evaluated before integration. These are candidates, not enabled or verified features. Local downloaded model cards remain the evidence for installed Piper voice restrictions.

## Incremental execution order

1. Close Phase 1 gaps: targeted acoustic reruns preserving evidence, recoverable correction drafts, safe subtitles independent of TTS, output manifests, checkpoint integrity, four modes and terminology.
2. Build connected Phase 2 pieces that can run here: real mixer, capability/license gating, authorized voice-profile lifecycle and reference diagnostics. Validate real diarization/separation only after compatible licensed models are available; consent is mandatory for cloning.
3. Add nondestructive timeline/subtitle features and real burn-in exports; lip sync stays disabled until a licensed runtime can render and pass visual review.
4. Add reusable terminology, projects, detailed live metrics and benchmark reports; do not label block ASR as streaming inference.
5. Implement/test safe production access boundaries and document deployable storage/queue/auth contracts. Do not replace the public Site with a local-only AI façade. Advance independent tasks when a model, human reference, credentials or deployment resource blocks a feature.
