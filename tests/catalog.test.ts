import { beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSearchQuery, parseArchiveItem, parseCommonsPage, parseDuration, resolveTrack, searchMusic, validArchiveFile } from "../src/lib/catalog";
import { providerJson } from "../src/lib/provider-http";

vi.mock("../src/lib/provider-http", () => ({ providerJson: vi.fn() }));
const provider = vi.mocked(providerJson);

function archiveItem() {
  return {
    metadata: { mediatype: "audio", title: "An album", creator: "Test Artist", licenseurl: "https://creativecommons.org/licenses/by/4.0/", rights: "Credit original musicians" },
    files: [
      { name: "01 Song.flac", title: "Song One", length: "00:03:20.25", format: "Flac", source: "original", size: "123456" },
      { name: "01 Song.mp3", original: "01 Song.flac", format: "VBR MP3", source: "derivative", size: "4000" },
      { name: "01 Song_64kb.mp3", original: "01 Song.mp3", format: "64Kbps MP3", source: "derivative", size: "2000" },
      { name: "02 Track.mp3", format: "VBR MP3", source: "original", length: "1:05", size: "3000" },
      { name: "cover.jpg", format: "JPEG", source: "original" },
      { name: "album_meta.xml", format: "Metadata" },
    ],
  };
}

function commonsPage() {
  return {
    ns: 6, title: "File:Test song.ogg",
    imageinfo: [{
      url: "https://upload.wikimedia.org/wikipedia/commons/a/a1/Test_song.ogg", size: 1234, mime: "audio/ogg", mediatype: "AUDIO",
      commonmetadata: [{ name: "length", value: 91.5 }],
      extmetadata: {
        ObjectName: { value: "Test song" }, Artist: { value: '<a href="https://example.com">Test Artist</a>' },
        Credit: { value: 'Recorded by <a href="https://example.com">Other artist</a>' },
        Attribution: { value: "Composer and orchestra" }, UsageTerms: { value: "Creative Commons Attribution-Share Alike" },
        LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" }, LicenseShortName: { value: "CC BY-SA 4.0" },
      },
    }],
  };
}

beforeEach(() => { provider.mockReset(); });

