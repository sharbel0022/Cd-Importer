import { z } from "zod";
import type { Job } from "./types";

const segmentSchema = z.object({
  id: z.string().regex(/^s\d+$/), target: z.string().max(10),
  start: z.number().finite(), end: z.number().finite(),
  speaker: z.string().max(80), text: z.string().max(4000), original: z.string().max(4000),
}).strict();
const snapshotSchema = z.object({
  segments: z.record(z.string().regex(/^s\d+$/), segmentSchema),
  voices: z.record(z.string().max(80), z.string().max(80)),
}).strict();
const storedSchema = z.object({
  version: z.literal(1), jobId: z.string().uuid(), target: z.string().max(10),
  revision: z.number().int().nonnegative(), updatedAt: z.string(),
  base: snapshotSchema, snapshot: snapshotSchema,
}).strict();
export type EditorSegmentDraft = z.infer<typeof segmentSchema>;
export type EditorSnapshot = z.infer<typeof snapshotSchema>;
export type StoredEditorDraft = z.infer<typeof storedSchema>;
export interface EditorHistory { past: EditorSnapshot[]; present: EditorSnapshot; future: EditorSnapshot[] }
export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export const EDITOR_DRAFT_PREFIX = "cd-importer:translation-draft:v1:";
export function editorDraftKey(jobId: string, target: string) { return `${EDITOR_DRAFT_PREFIX}${jobId}:${target}`; }

export function editorSnapshot(job: Job, target: string): EditorSnapshot {
  const translations = new Map((job.translations[target] || []).map((value) => [value.id, value.text]));
  return {
    segments: Object.fromEntries(job.segments.map((segment) => [segment.id, {
      id: segment.id, target, start: segment.start, end: segment.end,
      speaker: segment.speaker, text: translations.get(segment.id) || "", original: segment.text,
    }])),
    voices: { ...job.options.speakerVoices },
  };
}
export function sameEditorSnapshot(a: EditorSnapshot, b: EditorSnapshot) {
  const keys = Object.keys(a.segments);
  if (keys.length !== Object.keys(b.segments).length || keys.some((id) => !b.segments[id] || Object.entries(a.segments[id]).some(([key, value]) => value !== b.segments[id][key as keyof EditorSegmentDraft]))) return false;
  const speakers = Object.keys(a.voices);
  return speakers.length === Object.keys(b.voices).length && speakers.every((speaker) => a.voices[speaker] === b.voices[speaker]);
}
export function recordEditorChange(history: EditorHistory, snapshot: EditorSnapshot): EditorHistory {
  return sameEditorSnapshot(history.present, snapshot) ? history : { past: [...history.past.slice(-29), history.present], present: snapshot, future: [] };
}
export function undoEditorChange(history: EditorHistory): EditorHistory {
  return history.past.length ? { past: history.past.slice(0, -1), present: history.past.at(-1)!, future: [history.present, ...history.future].slice(0, 30) } : history;
}
export function redoEditorChange(history: EditorHistory): EditorHistory {
  return history.future.length ? { past: [...history.past.slice(-29), history.present], present: history.future[0], future: history.future.slice(1) } : history;
}
export function readEditorDraft(storage: DraftStorage, jobId: string, target: string): StoredEditorDraft | undefined {
  const raw = storage.getItem(editorDraftKey(jobId, target));
  if (!raw || raw.length > 12_000_000) return;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return; }
  const result = storedSchema.safeParse(parsed);
  if (!result.success || result.data.jobId !== jobId || result.data.target !== target || Object.keys(result.data.snapshot.segments).length > 6000 || Object.keys(result.data.base.segments).length > 6000) return;
  if (Object.entries(result.data.snapshot.segments).some(([id, segment]) => segment.id !== id || segment.target !== target)) return;
  return result.data;
}
export function writeEditorDraft(storage: DraftStorage, job: Pick<Job, "id" | "revision">, target: string, base: EditorSnapshot, snapshot: EditorSnapshot) {
  const key = editorDraftKey(job.id, target);
  if (sameEditorSnapshot(base, snapshot)) { storage.removeItem(key); return; }
  // Store only edited rows and their original values, keeping long projects
  // within browser quotas without saving unrelated private transcript text.
  const ids = Object.keys(snapshot.segments).filter((id) => !base.segments[id] || Object.entries(snapshot.segments[id]).some(([field, value]) => value !== base.segments[id][field as keyof EditorSegmentDraft]));
  const compactBase = { segments: Object.fromEntries(ids.filter((id) => base.segments[id]).map((id) => [id, base.segments[id]])), voices: base.voices };
  const compactSnapshot = { segments: Object.fromEntries(ids.map((id) => [id, snapshot.segments[id]])), voices: snapshot.voices };
  const stored: StoredEditorDraft = { version: 1, jobId: job.id, target, revision: job.revision, updatedAt: new Date().toISOString(), base: compactBase, snapshot: compactSnapshot };
  storage.setItem(key, JSON.stringify(stored));
}

/** Rebase only locally edited fields, preserving unrelated newer server changes.
 * Conflicting values remain recoverable and require an explicit user choice. */
export function recoverEditorDraft(stored: StoredEditorDraft, current: EditorSnapshot) {
  const segments = { ...current.segments }; const voices = { ...current.voices }; const conflicts: string[] = []; const orphaned: string[] = [];
  for (const [id, local] of Object.entries(stored.snapshot.segments)) {
    const base = stored.base.segments[id]; const server = current.segments[id];
    if (!server) { if (!base || JSON.stringify(local) !== JSON.stringify(base)) orphaned.push(id); continue; }
    if (!base) { conflicts.push(id); continue; }
    const next = { ...server };
    for (const key of ["start", "end", "speaker", "text", "original"] as const) {
      if (local[key] === base[key]) continue;
      if (server[key] !== base[key] && local[key] !== server[key]) conflicts.push(id);
      // Explicit recovery may accept this value; the caller must resolve conflicts first.
      Object.assign(next, { [key]: local[key] });
    }
    segments[id] = next;
  }
  for (const speaker of new Set([...Object.keys(stored.base.voices), ...Object.keys(stored.snapshot.voices)])) {
    const local = stored.snapshot.voices[speaker]; const base = stored.base.voices[speaker];
    if (local === base) continue;
    if (current.voices[speaker] !== base && local !== current.voices[speaker]) conflicts.push(`röst:${speaker}`);
    if (local === undefined) delete voices[speaker]; else voices[speaker] = local;
  }
  return { snapshot: { segments, voices }, conflicts: [...new Set(conflicts)], orphaned };
}
export function replaceTranslationText(snapshot: EditorSnapshot, search: string, replacement: string, ids?: Set<string>) {
  if (!search) return { snapshot, occurrences: 0 };
  let occurrences = 0;
  const segments = Object.fromEntries(Object.entries(snapshot.segments).map(([id, segment]) => {
    if (ids && !ids.has(id)) return [id, segment];
    const parts = segment.text.split(search);
    if (parts.length === 1) return [id, segment];
    occurrences += parts.length - 1;
    return [id, { ...segment, text: parts.join(replacement) }];
  }));
  return { snapshot: occurrences ? { ...snapshot, segments } : snapshot, occurrences };
}
