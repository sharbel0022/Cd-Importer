import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
export default defineConfig({
  root: root + "sites", publicDir: root + "public",
  plugins: [react()],
  resolve: { alias: [{ find: "@/lib/music-request", replacement: root + "sites/browser-request.ts" }, { find: "@", replacement: root + "src" }] },
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
  build: { outDir: root + "dist/client", emptyOutDir: true, target: "es2022" },
  worker: { format: "es" },
});