describe("Internet Archive recordings", () => {
  it("deduplicates multiple derived MP3 files per original and inherits its title and length", () => {
    const tracks = parseArchiveItem("test-album", archiveItem());
    expect(tracks).toHaveLength(2);
    expect(tracks[0].track).toMatchObject({ file: "01 Song.mp3", title: "Song One", album: "An album", artist: "Test Artist", duration: 200.25, format: "MP3", playbackAllowed: true, downloadAllowed: true });
    expect(tracks[0].url).toBe("https://archive.org/download/test-album/01%20Song.mp3");
    expect(tracks[1].track.title).toBe("02 Track");
    expect(tracks[0].track.license.attribution).toContain("Credit original musicians");
    expect(tracks[0].track.license.attribution).toContain("https://archive.org/details/test-album");
  });

  it.each(["access-restricted-item", "is_dark", "nodownload"])("does not let a permissive license bypass item restriction %s", (key) => {
    const item = archiveItem();
    Object.assign(item.metadata, { [key]: "true" });
    expect(parseArchiveItem("test-album", item).every(({ track }) => !track.playbackAllowed && !track.downloadAllowed)).toBe(true);
  });

  it("blocks derivatives of a private original recording", () => {
    const item = archiveItem();
    Object.assign(item.files[0], { private: "true" });
    expect(parseArchiveItem("test-album", item)[0].track).toMatchObject({ playbackAllowed: false, downloadAllowed: false });
  });

  it("does not bypass a restriction in an intermediate derivative's provenance", () => {
    const item = archiveItem();
    Object.assign(item.files[1], { private: true });
    const resolved = parseArchiveItem("test-album", item)[0];
    expect(resolved.track.file).toBe("01 Song_64kb.mp3");
    expect(resolved.track.downloadAllowed).toBe(false);
  });

  it("uses file-level licensing even when the album has broader rights", () => {
    const item = archiveItem();
    Object.assign(item.files[1], { licenseurl: "https://example.com/all-rights-reserved" });
    expect(parseArchiveItem("test-album", item)[0].track.downloadAllowed).toBe(false);
  });

  it("allows unchanged ND MP3 files while blocking conversion of an ND FLAC", () => {
    const item = archiveItem();
    item.metadata.licenseurl = "https://creativecommons.org/licenses/by-nd/4.0/";
    expect(parseArchiveItem("test-album", item)[0].track).toMatchObject({ playbackAllowed: true, downloadAllowed: true, license: { conversionAllowed: false } });
    item.files = [item.files[0]];
    expect(parseArchiveItem("test-album", item)[0].track).toMatchObject({ playbackAllowed: true, downloadAllowed: false });
  });

  it("rechecks exact file, license and restrictions without trusting stored browser data", async () => {
    const first = archiveItem();
    const second = archiveItem();
    Object.assign(second.metadata, { nodownload: true });
    provider.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const ref = { source: "archive" as const, id: "test-album", file: "01 Song_64kb.mp3" };
    const allowed = await resolveTrack(ref);
    const blocked = await resolveTrack(ref);
    expect(allowed.track).toMatchObject({ file: "01 Song_64kb.mp3", title: "Song One", album: "An album", downloadAllowed: true });
    expect(blocked.track.downloadAllowed).toBe(false);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("does not retrieve a file removed from the provider metadata", async () => {
    provider.mockResolvedValueOnce(archiveItem());
    await expect(resolveTrack({ source: "archive", id: "test-album", file: "missing.mp3" })).rejects.toThrow("kunde inte verifieras");
  });
});

describe("Wikimedia Commons audio", () => {
  it("preserves full available credit, source and license while ignoring HTML formatting", () => {
    const resolved = parseCommonsPage(commonsPage())!;
    expect(resolved.track).toMatchObject({ source: "commons", title: "Test song", artist: "Test Artist", duration: 91.5, format: "OGG", playbackAllowed: true, downloadAllowed: true });
    expect(resolved.track.license.attribution).toContain("Recorded by Other artist");
    expect(resolved.track.license.attribution).toContain("Composer and orchestra");
    expect(resolved.track.license.attribution).toContain("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(resolved.track.license.attribution).not.toContain("<a");
  });

  it("strips the official Commons tracking parameters but rejects arbitrary query parameters", () => {
    const page = commonsPage();
    page.imageinfo[0].url += "?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original";
    expect(parseCommonsPage(page)?.url).toBe("https://upload.wikimedia.org/wikipedia/commons/a/a1/Test_song.ogg");
    page.imageinfo[0].url += "&redirect=https://attacker.example";
    expect(parseCommonsPage(page)).toBeUndefined();
  });

  it("does not infer download rights from the provider name or descriptive text", () => {
    const page = commonsPage();
    page.imageinfo[0].extmetadata.LicenseUrl.value = "";
    expect(parseCommonsPage(page)?.track).toMatchObject({ playbackAllowed: false, downloadAllowed: false });
  });

  it("fails closed on provider-stated additional restrictions", () => {
    const page = commonsPage();
    Object.assign(page.imageinfo[0].extmetadata, { Restrictions: { value: "Personality rights" } });
    expect(parseCommonsPage(page)?.track.downloadAllowed).toBe(false);
  });

  it.each(["https://upload.wikimedia.org.attacker.example/a.mp3", "http://upload.wikimedia.org/wikipedia/commons/a.mp3", "https://127.0.0.1/a.mp3", "https://upload.wikimedia.org/other/a.mp3"])("rejects unexpected media URL %s", (url) => {
    const page = commonsPage();
    page.imageinfo[0].url = url;
    expect(parseCommonsPage(page)).toBeUndefined();
  });

  it("only includes verified audio, excluding video", () => {
    const page = commonsPage();
    page.imageinfo[0].mediatype = "VIDEO";
    expect(parseCommonsPage(page)).toBeUndefined();
  });

  it("accepts the real Commons application/ogg MIME only with AUDIO media type", () => {
    const page = commonsPage();
    page.imageinfo[0].mime = "application/ogg";
    expect(parseCommonsPage(page)?.track.downloadAllowed).toBe(true);
    page.imageinfo[0].mediatype = "VIDEO";
    expect(parseCommonsPage(page)).toBeUndefined();
  });
});

describe("search behavior and trust boundaries", () => {
  it("escapes query operators rather than permitting advanced-search injection", () => {
    expect(archiveSearchQuery("artist OR mediatype:movies", true)).toBe('mediatype:(audio OR etree) AND ((title:"artist" OR creator:"artist") AND (title:"OR" OR creator:"OR") AND (title:"mediatype\\:movies" OR creator:"mediatype\\:movies")) AND licenseurl:*');
    expect(archiveSearchQuery('title" ) *:*', false)).toContain('"title\\\""');
  });

  it("returns surviving items with an explicit warning when a metadata request fails", async () => {
    provider.mockImplementation(async (url) => {
      if (url.pathname === "/advancedsearch.php") return { response: { numFound: 20, docs: [{ identifier: "good" }, { identifier: "failed" }] } };
      if (url.pathname === "/metadata/good") return archiveItem();
      throw new Error("network unavailable");
    });
    const results = await searchMusic("test artist", "archive", 1, true);
    expect(results.tracks).toHaveLength(2);
    expect(results.warnings[0]).toContain("1 objekt");
    expect(results.hasMore).toBe(true);
  });

  it("returns the working source when another source fails", async () => {
    provider.mockImplementation(async (url) => {
      if (url.hostname === "commons.wikimedia.org") throw new Error("network unavailable");
      if (url.pathname === "/advancedsearch.php") return { response: { numFound: 1, docs: [{ identifier: "good" }] } };
      return archiveItem();
    });
    expect(await searchMusic("test", "all", 1, false)).toMatchObject({ tracks: expect.any(Array), warnings: [expect.stringContaining("Wikimedia Commons")], hasMore: false });
  });

  it.each(["../secret.mp3", "/absolute.mp3", "folder/../secret.mp3", "folder\\secret.mp3", "secret\u0000.mp3"])("rejects unsafe Archive filename %s", (name) => {
    expect(validArchiveFile(name)).toBe(false);
  });

  it("parses times without treating invalid times as known durations", () => {
    expect(parseDuration("1:02:03.5")).toBe(3723.5);
    expect(parseDuration("3:61")).toBeUndefined();
    expect(parseDuration("not known")).toBeUndefined();
  });
});
