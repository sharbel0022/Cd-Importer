import type { GlossaryEntry, StudioOptions } from "./types";

export function translationModeInstruction(mode: StudioOptions["translationMode"]) {
  const common = "Preserve all spoken claims, slips, self-corrections, negations, names, quantities and contradictions, including factual mistakes.";
  switch (mode) {
    case "natural": return `Use natural target-language grammar. ${common}`;
    case "professional": return `Use professional terminology and a formal register, without adding expertise, certainty or claims. ${common}`;
    case "literal": return `Stay close to the source structure wherever meaningful; avoid nonsensical word-for-word output. ${common}`;
    default: return `Faithful Translation: preserve what the speaker ACTUALLY SAID, including meaningful grammatical mistakes. Never replace a spoken wrong word with a presumed intended word. ${common}`;
  }
}

function containsTerm(text: string, term: string) {
  const escape = term.normalize("NFKC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Unicode boundaries support Arabic and do not mistake e.g. AX for TAX.
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape}(?![\\p{L}\\p{N}])`, "iu").test(text.normalize("NFKC"));
}

export function activeGlossary(source: string, target: string, entries: GlossaryEntry[] = []) {
  return entries.filter((entry) => (entry.target === "*" || entry.target === target) && containsTerm(source, entry.source));
}

export function glossaryViolations(source: string, translated: string, target: string, entries: GlossaryEntry[] = []) {
  return activeGlossary(source, target, entries).filter((entry) => !containsTerm(translated, entry.protect ? entry.source : entry.translation)).map((entry) => `terminologi: ${entry.source} → ${entry.protect ? entry.source : entry.translation}`);
}
