import { describe, expect, it } from "vitest";
import { editorDraftKey, editorSnapshot, readEditorDraft, recordEditorChange, recoverEditorDraft, redoEditorChange, replaceTranslationText, sameEditorSnapshot, undoEditorChange, writeEditorDraft, type DraftStorage, type EditorHistory, type EditorSnapshot } from "@/lib/translation/editor-draft";
import { optionsSchema, type Job } from "@/lib/translation/types";

const job: Job = { id: "2356e578-9bb3-4438-a33c-b42791e2ea44", name: "private.mp4", extension: "mp4", createdAt: "", updatedAt: "", revision: 4, options: optionsSchema.parse({ targets: ["en", "sv"], rights: true }), status: "review", stage: "transcribing", message: "", segments: [{ id: "s1", start: 0, end: 2, speaker: "unknown", text: "ثلاثة، لا، أربعة", uncertain: true }, { id: "s2", start: 3, end: 5, speaker: "unknown", text: "خمسة" }], translations: { en: [{ id: "s1", text: "Three, no, four" }, { id: "s2", text: "Five titles" }], sv: [{ id: "s1", text: "Tre, nej, fyra" }] }, outputs: {}, warnings: [], metrics: { processingMs: 0, stages: {} } };
function memoryStorage(): DraftStorage {
  const entries = new Map<string, string>();
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); }, removeItem: (key) => { entries.delete(key); } };
}
function changed(base: EditorSnapshot, id = "s1", text = "Three, no, I mean four") { return { ...base, segments: { ...base.segments, [id]: { ...base.segments[id], text } } }; }

