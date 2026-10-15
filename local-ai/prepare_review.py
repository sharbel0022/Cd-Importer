"""Create a private offline listening packet. Never modifies or approves a job."""
import argparse
import hashlib
import html
import json
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('job', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--ffmpeg', type=Path, default=Path('node_modules/ffmpeg-static/ffmpeg.exe'))
    args = parser.parse_args()
    raw_job = args.job.read_bytes()
    job = json.loads(raw_job)
    source = args.job.parent / 'normalized.wav'
    original = args.job.parent / ('original.' + job['extension'])
    args.output.mkdir(parents=True, exist_ok=True)
    rows, pending = [], []
    for s in job['segments']:
        if not s.get('uncertain'):
            continue
        identity = s['id']
        if not identity.isalnum():
            raise ValueError('Invalid segment identifier')
        start, end = max(0, s['start'] - .35), s['end'] + .35
        clip = identity + '.wav'
        subprocess.run([str(args.ffmpeg.resolve()), '-v', 'error', '-y', '-ss', str(start), '-i', str(source.resolve()),
                        '-t', str(end - start), '-c:a', 'pcm_s16le', str((args.output / clip).resolve())], check=True)
        pending.append({'id': identity, 'start': s['start'], 'end': s['end'], 'clipStart': start,
                        'clip': clip, 'approved': False, 'humanTranscript': None,
                        'unintelligible': None, 'reviewer': None, 'notes': None})
        proposals = [s['text']] + [a['text'] for a in s.get('asrAlternatives', [])]
        escaped = '<br>'.join(html.escape(x) for x in dict.fromkeys(proposals))
        rows.append(f'<article><h2>{identity}: {s["start"]:.2f}–{s["end"]:.2f} s</h2>'
                    f'<audio controls preload="none" src="{clip}"></audio><br>'
                    '<label>Mänsklig avskrift (lämna tom om otydligt)<br><textarea dir="auto" rows="3"></textarea></label>'
                    f'<details><summary>Visa osäkra modellförslag efter lyssning</summary><p dir="auto">{escaped}</p></details></article>')
    with original.open('rb') as stream:
        source_sha256 = hashlib.file_digest(stream, 'sha256').hexdigest()
    manifest = {'jobId': job['id'], 'jobSha256': hashlib.sha256(raw_job).hexdigest(),
                'sourceSha256': source_sha256,
                'status': 'awaiting_human_review', 'segments': pending}
    (args.output / 'review.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    page = '<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width">' \
           '<title>WhatsApp – mänsklig transkriptgranskning</title><style>body{font:18px system-ui;max-width:850px;margin:30px auto;padding:20px;background:#fafafa}article{padding:16px;border:1px solid #ccc;margin:20px 0}textarea{width:95%;font:22px system-ui}audio{width:100%}details{margin-top:15px}</style>' \
           f'<h1>{len(pending)} osäkra segment – ingen avskrift är godkänd här</h1>' \
           '<p>Lyssna först. Klippen innehåller upp till 0,35 s sammanhang på båda sidor. ' \
           'Skriv endast vad som hörs. Märk otydliga ord som otydliga; fyll aldrig luckor från sammanhang eller modellförslag. ' \
           'Anteckningar på denna sida sparas inte automatiskt. Spara rättningar och godkänn uttryckligen i studion.</p>' + ''.join(rows) + '</html>'
    (args.output / 'index.html').write_text(page, encoding='utf-8')
    if args.job.read_bytes() != raw_job:
        raise RuntimeError('Job changed during review preparation')
    print(json.dumps({'output': str(args.output.resolve()), 'pending': len(pending), 'sourceSha256': manifest['sourceSha256']}))


if __name__ == '__main__':
    main()
