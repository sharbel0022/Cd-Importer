import unittest
import json
from asr_quality import mark_uncertainty, repetition_loop


class QualityTests(unittest.TestCase):
    def test_rejects_decoder_loop(self):
        self.assertTrue(repetition_loop('بداية كلام ثم ' + 'ايش قد ممكن ' * 20))

    def test_keeps_brief_real_repetition(self):
        self.assertFalse(repetition_loop('3 ابطال 3 ابطال 3 ابطال'))
        self.assertFalse(repetition_loop('Vänta vänta jag vill fråga. Tre mästare tre mästare. Nästa år.'))

    def test_diacritics_cannot_hide_decoder_loop(self):
        self.assertTrue(repetition_loop('كلام البداية ' + 'هٰذا كلام عربي ' * 12))

    def test_marks_words_without_replacing_uncertain_facts(self):
        original = 'لن يدفع أحمد ٣٠ دولارًا'
        result = mark_uncertainty({'language_probability': 0.98, 'segments': [{
            'text': original, 'avg_logprob': -0.2, 'no_speech_prob': 0.01,
            'words': [{'word': 'أحمد', 'probability': 0.3}, {'word': '٣٠', 'probability': 0.9}],
        }]})
        self.assertEqual(result['segments'][0]['text'], original)
        self.assertEqual([w['uncertain'] for w in result['segments'][0]['words']], [True, False])
        self.assertEqual(result['segments'][0]['quality_reasons'], ['low_word_probability'])
        self.assertTrue(result['review_required'])

    def test_acoustic_risks_and_uncertain_language_require_review(self):
        result = mark_uncertainty({'language_probability': 0.4, 'segments': [{
            'text': 'maybe speech', 'avg_logprob': -1.2, 'no_speech_prob': 0.8,
            'temperature': 0.8, 'compression_ratio': 3.0,
        }]})
        self.assertEqual(len(result['segments'][0]['quality_reasons']), 5)

    def test_good_speech_and_unavailable_word_scores_are_not_invented(self):
        result = mark_uncertainty({'language_probability': 0.95, 'segments': [{
            'text': 'Hello there', 'avg_logprob': -0.1, 'no_speech_prob': 0.01,
            'temperature': 0, 'compression_ratio': 1.1, 'words': [{'word': 'Hello'}],
        }]})
        self.assertFalse(result['review_required'])
        self.assertNotIn('probability', result['segments'][0]['words'][0])

    def test_real_numpy_decoder_scalars_serialize_through_fastapi(self):
        import numpy as np
        from fastapi.encoders import jsonable_encoder
        result = mark_uncertainty({'language_probability': np.float32(0.9), 'duration': np.float64(2), 'segments': [{
            'start': np.float32(0), 'end': np.float32(1.5), 'text': 'Ahmed has 23 tickets',
            'avg_logprob': np.float32(-0.1), 'no_speech_prob': np.float32(0.1),
            'temperature': np.float32(0), 'compression_ratio': np.float32(1.1),
            'words': [{'word': 'Ahmed', 'start': np.float32(0), 'end': np.float32(0.5), 'probability': np.float64(0.4)}],
        }]})
        self.assertEqual(type(result['segments'][0]['words'][0]['uncertain']), bool)
        self.assertEqual(type(result['segments'][0]['words'][0]['probability']), float)
        decoded = json.loads(json.dumps(jsonable_encoder(result), allow_nan=False))
        self.assertTrue(decoded['review_required'])


if __name__ == '__main__':
    unittest.main()
