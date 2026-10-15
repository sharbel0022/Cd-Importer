"""Real, unprompted ASR comparison; no translation/TTS quality claims."""
import argparse
import gc
import hashlib
import json
import re
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from faster_whisper import WhisperModel

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("media", nargs="+", type=Path)
parser.add_argument("--models", nargs="+", default=["medium", "large-v3"])
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
directory = root / "test-results" / ("asr-comparison-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
directory.mkdir(parents=True, exist_ok=True)


def tokens(text):
    return re.findall(r"\w+", "".join(c for c in unicodedata.normalize("NFKC", text.lower()) if not unicodedata.combining(c)))


def wer(reference, actual):
    a, b = tokens(reference), tokens(actual)
    row = list(range(len(b) + 1))
    for i, word in enumerate(a, 1):
        current = [i]
        for j, other in enumerate(b, 1):
            current.append(min(current[j - 1] + 1, row[j] + 1, row[j - 1] + (word != other)))
        row = current
    return row[-1] / max(1, len(a))


results = []
for model_name in args.models:
    model_path = root / "local-ai" / "models" / ("faster-whisper-" + model_name)
    started = time.monotonic()
    model = WhisperModel(str(model_path), device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
    load_seconds = time.monotonic() - started
    for media in args.media:
        started = time.monotonic()
        segments, info = model.transcribe(str(media), language=None, beam_size=5,
            temperature=(0, .2, .4, .6, .8, 1), condition_on_previous_text=True,
            vad_filter=True, word_timestamps=True, language_detection_segments=3,
            vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 400})
        raw = [{"start": s.start, "end": s.end, "text": s.text, "avg_logprob": s.avg_logprob,
                "no_speech_prob": s.no_speech_prob, "temperature": s.temperature,
                "compression_ratio": s.compression_ratio,
                "words": [{"start": w.start, "end": w.end, "word": w.word, "probability": w.probability} for w in s.words or []]}
               for s in segments]
        text = " ".join(s["text"].strip() for s in raw)
        reference_path = media.with_suffix(".txt")
        reference = reference_path.read_text(encoding="utf-8") if reference_path.is_file() else None
        result = {"model": model_name, "media": str(media.resolve()), "sha256": hashlib.sha256(media.read_bytes()).hexdigest(),
                  "language": info.language, "language_probability": info.language_probability,
                  "duration": info.duration, "loadSeconds": load_seconds, "inferenceSeconds": time.monotonic() - started,
                  "reference": reference, "wordErrorRate": wer(reference, text) if reference else None,
                  "text": text, "segments": raw, "prompt": None}
        results.append(result)
        (directory / "report.json").write_text(json.dumps({"scope": "Raw unprompted acoustic ASR comparison, CPU int8. No reference for WhatsApp: accuracy cannot be scored.", "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({k: result[k] for k in ("model", "media", "language", "wordErrorRate", "inferenceSeconds")}), flush=True)
    del model
    gc.collect()
print(str(directory), flush=True)
