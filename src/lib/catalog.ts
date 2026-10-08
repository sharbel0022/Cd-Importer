import { AppError } from "./errors";
import { classifyLicense, isRestrictedFlag, plainText, restrictedLicense } from "./licenses";
import { providerJson } from "./provider-http";
import type { MusicSource, SearchResponse, Track, TrackRef } from "./types";

type Data = Record<string, unknown>;
export interface ResolvedTrack { track: Track; url: string }
interface SourceSearch { tracks: Track[]; warnings: string[]; hasMore: boolean }

const ARCHIVE_ITEMS_PER_PAGE = 8;
const ARCHIVE_TRACKS_PER_ITEM = 50;
const COMMONS_ITEMS_PER_PAGE = 12;
const AUDIO_EXTENSIONS = new Set(["mp3", "ogg", "oga", "opus", "wav", "flac", "m4a", "aac", "aiff", "aif"]);

function object(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return plainText(value); }
function number(value: unknown): number | undefined {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return number(value);
  if (typeof value !== "string") return undefined;
  const input = value.trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(input)) return undefined;
  const parts = input.split(":").map(Number);
  if (parts.length > 1 && parts.slice(1).some((part) => part >= 60)) return undefined;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Never allow a client-supplied path to escape the item's directory. */
export function validArchiveFile(name: string): boolean {
  return name.length > 0 && name.length <= 1024 && !/[\u0000-\u001f\u007f\\]/.test(name)
    && name.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function extension(name: string): string { return name.split(".").pop()?.toLowerCase() ?? ""; }
function isMp3(track: Pick<Track, "format">): boolean { return track.format === "MP3"; }
function fileStem(name: string): string {
  return name.split("/").pop()!.replace(/\.[^.]+$/, "").replace(/(?:_vbr|_64kb|_128kb|_192kb|_320kb)$/i, "").replace(/_/g, " ");
}

function archiveUrl(id: string, file: string): string {
  return `https://archive.org/download/${encodeURIComponent(id)}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

function archiveRestricted(item: Data, metadata: Data): boolean {
  return [item, metadata].some((data) => ["access-restricted-item", "is_dark", "nodownload", "no-download"].some((key) => isRestrictedFlag(data[key])));
}
function privateFile(file: Data): boolean {
  return ["private", "is_private", "restricted", "deleted", "filehidden", "nodownload", "access-restricted-item", "is_dark"].some((key) => isRestrictedFlag(file[key]));
}

function audioArchiveFile(file: Data): boolean {
  const name = typeof file.name === "string" ? file.name : "";
  const format = text(file.format);
  return validArchiveFile(name) && AUDIO_EXTENSIONS.has(extension(name))
    && (!format || /(?:mp3|mpeg.?audio|ogg|vorbis|opus|wave|wav|flac|apple lossless|mpeg4 audio|m4a|aac|aiff)/i.test(format));
}

function archiveLineage(file: Data, byName: Map<string, Data>): Data[] {
  const seen = new Set<Data>();
  const lineage: Data[] = [];
  let current = file;
  while (!seen.has(current)) {
    seen.add(current);
    lineage.push(current);
    if (typeof current.original !== "string" || !byName.has(current.original)) break;
    current = byName.get(current.original)!;
  }
  return lineage;
}

function archiveOriginal(file: Data, byName: Map<string, Data>): Data {
  return archiveLineage(file, byName).at(-1)!;
}

function sourceAttribution(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n");
}

/** Keep one actual audio file per original recording, preferring an existing MP3 derivative. */
export function parseArchiveItem(id: string, value: unknown, selectedFile?: string): ResolvedTrack[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)) throw new AppError("Ogiltigt Internet Archive-id.", 400);
  const item = object(value);
  const metadata = object(item.metadata);
  if (item.error || !Object.keys(metadata).length) throw new AppError("Objektet finns inte längre eller saknar tillgänglig metadata.", 404);
  if (!["audio", "etree"].includes(text(metadata.mediatype))) return [];
  const files = list(item.files).map(object).filter(audioArchiveFile);
  const allFiles = new Map(list(item.files).map(object).filter((file) => typeof file.name === "string").map((file) => [file.name as string, file]));
  const sourceUrl = `https://archive.org/details/${encodeURIComponent(id)}`;
  const groups = new Map<string, Data[]>();
  for (const file of files) {
    const original = archiveOriginal(file, allFiles);
    // The 'original' field is authoritative even when the original is no longer listed.
    const key = typeof original.original === "string" && !allFiles.has(original.original)
      ? original.original : String(original.name);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const itemBlocked = archiveRestricted(item, metadata);
  return [...groups.values()].flatMap((variants) => {
    const rank = (file: Data) => (extension(String(file.name)) === "mp3" ? 0 : file.source === "original" ? 1 : 2) + (privateFile(file) ? 10 : 0);
    const file = selectedFile ? variants.find((candidate) => candidate.name === selectedFile) : [...variants].sort((a, b) => rank(a) - rank(b))[0];
    if (!file) return [];
    const lineage = archiveLineage(file, allFiles);
    const original = lineage.at(-1)!;
    const fileName = String(file.name);
    const artist = text(file.artist) || text(original.artist) || text(file.creator) || text(original.creator) || text(metadata.creator) || "Okänd artist";
    const title = text(file.title) || text(original.title) || (groups.size === 1 ? text(metadata.title) : "") || fileStem(fileName);
    const album = text(file.album) || text(original.album) || text(metadata.album) || (groups.size > 1 ? text(metadata.title) : "");
    const attribution = sourceAttribution([
      `${artist} – ${title}`,
      album ? `Album: ${album}` : "",
      text(metadata.credit) ? `Källans erkännande: ${text(metadata.credit)}` : "",
      text(metadata.rights) ? `Källans rättighetsinformation: ${text(metadata.rights)}` : "",
      `Originalkälla: ${sourceUrl}`,
    ]);
    // File-level licensing, when present, overrides the item's license rather than silently falling back.
    const fileLicense = lineage.find((ancestor) => ancestor.licenseurl !== undefined);
    const licenseValues = fileLicense ? fileLicense.licenseurl : metadata.licenseurl;
    let license = classifyLicense(licenseValues, attribution);
    if (itemBlocked || lineage.some(privateFile)) {
      license = restrictedLicense(license, "Källan har begränsat tillgången eller nedladdningen för detta objekt eller denna fil.");
    }
    if (license.url) license.attribution = `${attribution}\nLicens: ${license.name} (${license.url})`;
    const format = extension(fileName).toUpperCase();
    const track: Track = {
      source: "archive", id, file: fileName,
      key: `archive:${id}:${fileName}`, title, artist,
      ...(album ? { album } : {}),
      artworkUrl: `https://archive.org/services/img/${encodeURIComponent(id)}`,
      duration: parseDuration(file.length) ?? parseDuration(original.length) ?? parseDuration(file.duration) ?? parseDuration(original.duration),
      format, sourceUrl, license,
      playbackAllowed: license.downloadAllowed,
      downloadAllowed: license.downloadAllowed && (format === "MP3" || license.conversionAllowed),
      size: number(file.size),
    };
    return [{ track, url: archiveUrl(id, fileName) }];
  });
}

function extValue(metadata: Data, key: string): string { return text(object(metadata[key]).value); }
function commonsFileUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    // The current official API adds these tracking parameters. They are never needed to fetch the file.
    for (const key of ["utm_source", "utm_campaign", "utm_content"]) url.searchParams.delete(key);
    return url.protocol === "https:" && url.hostname === "upload.wikimedia.org" && !url.username && !url.password
      && !url.port && !url.hash && !url.search && url.pathname.startsWith("/wikipedia/commons/")
      ? url.href : undefined;
  } catch { return undefined; }
}

