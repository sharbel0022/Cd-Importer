import { describe, expect, it } from "vitest";
import { attributionHeader, contentDisposition, isRealMp3, safeFilename } from "../src/lib/media";
import type { Track } from "../src/lib/types";

function mp3Frames(): Buffer {
  // MPEG-1 Layer III, 128kbps, 44.1kHz, two complete 417-byte frames.
  const bytes = Buffer.alloc(834);
  bytes.set([0xff, 0xfb, 0x90, 0x00], 0);
  bytes.set([0xff, 0xfb, 0x90, 0x00], 417);
  return bytes;
}

describe("MP3 file verification", () => {
  it("requires complete consecutive Layer III frames", () => { expect(isRealMp3(mp3Frames())).toBe(true); });
  it("accepts an ID3 tag followed by real frames", () => {
    const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 3, 0, 0, 0]);
    expect(isRealMp3(Buffer.concat([id3, mp3Frames()]))).toBe(true);
  });
  it("rejects renamed WAV, HTML, playlists and isolated ID3 headers", () => {
    for (const data of ["RIFF....WAVEfmt ", "<html>404</html>", "#EXTM3U\nhttps://example.com/audio", "ID3\0\0\0\0\0\0\0"]) expect(isRealMp3(Buffer.from(data))).toBe(false);
  });
  it("rejects malformed and truncated frames", () => {
    expect(isRealMp3(mp3Frames().subarray(0, 800))).toBe(false);
    const malformed = mp3Frames(); malformed[2] = 0xf0;
    expect(isRealMp3(malformed)).toBe(false);
  });
});

describe("download filenames", () => {
  it("preserves readable Swedish artist and title", () => { expect(safeFilename("Åsa", "Vår låt")).toBe("Åsa - Vår låt.mp3"); });
  it("removes traversal, control characters and Windows filename hazards", () => {
    const filename = safeFilename("../CON", 'Låt:\\test?\r\n.mp3');
    expect(filename).not.toMatch(/[\r\n/\\:*?<>|]/);
    expect(safeFilename(undefined, "CON")).toBe("_CON.mp3");
    expect(safeFilename(undefined, undefined)).toBe("Ljudfil.mp3");
  });
  it("provides RFC5987 UTF-8 attachment names without header injection", () => {
    const header = contentDisposition(safeFilename("Åsa", "Vår låt"));
    expect(header).toContain("filename*=UTF-8''%C3%85sa%20-%20V%C3%A5r%20l%C3%A5t.mp3");
    expect(header).not.toMatch(/[\r\n]/);
  });
  it("never splits an emoji or leaves invalid Unicode in an attachment name", () => {
    expect(() => contentDisposition(safeFilename("a" + "🎵".repeat(70), "song"))).not.toThrow();
    expect(() => contentDisposition(safeFilename("\ud800", "song"))).not.toThrow();
  });
  it("caps large Unicode credit headers while keeping a lookup reference", () => {
    const track = { source: "archive", id: "example", file: "音".repeat(496) + ".mp3", title: "Song", artist: "Artist", sourceUrl: "https://archive.org/details/example",
      license: { name: "CC BY 4.0", attribution: "音".repeat(20_000), url: "https://creativecommons.org/licenses/by/4.0/" } } as Track;
    const header = attributionHeader(track);
    expect(header.length).toBeLessThanOrEqual(5_500);
    const pointer = JSON.parse(decodeURIComponent(header)); expect(pointer.endpoint).toBe("/api/license"); expect(pointer.track.file).toBe(track.file);
  });
});
