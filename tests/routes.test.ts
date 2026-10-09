import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/lib/errors";
import type { Track } from "../src/lib/types";
import { GET as audio } from "../src/app/api/audio/route";
import { GET as download } from "../src/app/api/download/route";
import { POST as batch } from "../src/app/api/batch/route";
import { POST as convert } from "../src/app/api/convert/route";

const mocks = vi.hoisted(() => ({ resolveTrack: vi.fn(), safeAudioFetch: vi.fn(), prepareTrackDownload: vi.fn(), convertToMp3: vi.fn() }));
vi.mock("@/lib/catalog", () => ({ resolveTrack: mocks.resolveTrack }));
vi.mock("@/lib/safe-download", async () => ({ ...await vi.importActual<typeof import("../src/lib/safe-download")>("../src/lib/safe-download"), safeAudioFetch: mocks.safeAudioFetch }));
vi.mock("@/lib/media", async () => ({ ...await vi.importActual<typeof import("../src/lib/media")>("../src/lib/media"), prepareTrackDownload: mocks.prepareTrackDownload }));
vi.mock("@/lib/ffmpeg", async () => ({ ...await vi.importActual<typeof import("../src/lib/ffmpeg")>("../src/lib/ffmpeg"), convertToMp3: mocks.convertToMp3 }));

const track: Track = { source: "archive", id: "example", file: "song.mp3", key: "archive:example:song.mp3",
  title: "Vår låt", artist: "Åsa", format: "MP3", sourceUrl: "https://archive.org/details/example", playbackAllowed: true, downloadAllowed: true,
  license: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/", downloadAllowed: true, conversionAllowed: true, reason: "Verifierad licens.", attribution: "Åsa – Vår låt" } };

function mp3(): Buffer {
  const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0], 0); bytes.set([0xff, 0xfb, 0x90, 0], 417); return bytes;
}
const params = "source=archive&id=example&file=song.mp3";
function jsonRequest(body: unknown): Request { return new Request("http://localhost/api/batch", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }); }
function uploadRequest(filename = "my.wav", rightsConfirmed = "true"): Request {
  const form = new FormData(); form.set("file", new File(["RIFF....WAVE"], filename)); form.set("rightsConfirmed", rightsConfirmed); form.set("bitrate", "256");
  form.set("artist", "Åsa"); form.set("title", "Egen låt"); return new Request("http://localhost/api/convert", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTrack.mockResolvedValue({ track, url: "https://archive.org/download/example/song.mp3" });
  mocks.prepareTrackDownload.mockResolvedValue({ track, bytes: mp3(), filename: "Åsa - Vår låt.mp3", contentType: "audio/mpeg" });
  mocks.convertToMp3.mockResolvedValue(mp3());
});

describe("player and single download API", () => {
  it("rejects a malformed Range before making any provider call", async () => {
    const response = await audio(new Request(`http://localhost/api/audio?${params}`, { headers: { Range: "bytes=1-2,4-5" } }));
    expect(response.status).toBe(416); expect(mocks.resolveTrack).not.toHaveBeenCalled(); expect(mocks.safeAudioFetch).not.toHaveBeenCalled();
  });
  it("does not fetch audio when fresh metadata forbids playback", async () => {
    mocks.resolveTrack.mockResolvedValue({ track: { ...track, playbackAllowed: false }, url: "https://archive.org/download/example/song.mp3" });
    expect((await audio(new Request(`http://localhost/api/audio?${params}`))).status).toBe(403); expect(mocks.safeAudioFetch).not.toHaveBeenCalled();
  });
  it("preserves verified partial response semantics and passes the cancellation signal", async () => {
    mocks.safeAudioFetch.mockResolvedValue({ bytes: Buffer.alloc(10), status: 206, contentType: "audio/mpeg", contentRange: "bytes 10-19/100", acceptRanges: "bytes" });
    const request = new Request(`http://localhost/api/audio?${params}`, { headers: { Range: "bytes=10-19" } });
    const response = await audio(request);
    expect(response.status).toBe(206); expect(response.headers.get("Content-Range")).toBe("bytes 10-19/100"); expect(response.headers.get("Content-Length")).toBe("10");
    expect(mocks.safeAudioFetch).toHaveBeenCalledWith("https://archive.org/download/example/song.mp3", { range: "bytes=10-19", signal: request.signal });
  });
  it("returns MP3 bytes with a Swedish filename and license information", async () => {
    const request = new Request(`http://localhost/api/download?${params}&bitrate=320`);
    const response = await download(request);
    expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("Content-Disposition")).toContain("%C3%85sa");
    const license = JSON.parse(decodeURIComponent(response.headers.get("X-Music-Attribution")!));
    expect(license.original).toBe(track.sourceUrl); expect(license.licens).toBe("CC BY 4.0");
    expect(mocks.prepareTrackDownload).toHaveBeenCalledWith({ source: "archive", id: "example", file: "song.mp3" }, 320, undefined, request.signal);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(mp3());
  });
});