export function parseCommonsPage(value: unknown): ResolvedTrack | undefined {
  const page = object(value);
  const info = object(list(page.imageinfo)[0]);
  const id = typeof page.title === "string" ? page.title : "";
  const url = commonsFileUrl(info.url);
  // Commons exposes many Ogg audio files as application/ogg; AUDIO prevents accepting an Ogg video.
  const audioMime = text(info.mime).startsWith("audio/") || (text(info.mime) === "application/ogg" && ["ogg", "oga", "opus"].includes(extension(id)));
  if (page.missing || page.invalid || page.ns !== 6 || !id.startsWith("File:") || !url || text(info.mediatype) !== "AUDIO" || !audioMime) return undefined;
  const fileName = id.slice(5);
  if (!AUDIO_EXTENSIONS.has(extension(fileName))) return undefined;
  const ext = object(info.extmetadata);
  const title = extValue(ext, "ObjectName") || fileStem(fileName);
  const artist = extValue(ext, "Artist") || "Okänd artist";
  const sourceUrl = `https://commons.wikimedia.org/wiki/${encodeURIComponent(id.replace(/ /g, "_"))}`;
  const credit = extValue(ext, "Credit");
  const attribution = sourceAttribution([
    `${artist} – ${title}`,
    credit ? `Källans erkännande: ${credit}` : "",
    extValue(ext, "Attribution") ? `Källans attribution: ${extValue(ext, "Attribution")}` : "",
    extValue(ext, "UsageTerms") ? `Källans användningsvillkor: ${extValue(ext, "UsageTerms")}` : "",
    `Originalkälla: ${sourceUrl}`,
  ]);
  let license = classifyLicense(extValue(ext, "LicenseUrl"), attribution, extValue(ext, "LicenseShortName"));
  const restrictions = extValue(ext, "Restrictions");
  // Additional restrictions require a manual visit to the source; do not silently discard them.
  if (restrictions || Object.hasOwn(info, "filehidden") || Object.hasOwn(page, "suppressed")) {
    license = restrictedLicense(license, restrictions ? `Källan anger ytterligare begränsningar: ${restrictions}. Öppna originalkällan.` : "Källan har dolt eller begränsat filen.");
  }
  if (license.url) license.attribution = `${attribution}\nLicens: ${license.name} (${license.url})`;
  const commonMetadata = [...list(info.commonmetadata), ...list(info.metadata)].map(object);
  const durationValue = commonMetadata.find((entry) => /^(?:playtime_seconds|length|duration)$/i.test(text(entry.name)))?.value;
  const format = extension(fileName).toUpperCase();
  const track: Track = {
    source: "commons", id, key: `commons:${id}`, title, artist, format, sourceUrl, license,
    duration: parseDuration(durationValue),
    playbackAllowed: license.downloadAllowed,
    downloadAllowed: license.downloadAllowed && (format === "MP3" || license.conversionAllowed),
    size: number(info.size),
  };
  return { track, url };
}

