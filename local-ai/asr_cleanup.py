"""Legacy entry points: acoustic words must never be rewritten by grammar rules.

Kept for callers of older gateway versions. In particular, a cardinal must not
be converted to an ordinal because a sentence looks grammatically unusual.
"""


def safe_correction(original, candidate):
    return isinstance(candidate, str) and candidate == original


def apply_corrections(result, candidates):
    return result


def restore_appositive_ordinals(result):
    return result
