"""Acoustic review indicators, never replacement words or factual corrections.

Whisper probabilities are decoder scores, not calibrated accuracy estimates.
Keep the original text and mark questionable output for human review.
"""
import math
import re
import unicodedata
from collections import Counter
from numbers import Real


def repetition_loop(text):
    normalized = ''.join(c for c in unicodedata.normalize('NFKC', text.lower()) if unicodedata.category(c) != 'Mn')
    tokens = re.findall(r'\w+', normalized)
    if len(tokens) < 15:
        return False
    for size in (3, 4, 5):
        counts = Counter(tuple(tokens[i:i + size]) for i in range(len(tokens) - size + 1))
        if any(count >= 5 and count * size >= len(tokens) * 0.6 for count in counts.values()):
            return True
    return False


def finite_number(value):
    return isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value)


def native_measurements(item, fields):
    # faster-whisper may return NumPy scalars. FastAPI cannot encode np.bool_
    # and some NumPy floats; return ordinary JSON numeric/boolean values.
    for field in fields:
        if finite_number(item.get(field)):
            item[field] = float(item[field])


def mark_uncertainty(result):
    """Annotate measured words/segments without deleting or rewriting speech."""
    native_measurements(result, ('language_probability', 'duration', 'duration_after_vad'))
    language_probability = result.get('language_probability')
    uncertain_language = bool(finite_number(language_probability) and language_probability < 0.6)
    cross_segment_loop = repetition_loop(' '.join(s['text'] for s in result['segments']))
    for segment in result['segments']:
        segment.setdefault('raw_text', segment['text'])
        # Script evidence flags possible code-switching, not a claim that a
        # proper name or borrowed word belongs to a particular language.
        segment['code_switch'] = bool(re.search(r'[\u0621-\u064a]', segment['text']) and re.search(r'[a-zA-Z]', segment['text']))
        native_measurements(segment, ('start', 'end', 'avg_logprob', 'no_speech_prob', 'temperature', 'compression_ratio', 'confidence'))
        reasons = []
        normalized = ''.join(c for c in unicodedata.normalize('NFKC', segment['text']) if unicodedata.category(c) != 'Mn')
        tokens = re.findall(r'\w+', normalized)
        ambiguous = set()
        # This construction can be a spoken grammatical error OR a missed
        # vowel. Flag it for listening; never choose an ordinal/cardinal form.
        cardinals = {'ثلاث', 'ثلاثة', 'أربع', 'أربعة', 'اربع', 'اربعة', 'خمس', 'خمسة', 'ست', 'ستة', 'سبع', 'سبعة', 'ثمان', 'ثمانية', 'تسع', 'تسعة', 'عشر', 'عشرة'}
        for i in range(len(tokens) - 2):
            number, noun = tokens[i:i + 2]
            if number in cardinals and noun.endswith('ة') and not noun.startswith('ال') and 'ال' + noun in tokens[i + 2:i + 28]:
                ambiguous.add(number)
        if ambiguous:
            reasons.append('cardinal_ordinal_requires_listening')
        if uncertain_language:
            reasons.append('uncertain_language')
        if finite_number(segment.get('avg_logprob')) and segment['avg_logprob'] < -0.8:
            reasons.append('low_log_probability')
        if finite_number(segment.get('no_speech_prob')) and segment['no_speech_prob'] > 0.55:
            reasons.append('possible_background_noise_or_silence')
        if finite_number(segment.get('temperature')) and segment['temperature'] >= 0.6:
            reasons.append('fallback_decoding')
        if finite_number(segment.get('compression_ratio')) and segment['compression_ratio'] > 2.4:
            reasons.append('high_compression_ratio')
        if repetition_loop(segment['text']):
            reasons.append('repeated_phrase')
        elif cross_segment_loop:
            reasons.append('repeated_phrase_across_segments')
        for word in segment.get('words', []):
            native_measurements(word, ('start', 'end', 'probability'))
            probability = word.get('probability')
            token = ''.join(c for c in unicodedata.normalize('NFKC', word['word']) if unicodedata.category(c) != 'Mn').strip()
            word['uncertain'] = bool(finite_number(probability) and probability < 0.55) or token in ambiguous
        if any(word.get('uncertain') for word in segment.get('words', [])):
            reasons.append('low_word_probability')
        segment['quality_reasons'] = reasons
        segment['uncertain'] = bool(reasons) or bool(segment.get('uncertain'))
    result['review_required'] = any(s['uncertain'] for s in result['segments'])
    return result
