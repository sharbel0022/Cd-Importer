import { describe, expect, it } from "vitest";
import { canonicalLicenseUrl, classifyLicense, isRestrictedFlag, plainText, restrictedLicense } from "../src/lib/licenses";

describe("authoritative license URLs", () => {
  it("recognizes canonical CC licenses and explicitly supported deed URLs", () => {
    expect(canonicalLicenseUrl("http://creativecommons.org/licenses/by-sa/4.0/")).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(canonicalLicenseUrl("https://creativecommons.org/licenses/by/3.0/deed.sv")).toBe("https://creativecommons.org/licenses/by/3.0/");
    expect(classifyLicense("https://creativecommons.org/publicdomain/zero/1.0/", "credit")).toMatchObject({ downloadAllowed: true, conversionAllowed: true, name: "CC0 1.0", attribution: "credit" });
    expect(classifyLicense("https://creativecommons.org/publicdomain/mark/1.0/", "credit").downloadAllowed).toBe(true);
  });

  it.each([
    "Creative Commons", "Public domain", undefined,
    "https://creativecommons.org.attacker.example/licenses/by/4.0/",
    "https://example.com/?license=https://creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org@attacker.example/licenses/by/4.0/",
    "https://user@creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org:444/licenses/by/4.0/",
    "https://creativecommons.org/licenses/by/9.9/",
    "https://creativecommons.org/licenses/by/4.0/?permission=no",
    "https://creativecommons.org/licenses/by/4.0/#not-a-license",
    "https://creativecommons.org/licenses/by-nc-nd/1.0/",
  ])("does not authorize music using an unverified or deceptive license: %s", (url) => {
    expect(classifyLicense(url, "credit")).toMatchObject({ downloadAllowed: false, conversionAllowed: false });
  });

  it("preserves NC, SA and ND conditions separately from access to the original file", () => {
    const license = classifyLicense("https://creativecommons.org/licenses/by-nc-nd/4.0/", "Full artist and source credit");
    expect(license).toMatchObject({ downloadAllowed: true, conversionAllowed: false });
    expect(license.reason).toContain("icke-kommersiell");
    expect(license.reason).toContain("oförändrad");
    expect(classifyLicense("https://creativecommons.org/licenses/by-sa/4.0/", "credit").reason).toContain("samma licensvillkor");
  });

  it("source restrictions override both download and conversion permission", () => {
    const license = classifyLicense("https://creativecommons.org/licenses/by/4.0/", "credit");
    expect(restrictedLicense(license, "Privat fil")).toMatchObject({ downloadAllowed: false, conversionAllowed: false, reason: "Privat fil", attribution: "credit" });
    expect(isRestrictedFlag("TRUE")).toBe(true);
    expect(isRestrictedFlag("false")).toBe(false);
    expect(isRestrictedFlag(["false", "1"])).toBe(true);
  });

  it("retains attribution as safe readable text", () => {
    expect(plainText('<a href="https://example.com">Artist &amp; Band</a><script>stolen()</script>')).toBe("Artist & Band");
    expect(plainText("&#x1F3B5; &quot;Titel&quot; &#229;")).toBe('🎵 "Titel" å');
  });
});
