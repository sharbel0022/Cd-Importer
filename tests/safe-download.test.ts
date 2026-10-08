import { describe, expect, it } from "vitest";
import { isPublicAddress, looksLikeDocument, safeAudioFetch, validateContentRange, validateMediaRedirect, validateMediaUrl, validateRange } from "../src/lib/safe-download";

describe("provider URL restrictions", () => {
  it("accepts only known HTTPS media hosts and source paths", () => {
    expect(validateMediaUrl("https://archive.org/download/example/Artist%20-%20Song.mp3").hostname).toBe("archive.org");
    expect(validateMediaUrl("https://ia800205.us.archive.org/12/items/example/song.mp3").hostname).toBe("ia800205.us.archive.org");
    expect(validateMediaUrl("https://dn711107.ca.archive.org/0/items/KevinMacLeodDivertissement/Divertissement.mp3").hostname).toBe("dn711107.ca.archive.org");
    expect(validateMediaUrl("https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.ogg").hostname).toBe("upload.wikimedia.org");
  });
  it.each([
    "http://archive.org/download/example/song.mp3", "https://127.0.0.1/song.mp3", "https://localhost/song.mp3",
    "https://archive.org.attacker.com/download/file.mp3", "https://attacker.com/song.mp3",
    "https://archive.org:8443/download/file.mp3", "https://user:password@archive.org/download/file.mp3",
    "https://archive.org/download/file.mp3#fragment", "https://archive.org/services/search/v1/scrape",
    "https://upload.wikimedia.org/wikipedia/en/a/ab/file.mp3", "https://archive.org/download/../secret.mp3",
    "https://archive.org/download/%2e%2e/secret.mp3", "https://archive.org/download/%252e%252e/secret.mp3",
    "https://archive.org/download/folder%5csecret.mp3", "https://archive.org/download/file%00.mp3",
    "https://ia800205.us.archive.org/private/song.mp3", "https://dn711107.ca.archive.org/private/song.mp3",
    "https://dn711107.ca.archive.org.attacker.com/0/items/example/song.mp3", "https://dn711107.us.archive.org/0/items/example/song.mp3",
  ])("rejects untrusted or malformed URLs: %s", (url) => { expect(() => validateMediaUrl(url)).toThrow(); });
});

describe("redirect validation", () => {
  const initial = "https://archive.org/download/example/song.mp3";
  it("accepts a known Internet Archive storage host", () => { expect(validateMediaRedirect("https://ia800205.us.archive.org/12/items/example/song.mp3", initial).hostname).toBe("ia800205.us.archive.org"); });
  it("accepts the verified Canadian download node with an items path", () => { expect(validateMediaRedirect("https://dn711107.ca.archive.org/0/items/KevinMacLeodDivertissement/Divertissement.mp3", initial).hostname).toBe("dn711107.ca.archive.org"); });
  it("accepts a same-folder relative file without traversal", () => { expect(validateMediaRedirect("other.mp3", initial).pathname).toBe("/download/example/other.mp3"); });
  it.each(["https://evil.example/song.mp3", "http://archive.org/download/example/song.mp3", "../song.mp3", "%252e%252e/song.mp3", "//127.0.0.1/song.mp3", "\\\\127.0.0.1\\song.mp3"])("rejects a redirect before URL normalization: %s", (location) => { expect(() => validateMediaRedirect(location, initial)).toThrow(); });
});

describe("upstream partial responses", () => {
  it("matches the requested interval and actual body size", () => { expect(validateContentRange("bytes 10-19/100", "bytes=10-19", 10)).toBe("bytes 10-19/100"); });
  it("accepts suffix ranges clamped to the complete file", () => { expect(validateContentRange("bytes 0-99/100", "bytes=-200", 100)).toBe("bytes 0-99/100"); });
  it.each([
    [undefined, "bytes=0-", 10], ["bytes 0-9/100", undefined, 10], ["bytes 0-9/*", "bytes=0-", 10],
    ["bytes 10-19/100", "bytes=0-", 10], ["bytes 0-99/100", "bytes=0-9", 100],
    ["bytes 0-9/100", "bytes=0-9", 9], ["bytes 95-105/100", "bytes=95-", 11],
    ["bytes 10-19/100", "bytes=-10", 10], ["bytes 0-9/100,20-29/100", "bytes=0-", 10],
  ] as const)("rejects malformed or mismatched ranges", (contentRange, range, size) => { expect(() => validateContentRange(contentRange, range, size)).toThrow(); });
});

describe("documents disguised as audio/octet-stream", () => {
  it.each(["<html>404</html>", "  <!DOCTYPE html>", "\uFEFF<?xml version='1.0'?>", "<svg></svg>", "{\"error\":\"missing\"}", "[1,2]", "#EXTM3U\nhttps://example.com"])("recognizes a non-audio body", (body) => { expect(looksLikeDocument(Buffer.from(body))).toBe(true); });
  it.each([Buffer.from("ID3"), Buffer.from("RIFF....WAVE"), Buffer.from("fLaC"), Buffer.from("OggS"), Buffer.from([0xff, 0xfb, 0x90, 0])])("does not misclassify common audio headers", (body) => { expect(looksLikeDocument(body)).toBe(false); });
});

it("does not contact a provider for a previously aborted download", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(safeAudioFetch("https://archive.org/download/example/song.mp3", { signal: controller.signal })).rejects.toMatchObject({ status: 400 });
});

describe("DNS rebinding and private-address checks", () => {
  it.each(["127.0.0.1", "10.4.5.6", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "192.0.2.1", "::", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2001::1", "2002:7f00:1::1", "garbage"])("blocks %s", (address) => { expect(isPublicAddress(address)).toBe(false); });
  it.each(["8.8.8.8", "1.1.1.1", "207.241.224.2", "2606:4700:4700::1111", "2001:4860:4860::8888"])("accepts public address %s", (address) => { expect(isPublicAddress(address)).toBe(true); });
});

describe("single HTTP byte ranges", () => {
  it.each(["bytes=0-", "bytes=100-999", "bytes=-500"])("accepts %s", (range) => { expect(validateRange(range)).toBe(range); });
  it.each(["bytes=", "bytes=-", "bytes=10-5", "bytes=0-1,20-30", "bytes=-0", "bytes=9007199254740992-", "items=0-1"])("rejects %s", (range) => { expect(() => validateRange(range)).toThrow(); });
});