describe("ZIP partial failures", () => {
  it("packages successful audio with full licenses and reports every skipped track", async () => {
    mocks.prepareTrackDownload.mockImplementation(async (ref) => {
      if (ref.id === "missing") throw new AppError("Filen finns inte längre.", 404);
      return { track, bytes: mp3(), filename: "Åsa - Vår låt.mp3", contentType: "audio/mpeg" };
    });
    const response = await batch(jsonRequest({ tracks: [{ source: "archive", id: "example", file: "song.mp3" }, { source: "archive", id: "missing", file: "absent.mp3" }] }));
    expect(response.status).toBe(200);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(files["Åsa - Vår låt.mp3"]).toBeDefined();
    expect(JSON.parse(strFromU8(files["LICENSER.json"])).låtar[0].original).toBe(track.sourceUrl);
    const failed = JSON.parse(strFromU8(files["FEL.json"])); expect(failed).toHaveLength(1); expect(failed[0].track.id).toBe("missing");
    expect(JSON.parse(decodeURIComponent(response.headers.get("X-Skipped-Tracks")!))[0].message).toBe("Filen finns inte längre.");
  });
  it("returns all failures separately without a misleading empty ZIP", async () => {
    mocks.prepareTrackDownload.mockRejectedValue(new AppError("Licensen tillåter inte nedladdning.", 403));
    const response = await batch(jsonRequest({ tracks: [{ source: "archive", id: "blocked", file: "song.mp3" }] }));
    expect(response.status).toBe(422); expect(response.headers.get("Content-Type")).toContain("application/json");
    expect((await response.json()).failures[0].track.id).toBe("blocked");
  });
  it("refuses client URLs before processing a batch", async () => {
    const response = await batch(jsonRequest({ tracks: [{ source: "archive", id: "example", file: "song.mp3", url: "https://localhost/private" }] }));
    expect(response.status).toBe(400); expect(mocks.prepareTrackDownload).not.toHaveBeenCalled();
  });
});

describe("own-file upload API", () => {
  it("requires the rights confirmation before invoking FFmpeg", async () => {
    expect((await convert(uploadRequest("own.wav", "false"))).status).toBe(403); expect(mocks.convertToMp3).not.toHaveBeenCalled();
  });
  it("rejects playlists regardless of their MIME declaration", async () => {
    expect((await convert(uploadRequest("playlist.m3u"))).status).toBe(415); expect(mocks.convertToMp3).not.toHaveBeenCalled();
  });
  it("honors the declared upload size before allocating multipart input", async () => {
    vi.stubEnv("MAX_UPLOAD_MB", "1");
    try {
      const request = new Request("http://localhost/api/convert", { method: "POST", body: "x", headers: { "Content-Type": "multipart/form-data; boundary=test", "Content-Length": String(2 * 1024 * 1024) } });
      expect((await convert(request)).status).toBe(413); expect(mocks.convertToMp3).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
  it("forwards the chosen quality, file bytes and cancellation signal", async () => {
    const request = uploadRequest();
    const response = await convert(request);
    expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("Content-Disposition")).toContain("Egen%20l%C3%A5t.mp3");
    expect(mocks.convertToMp3).toHaveBeenCalledWith(Buffer.from("RIFF....WAVE"), 256, "wav", request.signal, []);
  });
  it("forwards normalized cuts and rejects malformed cuts before FFmpeg", async () => {
    const form = await uploadRequest().formData(); form.set("cuts", '[{"start":2,"end":4},{"start":1,"end":3}]');
    const request = new Request("http://localhost/api/convert", { method: "POST", body: form });
    expect((await convert(request)).status).toBe(200);
    expect(mocks.convertToMp3).toHaveBeenLastCalledWith(Buffer.from("RIFF....WAVE"), 256, "wav", request.signal, [{ start: 1, end: 4 }]);
    mocks.convertToMp3.mockClear(); form.set("cuts", '[{"start":"0;amovie=http://localhost","end":1}]');
    expect((await convert(new Request("http://localhost/api/convert", { method: "POST", body: form }))).status).toBe(400);
    expect(mocks.convertToMp3).not.toHaveBeenCalled();
  });
});