/** Each input word is a literal term; Lucene operators cannot alter the access/license clauses. */
export function archiveSearchQuery(query: string, licensedOnly: boolean): string {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const escape = (term: string) => term.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, "\\$&");
  // Search creator/title rather than descriptions, where podcasts often credit background music.
  const literal = words.map((word) => `(title:"${escape(word)}" OR creator:"${escape(word)}")`).join(" AND ");
  return `mediatype:(audio OR etree) AND (${literal})${licensedOnly ? " AND licenseurl:*" : ""}`;
}

async function archiveMetadata(id: string): Promise<unknown> {
  return providerJson(new URL(`https://archive.org/metadata/${encodeURIComponent(id)}`));
}

async function mapConcurrent<T, U>(values: T[], callback: (value: T) => Promise<U>, concurrency: number): Promise<PromiseSettledResult<U>[]> {
  const results = new Array<PromiseSettledResult<U>>(values.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const current = index++;
      try { results[current] = { status: "fulfilled", value: await callback(values[current]) }; }
      catch (reason) { results[current] = { status: "rejected", reason }; }
    }
  }));
  return results;
}

async function searchArchive(query: string, page: number, licensedOnly: boolean): Promise<SourceSearch> {
  const url = new URL("https://archive.org/advancedsearch.php");
  url.search = new URLSearchParams({ q: archiveSearchQuery(query, licensedOnly), "fl[]": "identifier", rows: String(ARCHIVE_ITEMS_PER_PAGE), page: String(page), output: "json" }).toString();
  const data = object(await providerJson(url));
  if (data.error) throw new AppError("Internet Archives sökning kunde inte genomföras.", 502);
  const response = object(data.response);
  if (!Array.isArray(response.docs) || number(response.numFound) === undefined) throw new AppError("Internet Archive returnerade ett ofullständigt söksvar.", 502);
  const ids = [...new Set(list(response.docs).map(object).map((doc) => doc.identifier).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)))];
  const items = await mapConcurrent(ids, async (id) => parseArchiveItem(id, await archiveMetadata(id)), 3);
  const warnings: string[] = [];
  const tracks = items.flatMap((item, index) => {
    if (item.status !== "fulfilled") return [];
    const eligible = item.value.map((resolved) => resolved.track).filter((track) => !licensedOnly || track.downloadAllowed);
    if (eligible.length > ARCHIVE_TRACKS_PER_ITEM) warnings.push(`Objektet ${ids[index]} innehåller fler än ${ARCHIVE_TRACKS_PER_ITEM} ljudspår. Appen visar ett urval; fler filer finns via knappen Originalkälla.`);
    return eligible.slice(0, ARCHIVE_TRACKS_PER_ITEM);
  });
  const failed = items.filter((item) => item.status === "rejected").length;
  if (failed) warnings.push(`${failed} objekt från Internet Archive kunde inte kontrolleras. Övriga resultat visas.`);
  return {
    tracks,
    warnings,
    // IA pagination counts source items (e.g. albums), not the individual files they contain.
    hasMore: page * ARCHIVE_ITEMS_PER_PAGE < Number(response.numFound),
  };
}

