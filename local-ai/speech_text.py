"""Pronunciation normalization for synthesis only; exported translation stays intact."""
import re


def speech_text(text, language):
    if language == 'sv':
        # Bundled eSpeak 1.8 phonemizes `tionde` as ɧˈuːndə (wrong ordinal).
        # Explicit IPA preserves the long /i/ and following unstressed vowel.
        text = re.sub(r'\btionde\b', '[[tˈiːʊndə]]', text, flags=re.IGNORECASE)
        # Swedish eSpeak reads the final English y as Swedish /y:/ in these
        # names. Preserve the visible name but synthesize its final /i:/.
        text = re.sub(r'\b(Jerry|Terry|Larry|Barry|Harry)\b', lambda m: m.group(0)[:-1] + 'i', text)
        text = re.sub(r'\bJerri\b', '[[jˈɛrɪ]]', text)
        # Piper only preserves the boundary after a raw phoneme block when
        # the next character is a space; leading punctuation is otherwise
        # stripped by eSpeak, joining e.g. Jerry + en into one spoken word.
        text = re.sub(r'\]\](?=[,.;:!?])', ']] ', text)
        return text
    return text
