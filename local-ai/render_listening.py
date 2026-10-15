"""Render and decode a stock-voice dubbing diagnostic of approved public speech.

This never reads the WhatsApp job or approves a transcript. No speed-up, speech
truncation or fabricated lip-sync score. Overlong speech fails the timing gate.
"""
import argparse
import hashlib
import html
import json
import shutil
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--voice-dir', type=Path, required=True)
    parser.add_argument('--source-video', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    import numpy as np
    root = Path(__file__).resolve().parent.parent
    ffmpeg = str(root / 'node_modules/ffmpeg-static/ffmpeg.exe')
    rate = 48000

    def run(arguments):
        return subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', *arguments],
                              capture_output=True, check=True).stdout

    def decode(file):
        return np.frombuffer(run(['-i', str(file), '-vn', '-ar', str(rate), '-ac', '1', '-f', 'f32le', '-']), dtype='<f4')

    args.output.mkdir(parents=True, exist_ok=True)
    source = root / 'local-ai/fixtures/fleurs-ar-eg-test-0.wav'
    source_pcm = decode(source)
    speech = decode(args.voice_dir / 'en.wav')
    duration = len(source_pcm) / rate
    if len(speech) > len(source_pcm):
        raise RuntimeError('Speech exceeds source window. Leave timing unapproved; never truncate or silently accelerate it.')
    for language in ['en', 'sv', 'ar']:
        shutil.copyfile(args.voice_dir / (language + '.wav'), args.output / (language + '-stock.wav'))
        shutil.copyfile(args.voice_dir / (language + '.txt'), args.output / (language + '-stock.txt'))
    shutil.copyfile(source, args.output / 'source-arabic.wav')
    shutil.copyfile(source.with_suffix('.provenance.json'), args.output / 'source-provenance.json')
    target = args.output / 'en-dub.wav'
    run(['-y', '-i', str(args.voice_dir / 'en.wav'), '-af', f'apad,atrim=end={duration}', '-ar', str(rate), '-ac', '1', str(target)])
    run(['-y', '-i', str(target), '-c:a', 'libmp3lame', '-b:a', '192k', str(args.output / 'en-dub.mp3')])
    run(['-y', '-i', str(args.source_video), '-i', str(target), '-map', '0:v:0', '-map', '1:a:0',
         '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', str(duration), '-movflags', '+faststart', str(args.output / 'en-dub.mp4')])
    expected = (args.voice_dir / 'en.txt').read_text(encoding='utf-8')
    (args.output / 'en-dub.txt').write_text(expected, encoding='utf-8')
    outputs = []
    for extension in ['wav', 'mp3', 'mp4']:
        file = args.output / ('en-dub.' + extension)
        pcm = decode(file)
        block = int(rate * .01)
        frames = pcm[:len(pcm) // block * block].reshape(-1, block)
        audible = np.flatnonzero(np.sqrt(np.mean(frames ** 2, axis=1)) > 10 ** (-45 / 20))
        outputs.append({'format': extension, 'decodedSamples': len(pcm), 'decodedSeconds': len(pcm) / rate,
                        'durationErrorMs': (len(pcm) - len(source_pcm)) / rate * 1000,
                        'energyOnsetSeconds': float(audible[0] * .01) if len(audible) else None,
                        'energyEndSeconds': float((audible[-1] + 1) * .01) if len(audible) else None,
                        'peakAbsolute': float(abs(pcm).max()), 'bytes': file.stat().st_size,
                        'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
    report = {'source': 'Google FLEURS ar_eg test row 0, human speech; approved published reference',
              'video': 'Existing solid-colour FLEURS diagnostic, no visible face',
              'sourceSeconds': duration, 'speechSeconds': len(speech) / rate,
              'paddingSeconds': (len(source_pcm) - len(speech)) / rate,
              'speechRateMultiplier': 1, 'cloning': False, 'outputs': outputs,
              'timingGate': all(abs(o['durationErrorMs']) <= 25 for o in outputs),
              'humanListening': {'status': 'pending', 'listeners': 0, 'naturalnessRating': None},
              'limits': 'Energy threshold is not phoneme alignment. Container sync is not lip sync or human voice quality.'}
    (args.output / 'render-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    page = '<!doctype html><html lang="sv"><meta charset="utf-8"><title>AI-lyssning</title>' \
           '<style>body{font:18px system-ui;max-width:800px;margin:30px auto;padding:20px}audio,video{width:100%;margin:10px 0}p{line-height:1.5}</style>' \
           '<h1>Chatterbox standardröst – mänskligt lyssningstest</h1>' \
           '<p>Detta är ett offentligt FLEURS-prov, inte WhatsApp-videon. Ingen persons röst har klonats. ' \
           'Betygsätt naturlighet och begriplighet 1–5 och ange hörbara fel med tidpunkt. Inga betyg har fyllts i automatiskt.</p>' \
           '<h2>Original: mänskligt arabiskt tal</h2><audio controls src="source-arabic.wav"></audio>' \
           '<h2>Engelsk dubbning MP3</h2><audio controls src="en-dub.mp3"></audio>' \
           '<h2>Engelsk dubbning MP4</h2><video controls src="en-dub.mp4"></video>' \
           '<p>' + html.escape(expected) + '</p>' \
           '<h2>Svenskt standardröstprov</h2><audio controls src="sv-stock.wav"></audio>' \
           '<h2>Arabiskt standardröstprov</h2><audio controls src="ar-stock.wav"></audio>' \
           '<p>Källa: Google FLEURS, CC-BY-4.0. Ljudsyntesen är en bearbetning. ' \
           '<a href="https://huggingface.co/datasets/google/fleurs">Dataset och attribution</a>.</p></html>'
    (args.output / 'index.html').write_text(page, encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
