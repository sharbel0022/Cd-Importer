import { describe, expect, it } from "vitest";
import { boundedJson, guardRequest, limitedBody, parseBitrate, parseSearch, parseTrackRef } from "@/lib/request";

describe("serverns indata och resursgränser", () => {
  it("tillåter endast källreferenser, aldrig URL från klienten", () => {
    expect(() => parseTrackRef({ source: "archive", id: "album", file: "song.mp3", url: "http://localhost" })).toThrow();
    expect(() => parseTrackRef({ source: "archive", id: "https://archive.org/item", file: "song.mp3" })).toThrow();
    expect(parseTrackRef({ source: "commons", id: "File:En låt.ogg" })).toEqual({ source: "commons", id: "File:En låt.ogg" });
  });
  it.each(["../song.mp3", "folder/../song.mp3", "/song.mp3", "folder\\song.mp3", "folder//song.mp3"])("avvisar osäkert filnamn %s", file => {
    expect(() => parseTrackRef({ source: "archive", id: "album", file })).toThrow();
  });
  it("läser filreferenser utan att acceptera URL-parametrar som metadata", () => {
    expect(parseTrackRef(new URLSearchParams({ source: "archive", id: "album", file: "song.mp3", bitrate: "192" }))).toEqual({ source: "archive", id: "album", file: "song.mp3" });
  });
  it("validerar sökfråga, källa, sidnummer och kvalitet", () => {
    expect(() => parseSearch(new URLSearchParams({ q: "a" }))).toThrow();
    expect(() => parseSearch(new URLSearchParams({ q: "jazz", source: "spotify" }))).toThrow();
    expect(() => parseSearch(new URLSearchParams({ q: "jazz", page: "1.2" }))).toThrow();
    expect(() => parseSearch(new URLSearchParams({ q: "jazz", licensedOnly: "yes" }))).toThrow();
    expect(parseSearch(new URLSearchParams({ q: "  jazz   piano ", licensedOnly: "true" })).query).toBe("jazz piano");
    expect(() => parseBitrate(42)).toThrow();
    expect(parseBitrate("320")).toBe(320);
  });
  it("stoppar för stora strömmade kroppar utan Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(11)); controller.close(); } });
    const request = new Request("http://localhost/api", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(limitedBody(request, 10)).rejects.toMatchObject({ status: 413 });
  });
  it("avvisar trasig JSON och för stor deklarerad kropp", async () => {
    await expect(boundedJson(new Request("http://localhost/api", { method: "POST", body: "{", headers: { "Content-Type": "application/json" } }))).rejects.toMatchObject({ status: 400 });
    await expect(limitedBody(new Request("http://localhost/api", { method: "POST", body: "x", headers: { "Content-Length": "999" } }), 10)).rejects.toMatchObject({ status: 413 });
  });
  it("blockerar mutationer från andra webbplatser", () => {
    expect(() => guardRequest(new Request("http://localhost/api/convert", { headers: { Origin: "https://evil.test" } }), "test-mutation", true)).toThrow();
    expect(() => guardRequest(new Request("http://localhost/api/convert", { headers: { "Sec-Fetch-Site": "cross-site" } }), "test-mutation", true)).toThrow();
  });
  it("accepterar verkligt loopback-Host när Next normaliserar URL till localhost", () => {
    expect(() => guardRequest(new Request("http://localhost:3000/api/convert", { headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000" } }), "test-local-alias", true)).not.toThrow();
    expect(() => guardRequest(new Request("http://localhost:3000/api/convert", { headers: { Host: "192.168.1.20:3000", Origin: "http://192.168.1.20:3000" } }), "test-lan-alias", true)).not.toThrow();
  });
  it("litar inte på domänalias, andra portar eller forwarded headers", () => {
    expect(() => guardRequest(new Request("http://localhost:3000/api/convert", { headers: { Host: "evil.test:3000", Origin: "http://evil.test:3000" } }), "test-evil-alias", true)).toThrow();
    expect(() => guardRequest(new Request("http://localhost:3000/api/convert", { headers: { Host: "127.0.0.1:3001", Origin: "http://127.0.0.1:3001" } }), "test-other-port", true)).toThrow();
    expect(() => guardRequest(new Request("http://localhost:3000/api/convert", { headers: { "X-Forwarded-Host": "evil.test:3000", Origin: "http://evil.test:3000" } }), "test-forwarded-alias", true)).toThrow();
  });
});
