"""Actual Demucs separation: controlled reference mix plus unscored real media.

The controlled bed is generated music and transient effects mixed with real
FLEURS human speech. It is a diagnostic, not a natural soundtrack benchmark.
Unscored media has no isolated stems: preservation cannot be asserted there.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
import time
from pathlib import Path

from gpu_runtime import configure_cuda_dlls


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--media', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    os.environ.setdefault('TORCH_HOME', str(root / 'local-ai/models/torch-hub'))
    configure_cuda_dlls()
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio.functional as af
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    from benchmark_gpu import GpuSamples
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA required')
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'model': 'htdemucs', 'device': torch.cuda.get_device_name(),
              'versions': {p: importlib.metadata.version(p) for p in ['demucs', 'torch', 'torchaudio']},
              'humanListening': {'status': 'pending', 'listeners': 0}, 'results': [],
              'settings': {'shifts': 0, 'overlap': .25, 'split': True},
              'scope': __doc__}
    with GpuSamples() as memory:
        torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        model = get_model('htdemucs').to('cuda').eval()
        report['loadSeconds'] = time.perf_counter() - started
        rate = model.samplerate

        def load(file):
            data, source_rate = sf.read(str(file), dtype='float32', always_2d=True)
            audio = torch.from_numpy(data.T.copy())
            if audio.shape[0] == 1:
                audio = audio.repeat(2, 1)
            if source_rate != rate:
                audio = af.resample(audio, source_rate, rate)
            return audio[:2]

        def write(name, tensor):
            sf.write(str(args.output / (name + '.wav')), tensor.cpu().numpy().T, rate, subtype='FLOAT')

        speech_clip = load(root / 'local-ai/fixtures/fleurs-en_us-validation-0.wav')
        length = int(18 * rate)
        speech = torch.zeros(2, length)
        for offset in (0, 9 * rate):
            count = min(speech_clip.shape[-1], length - offset)
            speech[:, offset:offset + count] = speech_clip[:, :count]
        speech *= .15 / max(float(speech.abs().max()), 1e-8)
        t = np.arange(length) / rate
        music = np.zeros((2, length), dtype=np.float32)
        for i, frequency in enumerate([130.81, 164.81, 196, 261.63]):
            envelope = .4 + .6 * np.sin(2 * np.pi * .5 * t + i) ** 2
            for channel in range(2):
                music[channel] += (.013 * envelope * np.sin(2 * np.pi * frequency * t + channel * .2)).astype(np.float32)
        effects = np.zeros((2, length), dtype=np.float32)
        rng = np.random.default_rng(42)
        for at in (2, 6, 10, 14, 17):
            count = int(.25 * rate)
            transient = rng.standard_normal(count) * np.exp(-np.arange(count) / (rate * .07)) * .055
            effects[:, int(at * rate):int(at * rate) + count] += transient.astype(np.float32)
        music, effects = torch.from_numpy(music), torch.from_numpy(effects)
        bed = music + effects
        controlled = speech + bed
        for name, audio in [('controlled-input', controlled), ('reference-speech', speech),
                            ('reference-music', music), ('reference-effects', effects), ('reference-bed', bed)]:
            write(name, audio)

        def separate(audio, identity):
            ref = audio.mean(0)
            mean, std = ref.mean(), ref.std()
            started = time.perf_counter()
            with torch.inference_mode():
                sources = apply_model(model, ((audio - mean) / std)[None], device='cuda', shifts=0,
                                      split=True, overlap=.25, progress=False)[0].cpu() * std + mean
            torch.cuda.synchronize()
            elapsed = time.perf_counter() - started
            voice_index = model.sources.index('vocals')
            vocals = sources[voice_index]
            background = sources[[i for i in range(len(sources)) if i != voice_index]].sum(0)
            write(identity + '-vocals', vocals)
            write(identity + '-background', background)
            item = {'id': identity, 'seconds': elapsed, 'durationSeconds': audio.shape[-1] / rate,
                    'realTimeFactor': elapsed / (audio.shape[-1] / rate),
                    'sampleRate': rate, 'outputSamples': background.shape[-1],
                    'inputSamples': audio.shape[-1], 'durationErrorMs': (background.shape[-1] - audio.shape[-1]) / rate * 1000,
                    'backgroundPeak': float(background.abs().max()),
                    'reconstructionRms': float(((background + vocals - audio) ** 2).mean().sqrt())}
            report['results'].append(item)
            return background, item

        output, item = separate(controlled, 'controlled')
        # Joint least squares keeps correlated/overlapping reference components
        # separate. Gains are measured, not interpreted as human quality scores.
        design = np.stack([music.numpy().ravel(), effects.numpy().ravel(), speech.numpy().ravel()], axis=1)
        gains, *_ = np.linalg.lstsq(design, output.numpy().ravel(), rcond=None)
        item['componentGainDb'] = {key: float(20 * math.log10(max(abs(value), 1e-12)))
                                  for key, value in zip(['music', 'effects', 'speechLeakage'], gains)}
        item['bedErrorRms'] = float(((output - bed) ** 2).mean().sqrt())
        item['thresholds'] = {'musicGainAbsoluteDbMax': 3, 'effectsGainAbsoluteDbMax': 3, 'speechLeakageDbMax': -20}
        g = item['componentGainDb']
        item['passesDiagnosticThresholds'] = abs(g['music']) <= 3 and abs(g['effects']) <= 3 and g['speechLeakage'] <= -20
        if args.media:
            _, item = separate(load(args.media), 'real-media')
            item.update(mediaSha256=hashlib.sha256(args.media.read_bytes()).hexdigest(),
                        preservationScore=None, reason='No isolated reference stems or human listening result')
        report['torchPeakAllocatedMiB'] = torch.cuda.max_memory_allocated() / 1024 ** 2
        report['torchPeakReservedMiB'] = torch.cuda.max_memory_reserved() / 1024 ** 2
    report['gpuMemory'] = memory.report()
    (args.output / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report['results'], indent=2))


if __name__ == '__main__':
    main()
