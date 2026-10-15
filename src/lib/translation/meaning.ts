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
export function shorteningPreservesAnchors(fullSwedish: string, candidateSwedish: string, language = "sv"): { ok: boolean; missing: string[] } {
  if (language !== "sv") return translationPreservesFacts(fullSwedish, candidateSwedish, language, language);
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

const englishNumbers: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, first: 1, second: 2, third: 3, fourth: 4,
  fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40,
};
const arabicNumbers: Record<string, number> = {
  صفر: 0, واحد: 1, واحدة: 1, اثنان: 2, اثنين: 2, اثنتان: 2, اثنتين: 2,
  ثلاثة: 3, ثلاث: 3, اربعة: 4, اربع: 4, خمسة: 5, خمس: 5, ستة: 6, ست: 6,
  سبعة: 7, سبع: 7, ثمانية: 8, ثماني: 8, ثمان: 8, تسعة: 9, تسع: 9, عشرة: 10, عشر: 10,
  عشرون: 20, عشرين: 20, ثلاثون: 30, ثلاثين: 30, اربعون: 40, اربعين: 40,
  خمسون: 50, خمسين: 50, ستون: 60, ستين: 60, سبعون: 70, سبعين: 70,
  ثمانون: 80, ثمانين: 80, تسعون: 90, تسعين: 90,
  اول: 1, اولي: 1, ثاني: 2, ثانية: 2, ثالث: 3, ثالثة: 3, رابع: 4, رابعة: 4,
  خامس: 5, خامسة: 5, سادس: 6, سادسة: 6, سابع: 7, سابعة: 7,
  ثامن: 8, ثامنة: 8, تاسع: 9, تاسعة: 9, عاشر: 10, عاشرة: 10,
  مئة: 100, مائة: 100, مئه: 100, مائتان: 200, مئتان: 200, مائتين: 200, مئتين: 200,
  ثلاثمئة: 300, ثلاثمائة: 300, اربعمئة: 400, اربعمائة: 400, خمسمئة: 500, خمسمائة: 500,
  ستمئة: 600, ستمائة: 600, سبعمئة: 700, سبعمائة: 700, ثمانمئة: 800, ثمانمائة: 800,
  تسعمئة: 900, تسعمائة: 900, الف: 1000, الفان: 2000, الفين: 2000,
};
const ambiguousOrdinals = new Set(["first", "second", "third", "första", "förste", "andra", "andre", "tredje"]);
const numberedUnits = /^(?:place|places|day|days|month|months|year|years|time|times|title|titles|storm|storms|floor|floors|prize|prizes|plats|platsen|dag|dagen|månaden|året|gången|titel|titeln|storm|stormen|våningen|priset)$/u;
function normalizedFacts(text: string) {
  return text.normalize("NFKC").replace(/[٠-٩۰-۹]/gu, (d) => String(d.charCodeAt(0) - (d <= "٩" ? 0x660 : 0x6f0)))
    .replace(/[٫]/gu, ".").replace(/[٬]/gu, "").replace(/\p{M}/gu, "").replace(/[أإآ]/gu, "ا").replace(/ى/gu, "ي");
}
function arabicNumberToken(token: string) {
  // ألف begins with the same letters as the definite article ال. Test the
  // number itself before stripping articles or attached conjunctions.
  for (const candidate of [token, token.replace(/^[وبفل]/u, "")]) {
    if (arabicNumbers[candidate] !== undefined || candidate === "الاف") return candidate;
    const bare = candidate.replace(/^ال/u, "");
    if (arabicNumbers[bare] !== undefined) return bare;
  }
  return token;
}
function factNumbers(text: string, language: string): Set<string> {
  let normalized = normalizedFacts(text).replace(/(?<=\d)[ \u00a0\u202f](?=\d{3}(?:[^\d]|$))/gu, "");
  if (language === "en" || language === "auto") normalized = normalized.replace(/(?<!\d)\d{1,3}(?:,\d{3})+(?!\d)/gu, (value) => value.replace(/,/gu, ""));
  const result = new Set<string>();
  for (const match of normalized.matchAll(/(?<![\p{L}\d])[-−+]?\d+(?:[.,]\d+)?(?:(?:st|nd|rd|th)|:[ae])?(?![\p{L}\d])/giu)) {
    result.add(digitValue(match[0].replace(/(?:st|nd|rd|th)$/iu, "")));
  }
  const tokens = words(normalized).map((w) => w.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (language === "ar" || (language === "auto" && /\p{Script=Arabic}/u.test(token))) {
      const bare = arabicNumberToken(token);
      let value = arabicNumbers[bare];
      if (value === undefined) continue;
      while (i + 1 < tokens.length) {
        const next = tokens[i + 1];
        const nextBare = arabicNumberToken(next);
        const nextValue = arabicNumbers[nextBare];
        if (["الاف", "الف"].includes(nextBare) && value < 1000) { value *= 1000; i++; }
        else if (nextValue !== undefined && (next.startsWith("و") || value < 10 && nextValue === 10)) { value += nextValue; i++; }
        else break;
      }
      result.add(String(value));
    } else if (language === "en" || language === "auto") {
      if (ambiguousOrdinals.has(token) && !numberedUnits.test(tokens[i + 1] || "")) continue;
      // Parse complete written quantities instead of comparing e.g. the 1 and
      // 20 inside "one hundred and twenty" with the source value 120.
      const scales: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000 };
      let end = i;
      while (end < tokens.length && (englishNumbers[tokens[end]] !== undefined || scales[tokens[end]] || tokens[end] === "and")) end++;
      if (tokens.slice(i, end).some((w) => scales[w])) {
        let total = 0; let group = 0;
        for (const word of tokens.slice(i, end)) {
          if (word === "hundred") group = Math.max(1, group) * 100;
          else if (scales[word]) { total += Math.max(1, group) * scales[word]; group = 0; }
          else if (englishNumbers[word] !== undefined) group += englishNumbers[word];
        }
        result.add(String(total + group)); i = end - 1; continue;
      }
      const parts = token.split(/[-‐‑]/u);
      let value = englishNumbers[parts[0]];
      if (value !== undefined) {
        if (parts.length === 2 && value >= 20 && englishNumbers[parts[1]] > 0 && englishNumbers[parts[1]] < 10) value += englishNumbers[parts[1]];
        else if (value >= 20 && englishNumbers[tokens[i + 1]] > 0 && englishNumbers[tokens[i + 1]] < 10) value += englishNumbers[tokens[++i]];
        result.add(String(value));
      }
    }
    if (language === "sv" || language === "auto") {
      // Swedish en/ett are also indefinite articles; they cannot be safely
      // compared across languages as numerical facts without a semantic model.
      const value = writtenNumber(token);
      if (value !== undefined && !["en", "ett"].includes(token) && (!ambiguousOrdinals.has(token) || numberedUnits.test(tokens[i + 1] || ""))) result.add(String(value));
    }
  }
  return result;
}
const englishCommon = new Set(("a an the i you he she it we they my our your his her its their this that these those there here then now today tomorrow yesterday please hello hi good thanks thank yes no do does did will would can could should may might have has had is are was were be been being to for from at on in by with without and or but if when where why how what who which not never none nothing nobody one two three four five six seven eight nine ten all some any each every both neither either after before because however also already only still just very really perhaps maybe so as of about into during over under again much many more most less little let lets im ive ill dont cant wont isnt wasnt were arent didnt couldnt wouldnt must said says say tell told come came goes went got get made make called named meet met arrived later first second third fourth fifth sixth seventh eighth ninth tenth eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety" ).split(/\s+/u));
function hasNegation(text: string, language: string) {
  const clean = normalizedFacts(text).toLowerCase().replace(/[’']/gu, "");
  const tokens = words(clean);
  if (language === "ar" || /\p{Script=Arabic}/u.test(clean)) return tokens.some((w) => ["لا", "ليس", "ليست", "لم", "لن", "ابدا", "بدون", "مو", "مش"].includes(w));
  if (language === "sv" || language === "auto" && tokens.some((w) => negations.has(w))) return tokens.some((w) => negations.has(w));
  return tokens.some((w) => ["no", "not", "never", "none", "nothing", "nobody", "without", "neither", "dont", "doesnt", "didnt", "cant", "cannot", "wont", "wouldnt", "couldnt", "shouldnt", "isnt", "arent", "wasnt", "werent", "havent", "hasnt", "hadnt"].includes(w));
}
/** Deterministic fact anchors complement the bilingual model review. Arabic
 * name transliteration and full semantic equivalence still require that review. */
export function translationPreservesFacts(source: string, candidate: string, sourceLanguage = "auto", targetLanguage = "en"): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const sourceNumbers = factNumbers(source, sourceLanguage);
  const candidateNumbers = factNumbers(candidate, targetLanguage);
  for (const value of sourceNumbers) if (!candidateNumbers.has(value)) missing.push(`tal:${value}`);
  for (const value of candidateNumbers) if (!sourceNumbers.has(value)) missing.push(`tillagt-tal:${value}`);
  if (hasNegation(source, sourceLanguage) !== hasNegation(candidate, targetLanguage)) missing.push("negation");
  // A capitalized common noun at the beginning of a sentence is not evidence
  // of a name (Huset, Friday, Welcome). Cross-language Latin names are only
  // deterministic anchors when embedded in Arabic; the bilingual accuracy
  // review handles names in other cross-language text. Same-language timing
  // rewrites can preserve spelling conservatively without transliteration.
  if (targetLanguage !== "ar" && (sourceLanguage === targetLanguage || /\p{Script=Arabic}/u.test(source))) {
    const candidateWords = new Set(words(candidate).map((w) => w.toLowerCase()));
    for (const name of new Set(words(source))) {
      const lower = name.toLowerCase();
      if (!/^\p{Lu}[\p{Script=Latin}‐‑-]+$/u.test(name) || commonCapitalizedWords.has(lower) || englishCommon.has(lower) || writtenNumber(lower) !== undefined || englishNumbers[lower] !== undefined) continue;
      if (!candidateWords.has(lower)) missing.push(`namn:${name}`);
    }
  }
  return { ok: missing.length === 0, missing };
}
