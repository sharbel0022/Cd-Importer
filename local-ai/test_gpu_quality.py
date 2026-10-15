"""Quality measurements and explicit GPU mode must never report false success."""
import os
import unittest
from unittest.mock import patch

from benchmark_gpu import wer
import server


class GpuQualityTests(unittest.TestCase):
    def test_wer_counts_insertions_deletions_and_arabic_marks(self):
        self.assertEqual(wer('one two three', 'one four')['rate'], 2 / 3)
        self.assertEqual(wer('one', 'one two')['rate'], 1)
        self.assertEqual(wer('عاصفة مُسماة', 'عاصفة مسماة')['rate'], 0)
        with self.assertRaises(ValueError):
            wer('', 'invented speech')

    def test_strict_cuda_never_falls_back_after_initialization_failure(self):
        selected = [{'id': 'configured', 'model': 'local-weights', 'selected': True}]
        with patch.dict(os.environ, {'WHISPER_DEVICE': 'cuda', 'WHISPER_REQUIRE_GPU': 'true'}), \
             patch.object(server, 'installed_models', return_value=selected), \
             patch.object(server, 'whisper', None), patch.object(server, 'whisper_key', None), \
             patch('faster_whisper.WhisperModel', side_effect=RuntimeError('CUDA incompatible')) as model:
            with self.assertRaisesRegex(RuntimeError, 'CUDA incompatible'):
                server.transcribe_sync('audio.wav', '', '', '')
            self.assertEqual(model.call_count, 1)
            self.assertEqual(model.call_args.kwargs['device'], 'cuda')

    def test_strict_cuda_rejects_cpu_configuration(self):
        selected = [{'id': 'configured', 'model': 'local-weights', 'selected': True}]
        with patch.dict(os.environ, {'WHISPER_DEVICE': 'cpu', 'WHISPER_REQUIRE_GPU': 'true'}), \
             patch.object(server, 'installed_models', return_value=selected), \
             patch.object(server, 'whisper', None), patch.object(server, 'whisper_key', None), \
             patch('faster_whisper.WhisperModel') as model:
            with self.assertRaisesRegex(RuntimeError, 'requires CUDA'):
                server.transcribe_sync('audio.wav', '', '', '')
            model.assert_not_called()


if __name__ == '__main__':
    unittest.main()
