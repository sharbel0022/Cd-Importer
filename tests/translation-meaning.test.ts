import { describe, expect, it } from "vitest";
import { shorteningPreservesAnchors } from "@/lib/translation/meaning";

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
