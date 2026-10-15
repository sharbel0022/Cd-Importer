"""Download two disclosed human-recorded FLEURS validation clips and provenance."""
import hashlib
import json
from pathlib import Path
import httpx

destination = Path(__file__).resolve().parent.parent / 'local-ai' / 'fixtures'
destination.mkdir(parents=True, exist_ok=True)
with httpx.Client(timeout=120, follow_redirects=True) as client:
    for config in ('sv_se', 'en_us'):
        # The test split's large Parquet row groups can exceed the viewer's
        # scan quota. The smaller validation split needs no full dataset download.
        response = client.get('https://datasets-server.huggingface.co/first-rows', params={
            'dataset': 'google/fleurs', 'config': config, 'split': 'validation'})
        response.raise_for_status()
        row = response.json()['rows'][0]['row']
        audio = row['audio'][0]
        source = audio['src']
        # This is test source data, never an application upload URL capability.
        if not source.startswith('https://datasets-server.huggingface.co/'):
            raise ValueError('Unexpected fixture host')
        data = client.get(source)
        data.raise_for_status()
        extension = '.mp3' if 'mpeg' in audio.get('type', '') else '.wav'
        file = destination / ('fleurs-' + config + '-validation-0' + extension)
        file.write_bytes(data.content)
        reference = row.get('raw_transcription') or row['transcription']
        file.with_suffix('.txt').write_text(reference, encoding='utf-8')
        provenance = {'dataset': 'google/fleurs', 'source': 'https://huggingface.co/datasets/google/fleurs',
                      'config': config, 'split': 'validation', 'row': 0, 'id': row['id'], 'reference': reference,
                      'license': 'CC-BY-4.0', 'sha256': hashlib.sha256(data.content).hexdigest()}
        file.with_suffix('.provenance.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'file': str(file), 'reference': reference, 'bytes': len(data.content)}, ensure_ascii=False), flush=True)
