"""Installed acoustic models and one shared production decoding configuration.

Client requests choose an opaque allowlisted id. They cannot select a path,
repository or model download. Health probes inspect local files only.
"""
import json
import os
import re
from pathlib import Path

REQUIRED_FILES = ('model.bin', 'config.json', 'tokenizer.json')
KNOWN_MODELS = ('medium', 'large-v2', 'large-v3', 'large-v3-turbo')


def installed_path(value):
    if not isinstance(value, str) or not value:
        return None
    candidate = Path(value)
    if candidate.is_dir():
        return candidate.resolve() if all(candidate.joinpath(name).is_file() and candidate.joinpath(name).stat().st_size > 0 for name in REQUIRED_FILES) else None
    if ':' in value or value.startswith(('.', '/', '\\')):
        return None
    try:
        from huggingface_hub import try_to_load_from_cache
        from faster_whisper.utils import _MODELS
        repository = _MODELS.get(value, value)
        if '/' not in repository:
            return None
        cached = [try_to_load_from_cache(repository, name) for name in REQUIRED_FILES]
        if all(isinstance(file, str) and Path(file).is_file() and Path(file).stat().st_size > 0 for file in cached):
            parent = Path(cached[0]).parent
            return parent if all(Path(file).parent == parent for file in cached) else None
    except (ImportError, OSError, ValueError):
        pass
    return None


def installed_models():
    configured = os.getenv('WHISPER_MODEL', 'small')
    candidates = [{'id': 'configured', 'label': Path(configured).name, 'model': configured, 'selected': True}]
    root = Path(__file__).resolve().parent / 'models'
    candidates.extend({'id': name, 'label': 'Whisper ' + name, 'model': str(root / ('faster-whisper-' + name)), 'selected': False} for name in KNOWN_MODELS)
    try:
        extras = json.loads(os.getenv('STUDIO_ASR_MODELS_JSON', '[]'))
        if isinstance(extras, list):
            candidates.extend({**item, 'selected': False} for item in extras[:8] if isinstance(item, dict))
    except (TypeError, ValueError):
        pass
    result, identifiers, paths = [], set(), set()
    for item in candidates:
        identity, label = item.get('id'), item.get('label')
        if not isinstance(identity, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', identity) or identity in identifiers:
            continue
        if not isinstance(label, str) or not label.strip() or len(label) > 120:
            continue
        model = installed_path(item.get('model'))
        if model is None or str(model) in paths:
            continue
        result.append({'id': identity, 'label': label, 'model': str(model), 'selected': bool(item['selected'])})
        identifiers.add(identity)
        paths.add(str(model))
    return result


def decoding_options(language):
    return {'language': language or None, 'beam_size': 5, 'temperature': (0, .2, .4, .6, .8, 1.0),
            'condition_on_previous_text': False, 'vad_filter': True, 'word_timestamps': True,
            'multilingual': not bool(language), 'language_detection_segments': 3,
            'vad_parameters': {'min_silence_duration_ms': 500, 'speech_pad_ms': 400}}


def settings_report(language, device, compute_type):
    options = decoding_options(language)
    return {key: list(value) if isinstance(value, tuple) else value for key, value in options.items() if key not in ('language', 'vad_parameters')} | {
        'language': language or 'auto', 'device': device, 'compute_type': compute_type, 'cpu_threads': 4,
        'vad_min_silence_duration_ms': 500, 'vad_speech_pad_ms': 400, 'prompt': 'none'}
