import type { MusicLicense } from "./types";

/** Provider markup is rendered as text only, including in exported attribution. */
export function plainText(value: unknown): string {
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join("; ");
  if (typeof value !== "string") return "";
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[\da-f]+|\d+);/gi, (match, code: string) => {
      const point = code[0].toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number(code);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : match;
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
      const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      return entities[entity.toLowerCase()] ?? match;
    })
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CC_VERSIONS = ["2.0", "2.5", "3.0", "4.0"];
const CC_TYPES = ["by", "by-sa", "by-nc", "by-nc-sa", "by-nd", "by-nc-nd"];
const LICENSES = new Set([
  ...CC_TYPES.flatMap((type) => CC_VERSIONS.map((version) => `/licenses/${type}/${version}/`)),
  ...["by", "by-sa", "by-nc", "by-nc-sa", "by-nd"].map((type) => `/licenses/${type}/1.0/`),
  "/publicdomain/zero/1.0/",
  "/publicdomain/mark/1.0/",
]);

/** Do not infer permission from words such as 'free' or an arbitrary URL containing 'creativecommons'. */
export function canonicalLicenseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 500) return undefined;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)
      || !["creativecommons.org", "www.creativecommons.org"].includes(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash) return undefined;
    // Known CC deed/legalcode suffixes are equivalent to the license's canonical URL.
    const path = url.pathname.replace(/\/(?:deed\.(?:en|sv)|legalcode)\/?$/, "/");
    const normalized = path.endsWith("/") ? path : `${path}/`;
    return LICENSES.has(normalized) ? `https://creativecommons.org${normalized}` : undefined;
  } catch {
    return undefined;
  }
}

export function classifyLicense(
  values: unknown,
  attribution: string,
  displayName?: string,
): MusicLicense {
  const candidates = Array.isArray(values) ? values : [values];
  const url = candidates.map(canonicalLicenseUrl).find(Boolean);
  if (!url) {
    return {
      name: plainText(displayName) || "Licens saknas eller stöds inte",
      downloadAllowed: false,
      conversionAllowed: false,
      attribution: attribution || undefined,
      reason: "Ingen uttrycklig nedladdningsrätt med en stödd licens har kunnat verifieras. Öppna originalkällan för mer information.",
    };
  }
  const type = url.match(/\/licenses\/([^/]+)\/([^/]+)/);
  const publicDomain = url.includes("/publicdomain/");
  const isNd = type?.[1].includes("nd") ?? false;
  const isNc = type?.[1].includes("nc") ?? false;
  const shareAlike = type?.[1].includes("sa") ?? false;
  const name = type
    ? `CC ${type[1].toUpperCase()} ${type[2]}`
    : url.includes("/zero/") ? "CC0 1.0" : "Public Domain Mark 1.0";
  const conditions = [
    publicDomain ? "Källan anger att filen är fri från upphovsrättsliga begränsningar." : "Ange upphovsperson, originalkälla och licens vid vidare användning.",
    isNc ? "Endast icke-kommersiell användning." : "",
    shareAlike ? "Bearbetningar som delas måste använda samma licensvillkor." : "",
    isNd ? "Originalfilen får delas oförändrad. Appen konverterar inte denna licens." : "",
  ].filter(Boolean).join(" ");
  return {
    name,
    url,
    downloadAllowed: true,
    conversionAllowed: !isNd,
    attribution: attribution || undefined,
    reason: conditions,
  };
}

/** Source access restrictions always override a permissive license. */
export function restrictedLicense(license: MusicLicense, reason: string): MusicLicense {
  return { ...license, downloadAllowed: false, conversionAllowed: false, reason };
}

export function isRestrictedFlag(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isRestrictedFlag);
  return value === true || value === 1 || (typeof value === "string" && ["true", "1", "yes", "restricted", "private"].includes(value.trim().toLowerCase()));
}
