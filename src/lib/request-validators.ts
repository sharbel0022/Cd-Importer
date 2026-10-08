import { z } from "zod";
import { AppError } from "./errors";
import type { Bitrate, TrackRef } from "./types";

const refSchema = z.object({
  source: z.enum(["archive", "commons"]),
  id: z.string().min(1).max(300),
  file: z.string().min(1).max(500).optional(),
}).strict();

export function parseTrackRef(input: unknown): TrackRef {
  const value = input instanceof URLSearchParams ? Object.fromEntries(
    ["source", "id", "file"].flatMap(key => input.has(key) ? [[key, input.get(key)]] : [])
  ) : input;
  const result = refSchema.safeParse(value);
  if (!result.success) throw new AppError("Ogiltig låtreferens. Välj en låt från sökresultaten.", 400);
  const ref = result.data;
  if (ref.source === "archive" && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(ref.id) || !ref.file)) {
    throw new AppError("Ogiltig Internet Archive-referens.", 400);
  }
  if (ref.source === "commons" && (!ref.id.startsWith("File:") || ref.id.length < 6 || /[\u0000-\u001f\u007f]/.test(ref.id) || ref.file !== undefined)) {
    throw new AppError("Ogiltig Wikimedia Commons-referens.", 400);
  }
  if (ref.file && (/[\\\u0000-\u001f\u007f]/.test(ref.file) || ref.file.startsWith("/") || ref.file.split("/").some(segment => segment === "." || segment === ".." || !segment))) {
    throw new AppError("Ogiltigt filnamn från källan.", 400);
  }
  return ref;
}

export function parseBitrate(value: unknown = 192): Bitrate {
  const number = Number(value ?? 192);
  if (![128, 192, 256, 320].includes(number)) throw new AppError("Välj 128, 192, 256 eller 320 kbps.", 400);
  return number as Bitrate;
}

export function parseSearch(params: URLSearchParams): { query: string; source: "all" | "archive" | "commons"; page: number; licensedOnly: boolean } {
  const query = (params.get("q") || "").trim().replace(/\s+/g, " ");
  if (query.length < 2 || query.length > 120 || /[\u0000-\u001f\u007f]/.test(query)) throw new AppError("Sökningen måste innehålla 2–120 tecken.", 400);
  const source = params.get("source") || "all";
  if (!["all", "archive", "commons"].includes(source)) throw new AppError("Välj en giltig musikkälla.", 400);
  const rawPage = params.get("page") || "1";
  if (!/^\d+$/.test(rawPage) || Number(rawPage) < 1 || Number(rawPage) > 50) throw new AppError("Ogiltig resultatsida.", 400);
  const licensed = params.get("licensedOnly") ?? "false";
  if (licensed !== "true" && licensed !== "false") throw new AppError("Ogiltigt licensfilter.", 400);
  return { query, source: source as "all" | "archive" | "commons", page: Number(rawPage), licensedOnly: licensed === "true" };
}

