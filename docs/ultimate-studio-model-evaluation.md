# Model/runtime evaluation – 2026-10-15

Follow-up: [GPU and real AI quality verification](gpu-ai-quality-verification.md) records the subsequently installed isolated RTX 5070 and Chatterbox environments, actual ASR/TTS/separation measurements, failed language probes and remaining human/model-access gates. The inventory below is the earlier baseline; the original CPU environment remains intact. No cloning, human MOS, two-speaker diarization or approved WhatsApp dubbing is implied by the new installation.

These are implementation candidates and concrete blockers, not quality endorsements or completed feature claims. Primary model documentation was checked on the audit date. No gated conditions were accepted, external service account created, paid API used, or shared Python environment modified.

## Installed and measured

The project environment is Python 3.13.15, faster-whisper 1.2.1, CPU/int8 decoding. A physical RTX 5070 (12,227 MiB reported VRAM) and CTranslate2 CUDA device discovery do **not** prove a working Torch GPU stack: project Torch 2.14.1 is CPU-only. A separate existing Conda Python 3.11.15 environment also has CPU Torch; it was inspected without modification. Gateway inference remains CPU. Whisper medium, large-v2 and large-v3 weights are present; turbo/distil weights are absent and not downloaded by a UI request.

`test-results/ultimate-asr-probe/report.json` records real HTTP inference with identical production beam, temperature fallback, previous-text conditioning, VAD and word-timestamp settings. FLEURS Arabic 8.16 seconds: medium 9.28 s and reference WER 20%; large-v3 17.09 s and WER 13.33%. Both flagged uncertainty. This is one recording, not a dialect benchmark or calibrated confidence. WhatsApp first 2.18 seconds: medium 6.36 s and large-v3 10.11 s; no human reference, therefore no WER or correctness score. Denoised targeted app/API rerun of that segment took 11.86 s and retained review status and all original/effective source evidence.

The comparison script imports the production decoder configuration, correcting the old script's `condition_on_previous_text=True` mismatch. New results never substitute one model's text for source approval. Larger models are not assumed better for every utterance.

## Optional model decisions

| Capability | Evidence and license | Decision / remaining work |
| --- | --- | --- |
| Diarization | [pyannote community-1 model card](https://huggingface.co/pyannote/speaker-diarization-community-1): CC-BY-4.0; gated user conditions/contact sharing and token required; exclusive and overlapping turn outputs differ. | BLOCKED: package and authorized weights absent. User must accept gated conditions in their account; no fabricated identities or real two-speaker success claim. Update adapter for selected pipeline output version and test actual labeled recordings before readiness. |
| English/Swedish/Arabic cloning | [Chatterbox upstream](https://github.com/resemble-ai/chatterbox): MIT code, documented multilingual Arabic/English/Swedish and reference audio support. | Candidate only. No package/checkpoints or consented voice-reference evaluation. Needs isolated compatible runtime, exact checkpoint/dependency license review, real generation/listening/similarity/latency tests and deletion/revocation lifecycle. Not installed or exposed as available. |
| Existing XTTS | [XTTS-v2 card](https://huggingface.co/coqui/XTTS-v2): CPML and listed languages. Swedish is absent. | Existing adapter remains limited; no Swedish claim. Package/weights absent. Blocked in commercial policy; a configured adapter is not a verified cloning result. |
| Lip sync | [MuseTalk upstream](https://github.com/TMElyralab/MuseTalk): MIT code and commercial model statement; third-party dependencies retain their own terms. Authors disclose identity/detail/jitter limitations and report throughput on different hardware. | Candidate only. GPU-compatible environment, complete license chain, weights, consented visible-face source, face/speaker association, scene-cut handling and visual evaluation absent. No enabled button or generated pretend lip-sync output. |
| Alternative lip sync | [Wav2Lip upstream](https://github.com/Rudrabha/Wav2Lip) prohibits commercial use of the open-source model. | Excluded from the commercial pipeline. Do not install it as a commercially cleared fallback. |
| Separation | Existing Demucs adapter produces vocals/background, not independent noise/music/environment truth. | Package/weights absent. Mixer works with actual audio; real learned source separation remains unverified. Do not call attenuated original audio isolated background. |
| Swedish MMS | [MMS Swedish card](https://huggingface.co/facebook/mms-tts-swe): CC-BY-NC-4.0. | Evaluation fallback only; blocked for commercial mode. |
| Piper voices | Installed individual model cards differ: Ryan NC, Alba CC-BY-4.0, NST CC0; Lessac/data terms, Alan/Kareem linked terms and Lisa require specific review. | Keep working local fallback, label actual locale/gender metadata, do not equate generated audio with premium quality or commercial clearance. Operator approvals required in commercial mode. |
| Gemma / TranslateGemma | Existing local Gemma 3 12B and TranslateGemma 12B used through Ollama. | Actual local translation tested; model terms/acceptance must be reviewed separately from Ollama software. No MOS, universal accuracy or commercial authorization inferred. |

## Evidence still required

Human-created Arabic dialect references, mixed-language references, genuine multi-speaker turn annotations, consented reference voices, visible-face video rights and independent listening/visual ratings are unavailable. These block corresponding quality completion, not unrelated editing/rendering work. Real-time providers currently expose complete blocks; there is no truthful first-partial transcript latency. Report that metric as unavailable instead of emitting a fake partial event.
