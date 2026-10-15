import { describe, expect, it } from "vitest";
import { shorteningPreservesAnchors, translationPreservesFacts } from "@/lib/translation/meaning";

describe("Swedish shortening anchors", () => {
  it("rejects dropping a written count at the start of a sentence", () => {
    expect(shorteningPreservesAnchors("Tre titlar tilldelades Jerry.", "Titlar tilldelades Jerry.")).toEqual({ ok: false, missing: ["tal:3"] });
  });

  it.each([
    ["Vi fick 12 titlar.", "Vi fick 2 titlar.", "12"],
    ["Vi fick tjugotre titlar.", "Vi fick tjugotvå titlar.", "23"],
    ["Det hände den tionde dagen.", "Det hände den andra dagen.", "10"],
    ["Det fanns noll titlar.", "Det fanns titlar.", "0"],
    ["Det var -3 grader.", "Det var 3 grader.", "-3"],
  ])("rejects a missing or changed value: %s", (full, candidate, value) => {
    expect(shorteningPreservesAnchors(full, candidate).missing).toContain(`tal:${value}`);
  });

  it.each([
    ["Vi fick tre titlar.", "Vi fick 3 titlar."],
    ["Vi fick 3 titlar.", "Vi fick tre titlar."],
    ["Vi fick tjugotre titlar.", "Vi fick 23 titlar."],
    ["Vi fick fyrtiosju titlar.", "Vi fick 47 titlar."],
    ["Vi kom på tjugoförsta plats.", "Vi kom på 21:a plats."],
    ["Vi kom på andra plats.", "Vi kom på 2:a plats."],
    ["Vi fick 1 000 titlar.", "Vi fick 1000 titlar."],
    ["Det var 2,5 grader.", "Det var 2.5 grader."],
  ])("accepts digits and written values interchangeably: %s", (full, candidate) => {
    expect(shorteningPreservesAnchors(full, candidate)).toEqual({ ok: true, missing: [] });
  });

  it("compares unique values instead of counting repeated mentions", () => {
    expect(shorteningPreservesAnchors("Vi fick tre titlar, alltså 3 titlar.", "Vi fick tre titlar.").ok).toBe(true);
  });

  it.each(["Jerry", "Butros"])("protects the sentence-initial name %s", (name) => {
    expect(shorteningPreservesAnchors(`${name} vann tre titlar.`, "Han vann tre titlar.")).toEqual({ ok: false, missing: [`namn:${name}`] });
  });

  it("protects names and places within a sentence", () => {
    expect(shorteningPreservesAnchors("Vi såg Jerry och Butros i Stockholm.", "Vi såg Jerry där.")).toEqual({ ok: false, missing: ["namn:Butros", "namn:Stockholm"] });
  });

  it("accepts ordinary punctuation and case changes around preserved names", () => {
    expect(shorteningPreservesAnchors("Jerry, Butros och Åsa möttes i Stockholm.", "jerry, butros, åsa: Stockholm.")).toEqual({ ok: true, missing: [] });
  });

  it.each(["inte", "aldrig", "ingen", "inget", "inga", "nej", "utan"])("rejects losing negation %s", (negation) => {
    expect(shorteningPreservesAnchors(`Vi sa ${negation} till Jerry.`, "Vi sa till Jerry.")).toEqual({ ok: false, missing: ["negation"] });
  });

  it("allows a shorter equivalent wording that retains all anchors", () => {
    expect(shorteningPreservesAnchors("Det var Jerry som aldrig fick de tre titlarna i Stockholm.", "Jerry fick inte 3 titlar i Stockholm.")).toEqual({ ok: true, missing: [] });
  });

  it("does not treat common Swedish sentence starts as names", () => {
    expect(shorteningPreservesAnchors("Det var väldigt varmt. Sedan blev det kallt.", "Varmt först, kallt sedan.")).toEqual({ ok: true, missing: [] });
  });

  it("reports every missing anchor once", () => {
    expect(shorteningPreservesAnchors("Jerry fick inte tre titlar. Jerry hade 3 mål.", "Han fick titlar.")).toEqual({ ok: false, missing: ["tal:3", "negation", "namn:Jerry"] });
  });
});

describe("English translation fact anchors", () => {
  it("accepts Arabic and Persian digit scripts and equivalent English written quantities", () => {
    expect(translationPreservesFacts("لم يدفع Jerry ١٢٥ دولارا في ۲۰۲۶", "Jerry did not pay 125 dollars in 2026", "ar", "en").ok).toBe(true);
    expect(translationPreservesFacts("ثلاثة وعشرون لقبا", "Twenty-three titles", "ar", "en").ok).toBe(true);
    expect(translationPreservesFacts("١٢٠ دولارا", "One hundred and twenty dollars", "ar", "en").ok).toBe(true);
  });
  it("rejects omitted or invented values, changed polarity and Latin names", () => {
    expect(translationPreservesFacts("Jerry لم يفز بثلاثة ألقاب", "He won two titles", "ar", "en")).toEqual({ ok: false, missing: ["tal:3", "tillagt-tal:2", "negation", "namn:Jerry"] });
  });
  it("protects English facts when shortening for timing", () => {
    expect(shorteningPreservesAnchors("Jerry did not win three titles in 2026.", "Jerry won titles.", "en").missing).toEqual(["tal:2026", "tal:3", "negation"]);
    expect(shorteningPreservesAnchors("Jerry did not win three titles.", "Jerry didn't win 3 titles.", "en").ok).toBe(true);
  });
  it("preserves Swedish negation when auto language detection is used", () => {
    expect(translationPreservesFacts("Jerry vann inte tre titlar", "Jerry did not win three titles", "auto", "en").ok).toBe(true);
  });
  it.each([
    ["Friday", "fredag", "en", "sv"],
    ["Today is Monday.", "Idag är det måndag.", "en", "sv"],
    ["Huset är stort.", "The house is large.", "sv", "en"],
    ["Solen skiner.", "The sun is shining.", "sv", "en"],
    ["God morgon. Jerry kommer klockan tre.", "Good morning. Jerry will arrive at three.", "sv", "en"],
    ["On the other side.", "På andra sidan.", "en", "sv"],
    ["وصل مئة شخص", "One hundred people arrived.", "ar", "en"],
    ["1,000 dollars", "1 000 dollar", "en", "sv"],
    ["وصل مئة وثلاثة وعشرون شخصا", "123 people arrived", "ar", "en"],
    ["وصل ألف وخمسة أشخاص", "1005 people arrived", "ar", "en"],
    ["وصل ثلاثة آلاف شخص", "Three thousand people arrived", "ar", "en"],
  ])("avoids treating ambiguous nouns/ordinals and localized numeric spelling as changed facts: %s", (source, target, sourceLanguage, targetLanguage) => {
    expect(translationPreservesFacts(source, target, sourceLanguage, targetLanguage)).toEqual({ ok: true, missing: [] });
  });
});

it("keeps the source mile unit rather than the different Swedish mil", () => {
  expect(translationPreservesFacts("thousands of miles away", "tusentals mil bort", "en", "sv").missing).toContain("enhet:mile");
  expect(translationPreservesFacts("thousands of miles away", "tusentals engelska mil bort", "en", "sv").ok).toBe(true);
});
