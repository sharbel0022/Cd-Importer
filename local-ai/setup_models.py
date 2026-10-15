"""Download the local ASR and Piper voices to this project, with provenance."""
import hashlib
import argparse
import json
import os
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
from huggingface_hub import HfApi, hf_hub_download, snapshot_download

root = Path(__file__).resolve().parent / "models"
root.mkdir(exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument("--whisper-size", choices=["medium", "large-v2", "large-v3"], default="large-v3")
parser.add_argument('--with-mms', action='store_true', help='Also download Swedish MMS TTS (CC-BY-NC-4.0, noncommercial)')
parser.add_argument('--voices-only', action='store_true', help='Download Piper voices without downloading Whisper again')
args = parser.parse_args()
api = HfApi()
whisper_repo = "Systran/faster-whisper-" + args.whisper_size
whisper_revision = None
if not args.voices_only:
    whisper_revision = api.model_info(whisper_repo).sha
    print("Downloading Whisper", args.whisper_size, whisper_revision, flush=True)
    snapshot_download(whisper_repo, revision=whisper_revision, local_dir=root / ("faster-whisper-" + args.whisper_size),
                      allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.*", "preprocessor_config.json", "README.md"])
piper_repo = "rhasspy/piper-voices"
piper_revision = api.model_info(piper_repo).sha
for folder, name in [("en/en_US/lessac/high", "en_US-lessac-high"), ("en/en_US/ryan/high", "en_US-ryan-high"),
                     ("en/en_GB/alba/medium", "en_GB-alba-medium"), ("en/en_GB/alan/medium", "en_GB-alan-medium"),
                     ("sv/sv_SE/nst/medium", "sv_SE-nst-medium"), ("sv/sv_SE/lisa/medium", "sv_SE-lisa-medium"), ("ar/ar_JO/kareem/medium", "ar_JO-kareem-medium")]:
    for filename in [name + ".onnx", name + ".onnx.json", "MODEL_CARD"]:
        print("Downloading", folder + "/" + filename, flush=True)
        hf_hub_download(piper_repo, filename=folder + "/" + filename, revision=piper_revision, local_dir=root / "piper")
manifest_path = root / 'manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.is_file() else {}
if whisper_revision:
    manifest['whisper'] = {"repository": whisper_repo, "revision": whisper_revision}
manifest.update({"piper": {"repository": piper_repo, "revision": piper_revision}, "files": []})
if args.with_mms:
    mms_repo = 'facebook/mms-tts-swe'
    revision = api.model_info(mms_repo).sha
    snapshot_download(mms_repo, revision=revision, local_dir=root / 'mms-tts-swe', allow_patterns=['*.json', '*.safetensors', 'README.md'])
    manifest['mms'] = {'repository': mms_repo, 'revision': revision, 'license': 'CC-BY-NC-4.0'}
for file in root.rglob("*"):
    if not file.is_file() or ".cache" in file.parts or file.name == "manifest.json":
        continue
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        while data := stream.read(1024 * 1024):
            digest.update(data)
    manifest["files"].append({"path": file.relative_to(root).as_posix(), "bytes": file.stat().st_size, "sha256": digest.hexdigest()})
(root / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print("Models ready:", root, flush=True)
