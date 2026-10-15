"""Real CPU/CUDA ASR comparison using production decoding and existing weights.

No GPU fallback, downloads, prompt, transcript edits or approvals. GPU memory is
whole-device sampled usage (WDDM), NOT per-process or Torch allocator usage.
"""
import argparse
import gc
import hashlib
import importlib.metadata
import json
import platform
import re
import statistics
import subprocess
import sys
import threading
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from asr_models import decoding_options, settings_report


def tokens(text):
    return re.findall(r'\w+', ''.join(c for c in unicodedata.normalize('NFKC', text.lower())
                                    if not unicodedata.combining(c)))


def wer(reference, actual):
    a, b = tokens(reference), tokens(actual)
    if not a:
        raise ValueError('A nonempty independent reference is required for WER.')
    row = list(range(len(b) + 1))
    for i, word in enumerate(a, 1):
        current = [i]
        for j, other in enumerate(b, 1):
            current.append(min(current[j - 1] + 1, row[j] + 1, row[j - 1] + (word != other)))
        row = current
    return {'errors': row[-1], 'referenceWords': len(a), 'rate': row[-1] / len(a)}


class GpuSamples:
    def __init__(self):
        self.samples = []
        self.stop = threading.Event()
        self.thread = None

    def __enter__(self):
        def poll():
            while not self.stop.is_set():
                try:
                    result = subprocess.run(['nvidia-smi', '--id=0', '--query-gpu=memory.used,utilization.gpu',
                                             '--format=csv,noheader,nounits'], capture_output=True, text=True,
                                            timeout=5, check=True,
                                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    memory, utilization = map(float, result.stdout.strip().split(','))
                    self.samples.append({'elapsedSeconds': time.perf_counter() - self.started,
                                         'deviceUsedMiB': memory, 'deviceUtilizationPercent': utilization})
                except (OSError, ValueError, subprocess.SubprocessError):
                    pass
                self.stop.wait(.2)
        self.started = time.perf_counter()
        self.thread = threading.Thread(target=poll, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join(timeout=6)

    def report(self):
        return {'scope': 'whole device including desktop and other processes; sampled, not allocation peak',
                'samples': self.samples,
                'peakDeviceUsedMiB': max((s['deviceUsedMiB'] for s in self.samples), default=None)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('media', nargs='+', type=Path)
    parser.add_argument('--device', required=True, choices=['cpu', 'cuda'])
    parser.add_argument('--compute-type', choices=['int8', 'float16', 'int8_float16'])
    parser.add_argument('--models', nargs='+', default=['medium', 'large-v3'])
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--language', default='', help='Empty = automatic. Explicit language is a separate, labelled diagnostic.')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error('--repeats must be 1–10')
    compute = args.compute_type or ('int8' if args.device == 'cpu' else 'float16')
    root = Path(__file__).resolve().parent.parent
    if args.device == 'cuda':
        from gpu_runtime import configure_cuda_dlls
        configure_cuda_dlls()
    import ctranslate2
    from faster_whisper import WhisperModel
    if args.device == 'cuda' and ctranslate2.get_cuda_device_count() < 1:
        raise RuntimeError('CUDA is required. CPU fallback is forbidden for this benchmark.')
    report = {'createdAt': datetime.now(timezone.utc).isoformat(), 'python': sys.version,
              'platform': platform.platform(), 'executable': sys.executable,
              'versions': {p: importlib.metadata.version(p) for p in ['faster-whisper', 'ctranslate2', 'av']},
              'device': args.device, 'computeType': compute, 'languageHint': args.language or None, 'results': [],
              'method': 'First observed inference plus repeats-1 repeats per model/media; model loaded once per model. Same production decoder. '
                        'WER uses only adjacent independent .txt references; no reference means null. '
                        'NFKC/lowercase/combining-mark removal/word tokens; no semantic or Arabic letter substitutions.'}
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    save()
    for name in args.models:
        if name not in ('medium', 'large-v2', 'large-v3'):
            parser.error('Use an installed allowlisted model.')
        model_path = root / 'local-ai' / 'models' / ('faster-whisper-' + name)
        with (model_path / 'model.bin').open('rb') as stream:
            model_sha256 = hashlib.file_digest(stream, 'sha256').hexdigest()
        with GpuSamples() as samples:
            started = time.perf_counter()
            model = WhisperModel(str(model_path), device=args.device, compute_type=compute,
                                 cpu_threads=4, local_files_only=True)
            load_seconds = time.perf_counter() - started
            for media in args.media:
                reference_path = media.with_suffix('.txt')
                reference = reference_path.read_text(encoding='utf-8').strip() if reference_path.is_file() else None
                result = {'model': name, 'media': str(media.resolve()),
                          'mediaSha256': hashlib.sha256(media.read_bytes()).hexdigest(),
                          'modelSha256': model_sha256,
                          'loadSeconds': load_seconds, 'reference': reference,
                          'settings': settings_report(args.language, args.device, compute), 'runs': []}
                report['results'].append(result)
                for run in range(args.repeats):
                    started = time.perf_counter()
                    segments, info = model.transcribe(str(media), **decoding_options(args.language))
                    raw = [{'start': float(s.start), 'end': float(s.end), 'text': s.text,
                            'avgLogProbability': float(s.avg_logprob),
                            'words': [{'start': float(w.start), 'end': float(w.end), 'word': w.word,
                                       'probability': float(w.probability)} for w in s.words or []]} for s in segments]
                    elapsed = time.perf_counter() - started
                    actual = ' '.join(s['text'].strip() for s in raw)
                    item = {'run': run + 1, 'seconds': elapsed, 'durationSeconds': float(info.duration),
                            'realTimeFactor': elapsed / info.duration, 'language': info.language,
                            'wer': wer(reference, actual) if reference else None, 'text': actual, 'segments': raw}
                    result['runs'].append(item)
                    save()
                    print(json.dumps({k: item[k] for k in ('run', 'seconds', 'wer', 'language')} |
                                     {'device': args.device, 'model': name, 'media': media.name}), flush=True)
                result['medianSeconds'] = statistics.median(r['seconds'] for r in result['runs'])
                result['warmMedianSeconds'] = statistics.median(r['seconds'] for r in result['runs'][1:]) if args.repeats > 1 else None
            del model
            gc.collect()
        report.setdefault('gpuSamplingByModel', {})[name] = samples.report()
        save()


if __name__ == '__main__':
    main()
