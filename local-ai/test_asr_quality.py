import unittest
from asr_quality import repetition_loop


class QualityTests(unittest.TestCase):
    def test_rejects_decoder_loop(self):
        self.assertTrue(repetition_loop('بداية كلام ثم ' + 'ايش قد ممكن ' * 20))

    def test_keeps_brief_real_repetition(self):
        self.assertFalse(repetition_loop('3 ابطال 3 ابطال 3 ابطال'))
        self.assertFalse(repetition_loop('Vänta vänta jag vill fråga. Tre mästare tre mästare. Nästa år.'))


if __name__ == '__main__':
    unittest.main()
