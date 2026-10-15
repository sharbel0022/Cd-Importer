"""Gateway contracts: missing models must fail, and accents must be real."""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

import server


class GatewayTests(unittest.TestCase):
    def voice(self, root, identity, locale, quality='high'):
        model = root / (identity + '-' + quality + '.onnx')
        model.write_bytes(b'model')
        Path(str(model) + '.json').write_text(json.dumps({'language': {'code': locale}}), encoding='utf-8')
        return {'id': identity, 'language': 'en', 'model': str(model)}

    def test_discovers_real_accent_and_defaults_to_american_english(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gb = self.voice(root, 'gb', 'en_GB', 'medium')
            us = self.voice(root, 'us', 'en_US')
            with patch.dict(os.environ, {'STUDIO_PIPER_VOICES_JSON': json.dumps([gb, us])}), patch.object(server, 'installed', return_value=True):
                self.assertEqual(server.resolve_voice('en', 'auto')['id'], 'us')
                self.assertEqual(server.resolve_voice('en', 'auto', 'en-GB')['id'], 'gb')
                self.assertEqual(server.resolve_voice('en', 'gb')['locale'], 'en-GB')
                with self.assertRaises(HTTPException):
                    server.resolve_voice('en', 'gb', 'en-US')

    def test_missing_or_wrong_language_model_is_not_advertised(self):
        with tempfile.TemporaryDirectory() as directory:
            voice = self.voice(Path(directory), 'wrong', 'sv_SE')
            with patch.dict(os.environ, {'STUDIO_PIPER_VOICES_JSON': json.dumps([voice, {'id': 'missing', 'language': 'en', 'model': 'missing.onnx'}])}):
                self.assertEqual(server.voices(), [])
            for invalid in ('{}', 'null', '[null]'):
                with patch.dict(os.environ, {'STUDIO_PIPER_VOICES_JSON': invalid}):
                    self.assertEqual(server.voices(), [])

    def test_missing_whisper_weights_do_not_report_asr_ready(self):
        client = MagicMock()
        client.get = AsyncMock(side_effect=server.httpx.ConnectError('offline'))
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=None)
        with patch.dict(os.environ, {'WHISPER_MODEL': 'C:/missing/whisper'}), patch.object(server, 'installed', return_value=True), patch.object(server, 'xtts_available', return_value=False), patch.object(server.mms_voice, 'available', return_value=False), patch.object(server.httpx, 'AsyncClient', return_value=client):
            result = asyncio.run(server.health())
            self.assertFalse(result['services']['asr'])
            self.assertFalse(result['ready'])
            self.assertIn('asr', result['message'])

    def test_mms_readiness_does_not_require_piper(self):
        client = MagicMock()
        client.get = AsyncMock(side_effect=server.httpx.ConnectError('offline'))
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=None)
        with patch.object(server, 'installed', side_effect=lambda name: name != 'piper'), patch.object(server, 'xtts_available', return_value=False), patch.object(server, 'whisper_weights_available', return_value=True), patch.object(server.mms_voice, 'available', return_value=True), patch.object(server.httpx, 'AsyncClient', return_value=client):
            result = asyncio.run(server.health())
            self.assertTrue(result['services']['tts'])
            self.assertEqual(result['voices'], ['sv-mms-nc'])

    def test_failed_speech_model_cannot_return_empty_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(server, 'resolve_voice', return_value={'model': 'exists.onnx'}), patch.object(server.subprocess, 'run'):
                with self.assertRaises(HTTPException) as error:
                    server.synthesize_sync('Hello', 'en', 'auto', None, Path(directory) / 'speech.wav')
                self.assertEqual(error.exception.status_code, 502)

    def test_malformed_ollama_health_is_unavailable_not_a_gateway_crash(self):
        response = MagicMock()
        client = MagicMock()
        client.get = AsyncMock(return_value=response)
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=None)
        for payload in (None, [], {'models': None}, {'models': [None, {}]}):
            response.json.return_value = payload
            with patch.object(server, 'installed', return_value=False), patch.object(server.httpx, 'AsyncClient', return_value=client):
                result = asyncio.run(server.health())
                self.assertFalse(result['services']['translation'])

    def test_malformed_model_response_fails_without_fabricated_translation(self):
        response = MagicMock()
        client = MagicMock()
        client.post = AsyncMock(return_value=response)
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=None)
        for payload in (None, {'message': None}, {'message': {'content': None}}, {'message': {'content': '[]'}}):
            response.json.return_value = payload
            with patch.object(server.httpx, 'AsyncClient', return_value=client), self.assertRaises(ValueError):
                asyncio.run(server.ollama_json([{'role': 'user', 'content': 'Translate'}]))

    def request(self, payload):
        request = MagicMock()
        request.body = AsyncMock(return_value=json.dumps(payload).encode('utf-8'))
        return request

    def test_english_model_override_is_target_specific_and_optional(self):
        messages = [{'role': 'user', 'content': 'Translate this source'}]
        for target, english_override, expected in [('en', 'translategemma:12b', 'translategemma:12b'), ('sv', 'translategemma:12b', 'gemma3:12b'), ('ar', 'translategemma:12b', 'gemma3:12b'), (None, 'translategemma:12b', 'gemma3:12b'), ('en', '', 'gemma3:12b')]:
            payload = {'messages': messages, **({'targetLanguage': target} if target else {})}
            with patch.dict(os.environ, {'OLLAMA_MODEL': 'gemma3:12b', 'OLLAMA_ENGLISH_MODEL': english_override}), patch.object(server, 'ollama_json', new_callable=AsyncMock, return_value={'segments': []}) as call:
                asyncio.run(server.translate(self.request(payload)))
                call.assert_awaited_once_with(messages, expected)

    def test_translation_rejects_malformed_target_language_before_model_call(self):
        for target in (None, 4, [], 'en-US', 'EN', '', 'auto'):
            with patch.object(server, 'ollama_json', new_callable=AsyncMock) as call, self.assertRaises(HTTPException) as error:
                asyncio.run(server.translate(self.request({'messages': [{'role': 'user', 'content': 'Translate'}], 'targetLanguage': target})))
            self.assertEqual(error.exception.status_code, 422)
            call.assert_not_awaited()

    def test_missing_configured_english_model_makes_health_unavailable(self):
        response = MagicMock()
        response.json.return_value = {'models': [{'name': 'gemma3:12b'}]}
        client = MagicMock()
        client.get = AsyncMock(return_value=response)
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=None)
        with patch.dict(os.environ, {'OLLAMA_MODEL': 'gemma3:12b', 'OLLAMA_ENGLISH_MODEL': 'missing:12b'}), patch.object(server, 'installed', return_value=False), patch.object(server.httpx, 'AsyncClient', return_value=client):
            result = asyncio.run(server.health())
        self.assertFalse(result['services']['translation'])
        self.assertEqual(result['translationModelReady'], {'default': True, 'en': False})
        self.assertIn('missing:12b', result['message'])

    def test_missing_english_model_does_not_retry_the_primary_model(self):
        missing = server.httpx.HTTPStatusError('not found', request=server.httpx.Request('POST', 'http://localhost/api/chat'), response=server.httpx.Response(404))
        with patch.dict(os.environ, {'OLLAMA_MODEL': 'gemma3:12b', 'OLLAMA_ENGLISH_MODEL': 'missing:12b'}), patch.object(server, 'ollama_json', new_callable=AsyncMock, side_effect=missing) as call, self.assertRaises(HTTPException) as error:
            asyncio.run(server.translate(self.request({'messages': [{'role': 'user', 'content': 'Translate'}], 'targetLanguage': 'en'})))
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn('missing:12b', error.exception.detail)
        self.assertEqual(call.await_count, 1)


if __name__ == '__main__':
    unittest.main()
