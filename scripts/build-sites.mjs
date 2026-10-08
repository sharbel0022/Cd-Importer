import { build as viteBuild } from "vite";
import { build as bundle } from "esbuild";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const root = process.cwd();
await mkdir("public/ffmpeg", { recursive: true });
await copyFile("node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js", "public/ffmpeg/ffmpeg-core.js");
await copyFile("sites/ffmpeg-notice.txt", "public/ffmpeg/NOTICE.txt");
const wasm = await readFile("node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm");
const chunkSize = 16 * 1024 * 1024;
const parts = [];
for (let offset = 0; offset < wasm.length; offset += chunkSize) {
  const name = `core-${parts.length}.bin`;
  await writeFile(path.join("public/ffmpeg", name), wasm.subarray(offset, offset + chunkSize)); parts.push(name);
}
await writeFile("public/ffmpeg/manifest.json", JSON.stringify({ parts, size: wasm.length, sha256: createHash("sha256").update(wasm).digest("hex") }));
await copyFile("src/app/icon.svg", "public/ton-icon.svg");
await viteBuild({ configFile: path.join(root, "sites/vite.config.ts") });
await mkdir("dist/server", { recursive: true });
await bundle({ entryPoints: ["sites/worker.ts"], outfile: "dist/server/index.js", bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true,
  define: { __SITE_HTML__: JSON.stringify(await readFile("dist/client/index.html", "utf8")) } });
console.log("Sites build: Worker API, shared React UI and browser FFmpeg ready.");
