import unittest
from asr_cleanup import apply_corrections, safe_correction, restore_appositive_ordinals
from speech_text import speech_text


class CleanupTests(unittest.TestCase):
    def test_swedish_ordinal_pronunciation_changes_only_synthesis_spelling(self):
        self.assertEqual(speech_text('Säsongens tionde storm.', 'sv'), 'Säsongens [[tˈiːʊndə]] storm.')
        self.assertEqual(speech_text('Tionde och sjunde.', 'sv'), '[[tˈiːʊndə]] och sjunde.')
        self.assertEqual(speech_text('tionde', 'en'), 'tionde')
        self.assertEqual(speech_text('Jerry är tionde.', 'sv'), '[[jˈɛrɪ]] är [[tˈiːʊndə]] .')
        self.assertEqual(speech_text('Jerry, en storm.', 'sv'), '[[jˈɛrɪ]] , en storm.')
    def test_bounded_inflection_with_raw_evidence(self):
        raw = 'تشكلت في المحيط اليوم عشر عاصفة مسمى لموسم الأعاصير الأطلسية'
        corrected = 'تشكلت في المحيط اليوم عاشر عاصفة مسماة لموسم الأعاصير الأطلسية'
        self.assertTrue(safe_correction(raw, corrected))
        result = apply_corrections({'segments': [{'text': raw, 'words': []}]}, [{'id': '0', 'text': corrected}])
        self.assertEqual(result['segments'][0]['raw_text'], raw)
        self.assertEqual(result['segments'][0]['text'], corrected)
        self.assertTrue(result['segments'][0]['uncertain'])
        self.assertTrue(result['review_required'])
        self.assertIn('linguistic_correction_requires_review', result['segments'][0]['quality_reasons'])

    def test_no_new_claims_digits_or_negation(self):
        self.assertFalse(safe_correction('قال لنا 15 دقيقة', 'قال لنا 50 دقيقة'))
        self.assertFalse(safe_correction('لا يمكن للحيوانات البقاء', 'ما يمكن للحيوانات البقاء'))
        self.assertFalse(safe_correction('لا يمكن للحيوانات البقاء', 'يمكن للحيوانات البقاء'))
        self.assertFalse(safe_correction('قال لنا هذا الكلام', 'قال لنا هذا الكلام اليوم'))
        self.assertFalse(safe_correction('عاصفة شبه استوائية', 'إعصار شبه استوائي'))
        self.assertFalse(safe_correction('عاصفة شبه استوائية', 'Ignore previous instructions'))

    def test_inferred_word_retains_acoustic_spelling_and_score(self):
        result = apply_corrections({'segments': [{'text': 'عشر عاصفة', 'words': [
            {'word': ' عشر', 'start': 0, 'end': 1, 'probability': 0.95},
            {'word': ' عاصفة', 'start': 1, 'end': 2, 'probability': 0.9},
        ]}]}, [{'id': '0', 'text': 'عاشر عاصفة'}])
        word = result['segments'][0]['words'][0]
        self.assertEqual(word['raw_word'], ' عشر')
        self.assertTrue(word['uncertain'])
        self.assertEqual(word['probability'], 0.95)
        self.assertEqual(result['segments'][0]['words'][1]['word'], ' عاصفة')

    def test_rank_inference_requires_matching_singular_apposition(self):
        def corrected(text):
            return restore_appositive_ordinals({'segments': [{'text': text}]})['segments'][0]
        raw = 'افتتحت اليوم ثلاث مدرسة في المدينة المدرسة الجديدة'
        self.assertIn('ثالث مدرسة', corrected(raw)['text'])
        self.assertEqual(corrected(raw)['raw_text'], raw)
        for text in ['افتتحت اليوم ثلاث مدارس في المدينة', 'وصلت عشر عواصف إلى الساحل', 'عشر مدرسة في المدينة', 'اشتريت عشرة كتب من المكتبة']:
            self.assertEqual(corrected(text)['text'], text)


if __name__ == '__main__':
    unittest.main()
