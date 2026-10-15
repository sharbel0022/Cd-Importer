// Private, loopback-only listening packets with actual byte-range seeking.
import http from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";

const whatsapp = process.argv.includes("--whatsapp");
const directory = path.resolve("test-results", whatsapp ? "whatsapp-human-review" : "ai-listening");
const port = whatsapp ? 8768 : 8769;
const root = await realpath(directory);
const types = { ".html": "text/html; charset=utf-8", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".json": "application/json", ".txt": "text/plain; charset=utf-8" };
const server = http.createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405).end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const candidate = path.resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
    const file = await realpath(candidate);
    if (!file.startsWith(root + path.sep) || !types[path.extname(file)]) { response.writeHead(404).end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    const headers = { "Accept-Ranges": "bytes", "Content-Type": types[path.extname(file)], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    let start = 0, end = info.size - 1, status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      let valid = !!match && !!(match[1] || match[2]);
      if (valid && !match[1]) {
        const suffix = Number(match[2]);
        valid = Number.isSafeInteger(suffix) && suffix > 0;
        start = Math.max(0, info.size - suffix);
      } else if (valid) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      }
      if (!valid || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
        response.writeHead(416, { ...headers, "Content-Range": `bytes */${info.size}` }).end(); return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
    }
    headers["Content-Length"] = String(Math.max(0, end - start + 1));
    response.writeHead(status, headers);
    if (request.method === "HEAD" || info.size === 0) { response.end(); return; }
    const stream = createReadStream(file, { start, end });
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Private listening packet: http://127.0.0.1:${port}`));