describe("durable translation editor drafts", () => {
  it("restores source, translation, timing and voices independently for each job and language", () => {
    const storage = memoryStorage(); const base = editorSnapshot(job, "en");
    const draft = changed(base); draft.segments.s1 = { ...draft.segments.s1, original: "ثلاثة، لا، أعني أربعة", start: 0.2 }; draft.voices = { unknown: "en-us-lessac" };
    writeEditorDraft(storage, job, "en", base, draft);
    const stored = readEditorDraft(storage, job.id, "en")!;
    expect(Object.keys(stored.snapshot.segments)).toEqual(["s1"]); expect(stored.base.segments.s2).toBeUndefined();
    expect(stored.revision).toBe(4); expect(recoverEditorDraft(stored, base)).toEqual({ snapshot: draft, conflicts: [], orphaned: [] });
    expect(readEditorDraft(storage, job.id, "sv")).toBeUndefined();
    expect(readEditorDraft(storage, "00000000-0000-4000-8000-000000000000", "en")).toBeUndefined();
    expect(job.segments[0]).toMatchObject({ uncertain: true, text: "ثلاثة، لا، أربعة" });
  });
  it("rebases local text over a new server revision without overwriting unrelated changes", () => {
    const storage = memoryStorage(); const base = editorSnapshot(job, "en"); const draft = changed(base);
    writeEditorDraft(storage, job, "en", base, draft);
    const current = changed(base, "s2", "Five championships"); current.segments.s1 = { ...current.segments.s1, end: 2.2 };
    const recovered = recoverEditorDraft(readEditorDraft(storage, job.id, "en")!, current);
    expect(recovered.conflicts).toEqual([]); expect(recovered.snapshot.segments.s1).toMatchObject({ text: "Three, no, I mean four", end: 2.2 });
    expect(recovered.snapshot.segments.s2.text).toBe("Five championships");
  });
  it("reports conflicting server changes and keeps the original stored draft intact", () => {
    const storage = memoryStorage(); const base = editorSnapshot(job, "en"); writeEditorDraft(storage, job, "en", base, changed(base));
    const before = storage.getItem(editorDraftKey(job.id, "en"));
    const recovery = recoverEditorDraft(readEditorDraft(storage, job.id, "en")!, changed(base, "s1", "Server-approved translation"));
    expect(recovery.conflicts).toEqual(["s1"]); expect(recovery.snapshot.segments.s1.text).toBe("Three, no, I mean four");
    expect(storage.getItem(editorDraftKey(job.id, "en"))).toBe(before);
  });
  it("preserves removed segment drafts for recovery instead of restoring nonexistent server segments", () => {
    const storage = memoryStorage(); const base = editorSnapshot(job, "en"); writeEditorDraft(storage, job, "en", base, changed(base));
    const current = { ...base, segments: { s2: base.segments.s2 } };
    const recovery = recoverEditorDraft(readEditorDraft(storage, job.id, "en")!, current);
    expect(recovery.orphaned).toEqual(["s1"]); expect(recovery.snapshot.segments.s1).toBeUndefined();
    expect(readEditorDraft(storage, job.id, "en")!.snapshot.segments.s1.text).toBe("Three, no, I mean four");
  });
  it("does not flag a conflict when another save already contains the same correction", () => {
    const storage = memoryStorage(); const base = editorSnapshot(job, "en"); const draft = changed(base); writeEditorDraft(storage, job, "en", base, draft);
    expect(recoverEditorDraft(readEditorDraft(storage, job.id, "en")!, draft).conflicts).toEqual([]);
  });
  it("detects conflicting speaker voice changes including a locally removed assignment", () => {
    const storage = memoryStorage(); const base = editorSnapshot(job, "en"); base.voices = { unknown: "voice-one" };
    const draft = { ...base, voices: {} }; writeEditorDraft(storage, job, "en", base, draft);
    const recovered = recoverEditorDraft(readEditorDraft(storage, job.id, "en")!, { ...base, voices: { unknown: "voice-two" } });
    expect(recovered.conflicts).toEqual(["röst:unknown"]); expect(recovered.snapshot.voices).toEqual({});
  });
  it("removes only the current job/language draft after saved values match", () => {
    const storage = memoryStorage(); const base = editorSnapshot(job, "en"); writeEditorDraft(storage, job, "en", base, changed(base));
    const sv = editorSnapshot(job, "sv"); writeEditorDraft(storage, job, "sv", sv, changed(sv, "s1", "Tre, nej, jag menar fyra"));
    writeEditorDraft(storage, job, "en", base, base);
    expect(readEditorDraft(storage, job.id, "en")).toBeUndefined(); expect(readEditorDraft(storage, job.id, "sv")).toBeDefined();
  });
  it("ignores malformed, foreign and oversized stored data without deleting it", () => {
    const storage = memoryStorage(); const key = editorDraftKey(job.id, "en");
    for (const value of ["{", "null", JSON.stringify({ version: 99 }), "x".repeat(12_000_001)]) { storage.setItem(key, value); expect(readEditorDraft(storage, job.id, "en")).toBeUndefined(); expect(storage.getItem(key)).toBe(value); }
    const base = editorSnapshot(job, "en"); writeEditorDraft(storage, job, "en", base, changed(base));
    const foreign = JSON.parse(storage.getItem(key)!); foreign.snapshot.segments.s1.target = "sv"; storage.setItem(key, JSON.stringify(foreign));
    expect(readEditorDraft(storage, job.id, "en")).toBeUndefined();
  });
  it("supports bounded undo/redo, discards redo on new edits and restores voices/times together", () => {
    const base = editorSnapshot(job, "en"); let history: EditorHistory = { past: [], present: base, future: [] };
    const edit = changed(base); edit.voices = { unknown: "a" }; edit.segments.s1 = { ...edit.segments.s1, start: 0.3 };
    history = recordEditorChange(history, edit); const undone = undoEditorChange(history);
    expect(undone.present).toEqual(base); expect(redoEditorChange(undone).present).toEqual(edit);
    history = recordEditorChange(undone, changed(base, "s1", "New correction")); expect(history.future).toEqual([]);
    for (let i = 0; i < 50; i++) history = recordEditorChange(history, changed(base, "s1", `Correction ${i}`));
    expect(history.past).toHaveLength(30); expect(recordEditorChange(history, history.present)).toBe(history);
  });
  it("compares voice records independently of insertion order", () => {
    const base = editorSnapshot(job, "en"); expect(sameEditorSnapshot({ ...base, voices: { A: "one", B: "two" } }, { ...base, voices: { B: "two", A: "one" } })).toBe(true);
  });
  it("replaces literal translation matches while preserving source, numbers, timing and filtered segments", () => {
    const base = editorSnapshot(job, "en"); const input = changed(base, "s1", "Five titles. Five titles. $&");
    const result = replaceTranslationText(input, "Five", "Five [approved]", new Set(["s1"]));
    expect(result.occurrences).toBe(2); expect(result.snapshot.segments.s1.text).toBe("Five [approved] titles. Five [approved] titles. $&");
    expect(result.snapshot.segments.s2).toEqual(base.segments.s2); expect(result.snapshot.segments.s1.original).toBe(base.segments.s1.original);
    expect(result.snapshot.segments.s1.start).toBe(0); expect(replaceTranslationText(base, "", "x").snapshot).toBe(base);
  });
});