function commonsApi(params: Record<string, string>): URL {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.search = new URLSearchParams({ action: "query", format: "json", formatversion: "2", maxlag: "5", ...params }).toString();
  return url;
}

const COMMONS_INFO = { prop: "imageinfo", iiprop: "url|size|mime|mediatype|commonmetadata|extmetadata", iiextmetadatalanguage: "en", iilimit: "1" };

function checkedCommons(value: unknown): Data {
  const data = object(value);
  if (data.error) {
    const code = text(object(data.error).code);
    throw new AppError(code === "maxlag" || code === "ratelimited" ? "Wikimedia Commons är tillfälligt upptagen. Försök igen senare." : "Wikimedia Commons kunde inte genomföra sökningen.", code === "maxlag" || code === "ratelimited" ? 503 : 502);
  }
  return data;
}

async function searchCommons(query: string, page: number, licensedOnly: boolean): Promise<SourceSearch> {
  // Quote each term to prevent user input from injecting CirrusSearch operators.
  const literal = query.trim().split(/\s+/).filter(Boolean).map((word) => `"${word.replace(/["\\]/g, " ")}"`).join(" ");
  const data = checkedCommons(await providerJson(commonsApi({
    list: "search", srsearch: `${literal} filetype:audio`, srnamespace: "6", srlimit: String(COMMONS_ITEMS_PER_PAGE),
    sroffset: String((page - 1) * COMMONS_ITEMS_PER_PAGE), srprop: "", srinfo: "totalhits",
  })));
  const search = object(data.query);
  if (!Array.isArray(search.search)) throw new AppError("Wikimedia Commons returnerade ett ofullständigt söksvar.", 502);
  const titles = list(search.search).map(object).map((entry) => entry.title).filter((title): title is string => typeof title === "string" && title.startsWith("File:"));
  // extmetadata is expensive: ask for only three files at a time, with two requests in flight.
  const batches = Array.from({ length: Math.ceil(titles.length / 3) }, (_, index) => titles.slice(index * 3, index * 3 + 3));
  const results = await mapConcurrent(batches, async (batch) => {
    const metadata = checkedCommons(await providerJson(commonsApi({ ...COMMONS_INFO, titles: batch.join("|") })));
    return list(object(metadata.query).pages).map(parseCommonsPage).filter((item): item is ResolvedTrack => Boolean(item)).map((item) => item.track);
  }, 2);
  const tracks = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const failed = results.filter((result) => result.status === "rejected").length;
  const continuation = object(data.continue);
  return {
    tracks: licensedOnly ? tracks.filter((track) => track.downloadAllowed) : tracks,
    warnings: failed ? ["Vissa filer från Wikimedia Commons kunde inte kontrolleras. Övriga resultat visas."] : [],
    hasMore: typeof continuation.sroffset === "number",
  };
}

