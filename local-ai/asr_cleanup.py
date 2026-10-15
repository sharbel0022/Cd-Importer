"""Conservative Arabic spelling/inflection cleanup; always retain acoustic text.

This is linguistic inference, not another acoustic measurement. Never insert
missing words, change digits or negation, or silently replace an ASR sentence.
"""
import re
import unicodedata

NEGATION = {"لا", "لم", "لن", "ليس", "ليست", "ما", "مش", "مو", "بدون"}
ORDINAL_STEMS = {'ثلاث': 'ثالث', 'ثلاثة': 'ثالث', 'أربع': 'رابع', 'أربعة': 'رابع', 'خمس': 'خامس', 'خمسة': 'خامس', 'ست': 'سادس', 'ستة': 'سادس', 'سبع': 'سابع', 'سبعة': 'سابع', 'ثمان': 'ثامن', 'ثماني': 'ثامن', 'ثمانية': 'ثامن', 'تسع': 'تاسع', 'تسعة': 'تاسع', 'عشر': 'عاشر', 'عشرة': 'عاشر'}


def words(text):
    return re.findall(r"[\w]+", ''.join(c for c in unicodedata.normalize('NFKC', text) if unicodedata.category(c) != 'Mn'), flags=re.UNICODE)


def distance(a, b):
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        next_row = [i]
        for j, y in enumerate(b, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (x != y)))
        row = next_row
    return row[-1]


def safe_correction(original, candidate):
    if not isinstance(candidate, str) or not candidate.strip() or len(candidate) > len(original) * 1.15 + 4:
        return False
    before, after = words(original), words(candidate)
    if len(before) != len(after) or not before:
        return False
    edits = 0
    for a, b in zip(before, after):
        if a == b:
            continue
        if any(c.isdigit() for c in a + b) or a in NEGATION or b in NEGATION:
            return False
        if not re.fullmatch(r'[\u0621-\u064A]+', a + b):
            return False
        change = distance(a, b)
        if change > 2 or min(len(a), len(b)) < 3:
            return False
        edits += change
    return edits <= max(1, int(sum(map(len, before)) * 0.08))


def apply_corrections(result, candidates):
    lookup = {str(s.get('id')): s.get('text') for s in candidates if isinstance(s, dict)}
    for i, segment in enumerate(result['segments']):
        original = segment['text']
        candidate = lookup.get(str(i))
        if candidate != original and safe_correction(original, candidate):
            segment.setdefault('raw_text', original)
            segment['text'] = candidate.strip()
            segment['linguistic_correction'] = True
            # One-to-one lexical edits preserve the measured word timestamps.
            for word, token in zip(segment.get('words', []), words(candidate)):
                word['word'] = token
    return result


def restore_appositive_ordinals(result):
    """Resolve a narrow ASR vowel ambiguity in formal rank constructions.

    A 3–10 cardinal takes a plural noun. A singular feminine noun followed by
    the *same definite singular* in apposition instead describes one ranked
    entity. This is a disclosed grammar inference, not acoustic certainty.
    Actual plural counts, digits, and sentences without this apposition stay.
    """
    candidates = []
    for i, segment in enumerate(result['segments']):
        tokens = words(segment['text'])
        candidate = segment['text']
        for j in range(len(tokens) - 2):
            number, noun = tokens[j:j + 2]
            if number not in ORDINAL_STEMS or not noun.endswith('ة') or noun.startswith('ال'):
                continue
            if 'ال' + noun not in tokens[j + 2:j + 26]:
                continue
            candidate = re.sub(r'(?<!\w)' + re.escape(number) + r'(?=\s+' + re.escape(noun) + r'(?!\w))', ORDINAL_STEMS[number], candidate, count=1)
        candidates.append({'id': str(i), 'text': candidate})
    return apply_corrections(result, candidates)
