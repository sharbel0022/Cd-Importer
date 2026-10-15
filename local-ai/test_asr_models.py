import os
import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
import asr_models
import server


class AsrModelsTests(unittest.TestCase):
    def create_model(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        for name in asr_models.REQUIRED_FILES:
            directory.joinpath(name).write_bytes(b'model-fixture')
        return directory

    def test_only_complete_installed_models_are_allowlisted_and_paths_are_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configured = self.create_model(root / 'models' / 'faster-whisper-large-v3')
            self.create_model(root / 'models' / 'faster-whisper-medium')
            (root / 'models' / 'faster-whisper-large-v2').mkdir()
            with patch.object(asr_models, '__file__', str(root / 'asr_models.py')), patch.dict(os.environ, {'WHISPER_MODEL': str(configured), 'STUDIO_ASR_MODELS_JSON': '[]'}):
                result = asr_models.installed_models()
            self.assertEqual([item['id'] for item in result], ['configured', 'medium'])
            self.assertTrue(result[0]['selected'])
            self.assertFalse(result[1]['selected'])

    def test_extra_models_require_a_safe_id_and_complete_server_configured_files(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            primary = self.create_model(root / 'primary')
            extra = self.create_model(root / 'other')
            entries = [{'id': '../unsafe', 'label': 'Bad', 'model': str(extra)}, {'id': 'configured', 'label': 'Collision', 'model': str(extra)}, {'id': 'test-asr', 'label': 'Test acoustic model', 'model': str(extra)}]
            with patch.object(asr_models, '__file__', str(root / 'asr_models.py')), patch.dict(os.environ, {'WHISPER_MODEL': str(primary), 'STUDIO_ASR_MODELS_JSON': json.dumps(entries)}):
                result = asr_models.installed_models()
            self.assertEqual([item['id'] for item in result], ['configured', 'test-asr'])
            self.assertIsNone(asr_models.installed_path('C:/not-installed/model'))

    def test_shared_production_settings_preserve_acoustic_decoding(self):
        options = asr_models.decoding_options('')
        self.assertIsNone(options['language'])
        self.assertTrue(options['multilingual'])
        self.assertFalse(options['condition_on_previous_text'])
        self.assertTrue(options['vad_filter'])
        self.assertTrue(options['word_timestamps'])
        self.assertNotIn('initial_prompt', options)
        self.assertEqual(asr_models.settings_report('ar', 'cpu', 'int8')['language'], 'ar')
        self.assertFalse(asr_models.decoding_options('ar')['multilingual'])

    def test_unallowlisted_client_model_cannot_load_or_download(self):
        with patch.object(server, 'installed', return_value=True), patch.object(server, 'installed_models', return_value=[]), patch('faster_whisper.WhisperModel') as load:
            with self.assertRaises(HTTPException) as error:
                server.transcribe_sync(Path('source.wav'), '', model_id='../../untrusted/model')
            self.assertEqual(error.exception.status_code, 422)
            load.assert_not_called()

    def test_selected_model_is_local_only_and_reports_exact_shared_settings(self):
        word = SimpleNamespace(start=0.0, end=1.0, word=' five', probability=.95)
        segment = SimpleNamespace(start=0.0, end=1.0, text='five', avg_logprob=-.1, no_speech_prob=.01, temperature=0, compression_ratio=1.0, words=[word])
        info = SimpleNamespace(language='en', language_probability=.99, duration=1.0, duration_after_vad=1.0)
        model = MagicMock()
        model.transcribe.return_value = (iter([segment]), info)
        available = [{'id': 'medium', 'model': '/installed/medium', 'label': 'Whisper medium', 'selected': False}]
        with patch.object(server, 'installed', return_value=True), patch.object(server, 'installed_models', return_value=available), patch.object(server, 'whisper', None), patch.object(server, 'whisper_key', None), patch.object(server, 'whisper_runtime', None), patch.dict(os.environ, {'WHISPER_DEVICE': 'cpu', 'WHISPER_COMPUTE_TYPE': 'int8'}), patch('faster_whisper.WhisperModel', return_value=model) as load:
            result = server.transcribe_sync(Path('source.wav'), '', context='must not become an acoustic prompt', model_id='medium')
        load.assert_called_once_with('/installed/medium', device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
        model.transcribe.assert_called_once_with('source.wav', **asr_models.decoding_options(''))
        self.assertEqual(result['model'], 'medium')
        self.assertEqual(result['segments'][0]['raw_text'], 'five')
        self.assertEqual(result['settings'], asr_models.settings_report('', 'cpu', 'int8'))

    def test_health_exposes_model_choices_without_server_paths(self):
        response = MagicMock()
        response.json.return_value = {'models': []}
        client = MagicMock()
        client.get = AsyncMock(return_value=response)
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=None)
        models = [{'id': 'configured', 'label': 'Whisper large-v3', 'model': 'C:/private/model-directory', 'selected': True}]
        with patch.object(server, 'installed', return_value=True), patch.object(server, 'installed_models', return_value=models), patch.object(server, 'whisper_weights_available', return_value=True), patch.object(server, 'xtts_available', return_value=False), patch.object(server, 'voices', return_value=[]), patch.object(server.mms_voice, 'available', return_value=False), patch.object(server.httpx, 'AsyncClient', return_value=client):
            result = asyncio.run(server.health())
        self.assertEqual(result['asrModels'], [{'id': 'configured', 'label': 'Whisper large-v3', 'selected': True}])
        self.assertNotIn('C:/private', str(result))


if __name__ == '__main__':
    unittest.main()
