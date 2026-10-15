"""Conservative detection of a decoder stuck repeating a multiword phrase."""
import re
from collections import Counter


def repetition_loop(text):
    tokens = re.findall(r'\w+', text.lower())
    if len(tokens) < 15:
        return False
    for size in (3, 4, 5):
        counts = Counter(tuple(tokens[i:i + size]) for i in range(len(tokens) - size + 1))
        if any(count >= 5 and count * size >= len(tokens) * 0.6 for count in counts.values()):
            return True
    return False