export async function searchMusic(query: string, source: "all" | MusicSource, page: number, licensedOnly: boolean): Promise<SearchResponse> {
  if (!query.trim() || query.length > 160 || !Number.isInteger(page) || page < 1 || page > 100 || !["all", "archive", "commons"].includes(source)) {
    throw new AppError("Ogiltiga sökparametrar.", 400);
  }
  const sources: MusicSource[] = source === "all" ? ["archive", "commons"] : [source];
  const results = await Promise.allSettled(sources.map((provider) => provider === "archive" ? searchArchive(query, page, licensedOnly) : searchCommons(query, page, licensedOnly)));
  const successful = results.filter((result): result is PromiseFulfilledResult<SourceSearch> => result.status === "fulfilled");
  if (!successful.length) {
    const first = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    throw first.reason;
  }
  const warnings = results.flatMap((result, index) => result.status === "fulfilled" ? result.value.warnings : [`${sources[index] === "archive" ? "Internet Archive" : "Wikimedia Commons"}: ${result.reason instanceof AppError ? result.reason.message : "Källan kunde inte nås."}`]);
  const tracks = successful.flatMap((result) => result.value.tracks);
  // Put playable MP3 files first while keeping the providers' own relevance order within each group.
  tracks.sort((a, b) => Number(b.downloadAllowed && isMp3(b)) - Number(a.downloadAllowed && isMp3(a)));
  return { tracks, warnings, page, hasMore: successful.some((result) => result.value.hasMore) };
}

/** Re-read authoritative provider metadata every time; browser booleans and URLs are never trusted. */
export async function resolveTrack(ref: TrackRef): Promise<ResolvedTrack> {
  if (ref.source === "archive") {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(ref.id) || typeof ref.file !== "string" || !validArchiveFile(ref.file)) throw new AppError("Ogiltig referens till en ljudfil.", 400);
    const value = await archiveMetadata(ref.id);
    // Resolve the exact selected variant, even if later metadata changes which variant search would prefer.
    const preserved = parseArchiveItem(ref.id, value, ref.file)[0];
    if (!preserved) throw new AppError("Den valda ljudfilen kunde inte verifieras.", 404);
    return preserved;
  }
  if (ref.source === "commons") {
    if (!ref.id.startsWith("File:") || ref.id.length > 300 || /[|\u0000-\u001f\u007f]/.test(ref.id) || ref.file !== undefined) throw new AppError("Ogiltig referens till Wikimedia Commons.", 400);
    const data = checkedCommons(await providerJson(commonsApi({ ...COMMONS_INFO, titles: ref.id })));
    const page = list(object(data.query).pages)[0];
    const resolved = parseCommonsPage(page);
    if (!resolved) throw new AppError("Ljudfilen finns inte längre eller saknar verifierbara uppgifter hos Wikimedia Commons.", 404);
    return resolved;
  }
  throw new AppError("Musikkällan stöds inte.", 400);
}
