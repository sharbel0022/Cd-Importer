import { AppError } from "./errors";

export interface AudioCut { start: number; end: number }
export const MAX_AUDIO_CUTS = 32;
const MAX_SECONDS = 86_400;

/** Only bounded numbers enter FFmpeg filters; never accept filter expressions. */
export function parseAudioCuts(value: unknown): AudioCut[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    if (value.length > 8192) throw new AppError("För många ljudmarkeringar.");
    try { value = JSON.parse(value); } catch { throw new AppError("Ljudmarkeringarna kunde inte läsas."); }
  }
  if (!Array.isArray(value) || value.length > MAX_AUDIO_CUTS) throw new AppError(`Välj högst ${MAX_AUDIO_CUTS} delar att ta bort.`);
  const cuts = value.map((item: unknown): AudioCut => {
    if (typeof item !== "object" || item === null) throw new AppError("Ogiltig ljudmarkering.");
    const { start, end } = item as Partial<AudioCut>;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) ||
      start < 0 || end > MAX_SECONDS || end - start < 0.001) throw new AppError("Start och slut ska vara giltiga sekunder, med slut efter start.");
    return { start: Number(start.toFixed(6)), end: Number(end.toFixed(6)) };
  }).sort((a, b) => a.start - b.start);
  const merged: AudioCut[] = [];
  for (const cut of cuts) {
    const last = merged.at(-1);
    if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end);
    else merged.push({ ...cut });
  }
  return merged;
}

export function editedDuration(duration: number, cuts: AudioCut[]): number {
  return Math.max(0, duration - parseAudioCuts(cuts).reduce((sum, cut) => sum + Math.max(0, Math.min(duration, cut.end) - Math.min(duration, cut.start)), 0));
}

/** Keep the gaps and the real input's tail, never synthesize padding from a
 * client-supplied duration. Reset input timestamps (MediaRecorder may offset them). */
export function audioEditArguments(input: AudioCut[]): string[] {
  const cuts = parseAudioCuts(input);
  if (!cuts.length) return ["-map", "0:a:0"];
  const kept: { start: number; end?: number }[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor) kept.push({ start: cursor, end: cut.start });
    cursor = cut.end;
  }
  kept.push({ start: cursor });
  const seconds = (n: number) => n.toFixed(6);
  const sources = kept.map((_, i) => `[source${i}]`).join("");
  const filters = [`[0:a:0]asetpts=PTS-STARTPTS,asplit=${kept.length}${sources}`];
  kept.forEach((part, i) => filters.push(`[source${i}]atrim=start=${seconds(part.start)}${part.end === undefined ? "" : `:end=${seconds(part.end)}`},asetpts=PTS-STARTPTS[keep${i}]`));
  filters.push(`${kept.map((_, i) => `[keep${i}]`).join("")}concat=n=${kept.length}:v=0:a=1[edited]`);
  return ["-filter_complex", filters.join(";"), "-map", "[edited]"];
}
