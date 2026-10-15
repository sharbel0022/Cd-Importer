const smallNumbers: Record<string, number> = {
  noll: 0, en: 1, ett: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6,
  sju: 7, åtta: 8, nio: 9, tio: 10, elva: 11, tolv: 12, tretton: 13,
  fjorton: 14, femton: 15, sexton: 16, sjutton: 17, arton: 18, nitton: 19,
  första: 1, förste: 1, andra: 2, andre: 2, tredje: 3, fjärde: 4,
  femte: 5, sjätte: 6, sjunde: 7, åttonde: 8, nionde: 9, tionde: 10,
  elfte: 11, tolfte: 12, trettonde: 13, fjortonde: 14, femtonde: 15,
  sextonde: 16, sjuttonde: 17, artonde: 18, nittonde: 19,
};

const tens: Record<string, number> = {
  tjugo: 20, trettio: 30, fyrtio: 40, femtio: 50, sextio: 60,
  sjuttio: 70, åttio: 80, nittio: 90,
};

const ordinalTens: Record<string, number> = {
  tjugonde: 20, trettionde: 30, fyrtionde: 40, femtionde: 50,
  sextionde: 60, sjuttionde: 70, åttionde: 80, nittionde: 90,
};

const negations = new Set(["inte", "aldrig", "ingen", "inget", "inga", "nej", "utan"]);

// Sentence starts are ambiguous without a language model. Common Swedish words
// are excluded; unfamiliar capitalized words are deliberately kept as anchors,
// including names such as Jerry or Butros at the beginning of a sentence.
const commonCapitalizedWords = new Set((
  "alla allt alltid annan annars att av bara bland blev bli blir både där därför " +
  "då de dem den denna denne deras dessa dess det detta dig din dina dit dock du " +
  "efter eftersom eller enligt er era ett finns fick fler flera från får för före " +
  "först genom gick gör hade han hans har hela henne hennes hit hon hos hur här " +
  "i idag igen imorgon in innan jag ju kan kanske kommer kunde kvar länge man " +
  "med mellan men mer mig min mina mitt mot mycket måste ni nog nu nya någon " +
  "något några när och också om oss på redan samma sedan sig sin sina sitt ska " +
  "skall skulle som så sådan sådana sånt säger till tillsammans tillbaka trots " +
  "tyvärr under upp ur ut utan vad var vara varje vart vem vi vid vilka vilken " +
  "vilket vill vår våra vårt väl över även är än ännu äntligen årets vädret " +
  "titlar titlarna senare slutligen samtidigt"
).split(/\s+/u));

function writtenNumber(word: string): number | undefined {
  const compact = word.replace(/[-‐‑]/gu, "");
  if (Object.hasOwn(smallNumbers, compact)) return smallNumbers[compact];
  if (Object.hasOwn(tens, compact)) return tens[compact];
  if (Object.hasOwn(ordinalTens, compact)) return ordinalTens[compact];
  for (const [prefix, value] of Object.entries(tens)) {
    if (!compact.startsWith(prefix)) continue;
    const suffix = smallNumbers[compact.slice(prefix.length)];
    if (suffix !== undefined && suffix > 0 && suffix < 10) return value + suffix;
  }
  return undefined;
}

function words(text: string): string[] {
  return text.normalize("NFC").match(/\p{L}+(?:[-‐‑]\p{L}+)*/gu) ?? [];
}

function digitValue(raw: string): string {
  const normalized = raw.replace(/[\s\u00a0\u202f]/gu, "").replace(/:[ae]$/iu, "").replace("−", "-").replace(",", ".");
  const negative = normalized.startsWith("-");
  const [integer, decimal = ""] = normalized.replace(/^[+-]/u, "").split(".");
  const whole = integer.replace(/^0+(?=\d)/u, "");
  const fraction = decimal.replace(/0+$/u, "");
  const value = whole + (fraction ? `.${fraction}` : "");
  return negative && value !== "0" ? `-${value}` : value;
}

function numbers(text: string): Set<string> {
  const result = new Set<string>();
  // Do not join ordinary neighboring numbers. Only spaces before complete
  // three-digit groups are treated as thousands separators.
  const grouped = text.normalize("NFC").replace(/(?<=\d)[ \u00a0\u202f](?=\d{3}(?:[^\d]|$))/gu, "");
  for (const match of grouped.matchAll(/(?<![\p{L}\d])[-−+]?\d+(?:[.,]\d+)?(?::[ae])?(?![\p{L}\d])/giu)) {
    result.add(digitValue(match[0]));
  }
  for (const word of words(text)) {
    const value = writtenNumber(word.toLocaleLowerCase("sv"));
    if (value !== undefined) result.add(String(value));
  }
  return result;
}

/**
 * A conservative Swedish shortening guard, not a semantic equivalence check.
 * Missing anchors use stable diagnostics: tal:<value>, namn:<word>, negation.
 * Number repetitions are ignored; written ordinals share their numeric value.
 */
export function shorteningPreservesAnchors(fullSwedish: string, candidateSwedish: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const candidateNumbers = numbers(candidateSwedish);
  for (const value of numbers(fullSwedish)) {
    if (!candidateNumbers.has(value)) missing.push(`tal:${value}`);
  }

  const fullWords = words(fullSwedish);
  const candidateWords = new Set(words(candidateSwedish).map((word) => word.toLocaleLowerCase("sv")));
  if (fullWords.some((word) => negations.has(word.toLocaleLowerCase("sv"))) && ![...candidateWords].some((word) => negations.has(word))) {
    missing.push("negation");
  }

  const seenNames = new Set<string>();
  for (const word of fullWords) {
    const lower = word.toLocaleLowerCase("sv");
    if (!/^\p{Lu}[\p{L}‐‑-]+$/u.test(word) || commonCapitalizedWords.has(lower) || negations.has(lower) || writtenNumber(lower) !== undefined || seenNames.has(lower)) continue;
    seenNames.add(lower);
    if (!candidateWords.has(lower)) missing.push(`namn:${word}`);
  }

  return { ok: missing.length === 0, missing };
}
