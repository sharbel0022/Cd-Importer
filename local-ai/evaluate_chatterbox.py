"""Real stock-voice multilingual synthesis; no cloning or human ratings invented."""
import argparse
import hashlib
import importlib.metadata
import json
import os
import time
from pathlib import Path

from gpu_runtime import configure_cuda_dlls


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--languages', nargs='+', choices=['en', 'sv', 'ar'], default=['en', 'sv', 'ar'])
    parser.add_argument('--cfg-weight', type=float, choices=[0, .3, .5], default=.5)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    os.environ.setdefault('HF_HOME', str(root / 'local-ai/models/chatterbox-cache'))
    os.environ.setdefault('PKUSEG_HOME', str(root / 'local-ai/models/chatterbox-pkuseg'))
    os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
    configure_cuda_dlls()
    import torch
    import soundfile as sf
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    from benchmark_gpu import GpuSamples
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA required; no CPU fallback allowed')
    prompts = {
        'en': 'A subtropical storm named Jerry formed in the Atlantic Ocean today. This is the tenth named storm of the Atlantic hurricane season.',
        'sv': 'När du ringer någon som befinner sig tusentals kilometer bort använder du en satellit.',
        'ar': 'تشكلت في المحيط الأطلسي اليوم عاشر عاصفة مسماة لموسم الأعاصير الأطلسية، العاصفة شبه الاستوائية جيري.',
    }
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'model': 'Chatterbox Multilingual V3', 'voice': 'checkpoint built-in conditioning',
              'cloning': False, 'device': torch.cuda.get_device_name(), 'cuda': torch.version.cuda,
              'versions': {p: importlib.metadata.version(p) for p in ['torch', 'torchaudio', 'chatterbox-tts', 'transformers', 'resemble-perth']},
              'humanListening': {'status': 'pending', 'listeners': 0, 'mos': None, 'speakerSimilarity': None},
              'settings': {'seed': 42, 'exaggeration': .5, 'cfgWeight': args.cfg_weight, 'temperature': .8}, 'results': []}

    def save():
        (args.output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    save()
    with GpuSamples() as memory:
        torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        model = ChatterboxMultilingualTTS.from_local(str(root / 'local-ai/models/chatterbox'), device='cuda', t3_model='v3')
        torch.cuda.synchronize()
        report['loadSeconds'] = time.perf_counter() - started
        for language in args.languages:
            torch.manual_seed(42)
            torch.cuda.manual_seed_all(42)
            started = time.perf_counter()
            wav = model.generate(prompts[language], language_id=language, exaggeration=.5, cfg_weight=args.cfg_weight, temperature=.8)
            torch.cuda.synchronize()
            elapsed = time.perf_counter() - started
            file = args.output / (language + '.wav')
            samples = wav.squeeze().cpu().numpy()
            sf.write(str(file), samples, model.sr, subtype='PCM_16')
            (args.output / (language + '.txt')).write_text(prompts[language], encoding='utf-8')
            item = {'language': language, 'text': prompts[language], 'seconds': elapsed,
                    'audioSeconds': len(samples) / model.sr, 'sampleRate': model.sr,
                    'peakAbsolute': float(abs(samples).max()),
                    'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
            item['realTimeFactor'] = elapsed / item['audioSeconds']
            report['results'].append(item)
            save()
            print(json.dumps({key: item[key] for key in ('language', 'seconds', 'audioSeconds', 'realTimeFactor')}), flush=True)
        report['torchPeakAllocatedMiB'] = torch.cuda.max_memory_allocated() / 1024 ** 2
        report['torchPeakReservedMiB'] = torch.cuda.max_memory_reserved() / 1024 ** 2
    report['gpuMemory'] = memory.report()
    save()


if __name__ == '__main__':
    main()
