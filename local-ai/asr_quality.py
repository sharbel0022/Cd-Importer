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
    for segment in result['segments']:
        native_measurements(segment, ('start', 'end', 'avg_logprob', 'no_speech_prob', 'temperature', 'compression_ratio', 'confidence'))
        reasons = []
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
        for word in segment.get('words', []):
            native_measurements(word, ('start', 'end', 'probability'))
            probability = word.get('probability')
            word['uncertain'] = bool(finite_number(probability) and probability < 0.55)
        if any(word.get('uncertain') for word in segment.get('words', [])):
            reasons.append('low_word_probability')
        segment['quality_reasons'] = reasons
        segment['uncertain'] = bool(reasons) or bool(segment.get('uncertain'))
    result['review_required'] = any(s['uncertain'] for s in result['segments'])
    return result
