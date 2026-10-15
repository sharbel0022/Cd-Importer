import copy
import unittest
from asr_cleanup import apply_corrections, restore_appositive_ordinals, safe_correction


class AcousticPreservationTests(unittest.TestCase):
    def test_no_cardinal_ordinal_grammar_or_fact_rewrite(self):
        for text in ('عشر عاصفة العاصفة جيري', 'برشلونة فاز خمسة مباريات', 'ثلاثة لا أربعة', 'لم يفز بثلاثة ألقاب'):
            result = {'segments': [{'text': text, 'words': [{'word': text, 'probability': .3}]}]}
            original = copy.deepcopy(result)
            self.assertEqual(restore_appositive_ordinals(result), original)
            self.assertEqual(apply_corrections(result, [{'id': '0', 'text': 'a plausible replacement'}]), original)

    def test_only_identical_text_is_a_safe_legacy_correction(self):
        self.assertTrue(safe_correction('ثلاثة', 'ثلاثة'))
        self.assertFalse(safe_correction('ثلاثة', 'أربعة'))
        self.assertFalse(safe_correction('عشر', 'عاشر'))


if __name__ == '__main__':
    unittest.main()
