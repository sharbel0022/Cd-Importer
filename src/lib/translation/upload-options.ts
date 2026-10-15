import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { AppError } from "../errors";
import { dataRoot, enforceQuota } from "./store";
import { optionsSchema, type StudioOptions } from "./types";

export const UPLOAD_OPTIONS_MAX_BYTES = 128 * 1024;
export const UPLOAD_OPTIONS_TTL_MS = 5 * 60_000;
export const UPLOAD_OPTIONS_MAX_TOKENS = 32;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenFile = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const claimedFile = /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.used$/;
const storedSchema = z.object({ expiresAt: z.number().finite(), options: optionsSchema }).strict();
function directory() { return path.join(dataRoot(), ".upload-options"); }
async function prepareDirectory() {
  const dir = directory(); await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink()) throw new AppError("Uppladdningsinställningarnas lagring är ogiltig.", 500);
  return dir;
}
async function cleanExpired(dir: string, now: number) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!tokenFile.test(entry.name) && !claimedFile.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const info = await lstat(file).catch(() => undefined); if (!info) continue;
    let expired = info.isSymbolicLink() || !info.isFile() || info.size > UPLOAD_OPTIONS_MAX_BYTES + 1024 || now - info.mtimeMs > UPLOAD_OPTIONS_TTL_MS;
    if (!expired && tokenFile.test(entry.name)) {
      try { const stored = storedSchema.safeParse(JSON.parse(await readFile(file, "utf8"))); expired = !stored.success || stored.data.expiresAt <= now; }
      catch { expired = true; }
    }
    if (expired && !info.isDirectory()) await rm(file, { force: true });
  }
}
async function withTokenLock<T>(dir: string, action: () => Promise<T>) {
  const lock = path.join(dir, ".lock");
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock); break; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const info = await lstat(lock).catch(() => undefined);
      if (info && info.isDirectory() && Date.now() - info.mtimeMs > 30_000) { await rmdir(lock).catch(() => undefined); }
      if (attempt >= 40) throw new AppError("Uppladdningsinställningarna är upptagna. Försök igen.", 409);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await action(); } finally { await rmdir(lock).catch(() => undefined); }
}
export async function createUploadOptions(raw: unknown, signal?: AbortSignal) {
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message || "Ogiltiga översättningsinställningar.");
  const options = parsed.data;
  if (Buffer.byteLength(JSON.stringify(options)) > UPLOAD_OPTIONS_MAX_BYTES) throw new AppError("Översättningsinställningarna är för stora.", 413);
  const dir = await prepareDirectory();
  return withTokenLock(dir, async () => {
    signal?.throwIfAborted(); const now = Date.now(); await cleanExpired(dir, now);
    const count = (await readdir(dir)).filter((name) => tokenFile.test(name)).length;
    if (count >= UPLOAD_OPTIONS_MAX_TOKENS) throw new AppError("För många förberedda uppladdningar. Vänta fem minuter eller slutför en uppladdning.", 429);
    const expiresAt = now + UPLOAD_OPTIONS_TTL_MS; const payload = JSON.stringify({ expiresAt, options });
    await enforceQuota(Buffer.byteLength(payload)); signal?.throwIfAborted();
    const token = randomUUID(); const file = path.join(dir, `${token}.json`);
    await writeFile(file, payload, { flag: "wx", mode: 0o600 });
    if (signal?.aborted) { await rm(file, { force: true }); signal.throwIfAborted(); }
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  });
}
export async function consumeUploadOptions(token: string): Promise<StudioOptions> {
  if (!uuid.test(token)) throw new AppError("Uppladdningens inställningstoken är ogiltig.");
  const dir = await prepareDirectory(); const source = path.join(dir, `${token}.json`); const claimed = path.join(dir, `${token}.${randomUUID()}.used`);
  return withTokenLock(dir, async () => {
  try { await rename(source, claimed); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new AppError("Uppladdningsinställningarna har löpt ut eller redan använts. Starta uppladdningen igen.", 410);
    throw cause;
  }
  try {
    const info = await lstat(claimed);
    if (!info.isFile() || info.isSymbolicLink() || info.size > UPLOAD_OPTIONS_MAX_BYTES + 1024) throw new AppError("Uppladdningens inställningar är ogiltiga.", 410);
    let raw: unknown; try { raw = JSON.parse(await readFile(claimed, "utf8")); } catch { throw new AppError("Uppladdningens inställningar kan inte läsas.", 410); }
    const parsed = storedSchema.safeParse(raw);
    if (!parsed.success || parsed.data.expiresAt <= Date.now() || parsed.data.expiresAt > Date.now() + UPLOAD_OPTIONS_TTL_MS) throw new AppError("Uppladdningsinställningarna har löpt ut. Starta uppladdningen igen.", 410);
    return parsed.data.options;
  } finally { await rm(claimed, { force: true }); }
  });
}
export async function uploadOptionsFromRequest(request: Request): Promise<StudioOptions> {
  const token = request.headers.get("x-studio-options-token");
  if (token !== null) return consumeUploadOptions(token);
  // Compatibility for existing scripts with small settings. Rich configurations
  // use the JSON preflight so percent-encoded Arabic never fills HTTP headers.
  const legacy = request.headers.get("x-studio-options") || "";
  if (!legacy || legacy.length > 12_000) throw new AppError("Starta uppladdningen från studion för att skicka större översättningsinställningar.", legacy ? 413 : 400);
  let raw: unknown; try { raw = JSON.parse(decodeURIComponent(legacy)); } catch { throw new AppError("Uppladdningen saknar giltiga inställningar."); }
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message || "Ogiltiga inställningar.");
  return parsed.data;
}
