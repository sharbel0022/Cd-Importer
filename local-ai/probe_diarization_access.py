"""Read-only gated-weight access probe. Never accepts terms or writes tokens."""
import json
from datetime import datetime, timezone
from pathlib import Path

from huggingface_hub import hf_hub_download, HfApi, get_token
from huggingface_hub.errors import HfHubHTTPError


def main():
    root = Path(__file__).resolve().parent.parent
    repository = 'pyannote/speaker-diarization-community-1'
    token = get_token()
    report = {'createdAt': datetime.now(timezone.utc).isoformat(), 'repository': repository,
              'tokenPresent': bool(token), 'status': 'unverified', 'realTwoSpeakerTest': False,
              'diarizationErrorRate': None}
    try:
        info = HfApi().model_info(repository, token=token or False)
        report.update(revision=info.sha, gated=info.gated,
                      license=info.card_data.get('license') if info.card_data else None)
        config = hf_hub_download(repository, 'config.yaml', token=token or False,
                                 cache_dir=str(root / 'local-ai/models/diarization-cache'))
        report.update(status='config_accessible_weights_and_inference_still_unverified', config=str(config))
    except HfHubHTTPError as error:
        report.update(status='blocked_model_access', httpStatus=error.response.status_code if error.response is not None else None,
                      reason='Authorized account access to gated model files is required. No conditions were accepted.')
    destination = root / 'test-results/diarization-access.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
