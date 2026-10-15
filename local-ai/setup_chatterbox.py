"""Download explicitly selected public MIT Chatterbox weights with provenance."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--revision', default='5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    repository = 'ResembleAI/chatterbox'
    info = HfApi().model_info(repository, revision=args.revision, token=False)
    license_id = info.card_data.get('license') if info.card_data else None
    if info.gated or license_id != 'mit':
        raise RuntimeError('Expected public MIT checkpoint; review changed model terms before installing.')
    directory = root / 'local-ai/models/chatterbox'
    snapshot_download(repository, revision=info.sha, token=False, local_dir=str(directory),
                      allow_patterns=['README.md', 'LICENSE*', 've.pt', 's3gen.pt', 'conds.pt',
                                      't3_mtl23ls_v3.safetensors', 'grapheme_mtl_merged_expanded_v1.json',
                                      'Cangjie5_TC.json'])
    files = {}
    for file in directory.iterdir():
        if file.is_file() and file.name != 'provenance.json':
            with file.open('rb') as stream:
                files[file.name] = {'bytes': file.stat().st_size,
                                    'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}
    report = {'repository': repository, 'revision': info.sha, 'license': license_id,
              'downloadedAt': datetime.now(timezone.utc).isoformat(), 'files': files,
              'scope': 'Model-card license and exact checkpoint provenance. Dependency licenses are separate.'}
    (directory / 'provenance.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'directory': str(directory), 'revision': info.sha, 'files': len(files)}))


if __name__ == '__main__':
    main()
