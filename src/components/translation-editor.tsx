"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Play, Redo2, RefreshCw, Save, Undo2 } from "lucide-react";
import { fileUrl, jsonRequest, originalPreviewUrl, segmentUrl } from "@/lib/translation/client";
import { editorDraftKey, editorSnapshot, readEditorDraft, recordEditorChange, recoverEditorDraft, redoEditorChange, replaceTranslationText, sameEditorSnapshot, undoEditorChange, writeEditorDraft, type EditorHistory, type EditorSnapshot, type StoredEditorDraft } from "@/lib/translation/editor-draft";
import { pendingSourceSegments, type Capabilities, type Job } from "@/lib/translation/types";

export function TranslationPlayer({ job, target }: { job: Job; target: string }) {
  const [translated, setTranslated] = useState(true); const [position, setPosition] = useState(0); const [playError, setPlayError] = useState("");
  const [videoFormat, setVideoFormat] = useState("mp4"); const [playbackRate, setPlaybackRate] = useState(1);
  const original = useRef<HTMLMediaElement | null>(null); const output = useRef<HTMLMediaElement | null>(null);
  const pendingSeek = useRef<{ output: boolean; time: number; play: boolean } | null>(null);
  const videoFormats = ["mp4", "mp4-captioned"].filter((format) => job.outputs[target]?.includes(format));
  const previewFormat = job.media?.video ? videoFormats.includes(videoFormat) ? videoFormat : videoFormats[0] || "mp4" : "mp3";
  const hasTranslation = !!job.outputs[target]?.includes(previewFormat);
  const media = translated && hasTranslation ? output : original;
  const outputLabel = job.options.mode === "subtitles" ? "Översatta undertexter" : "Översatt AI-tal";
  function change(value: boolean) {
    const previous = media.current; const next = value ? output.current : original.current;
    const play = previous ? !previous.paused : false; const time = previous?.currentTime || 0;
    previous?.pause(); setTranslated(value);
    if (next?.readyState) { next.currentTime = Math.min(time, Number.isFinite(next.duration) ? next.duration : time); if (play) void next.play().catch(() => setPlayError("Tryck på play i spelaren för att starta ljudet.")); }
    else pendingSeek.current = { output: value, time, play };
    setPosition(time);
  }
  function renderPlayer(isOutput: boolean) {
    const ref = isOutput ? output : original; const other = isOutput ? original : output;
    const props = { src: isOutput ? fileUrl(job.id, target, previewFormat, false, false, job.revision) : originalPreviewUrl(job.id, target), controls: true, preload: "metadata", "aria-label": isOutput ? outputLabel : "Originalinspelning", onPlay: () => { other.current?.pause(); setTranslated(isOutput); }, onTimeUpdate: () => { if (ref.current && !ref.current.paused) setPosition(ref.current.currentTime); }, onSeeked: () => setPosition(ref.current?.currentTime || 0), onError: () => setPlayError("Webbläsaren kan inte spela denna kodek. Hämta filen och använd en kompatibel spelare."), onLoadedMetadata: () => { setPlayError(""); if (ref.current) ref.current.playbackRate = playbackRate; const pending = pendingSeek.current; if (pending && pending.output === isOutput && ref.current) { ref.current.currentTime = Math.min(pending.time, ref.current.duration); if (pending.play) void ref.current.play().catch(() => setPlayError("Tryck på play för att fortsätta.")); pendingSeek.current = null; } } };
    return job.media?.video ? <video key={isOutput ? previewFormat : "original"} ref={(node) => { ref.current = node; }} {...props} playsInline>{isOutput && previewFormat !== "mp4-captioned" && job.outputs[target]?.includes("vtt") && <track kind="subtitles" src={fileUrl(job.id, target, "vtt", false, false, job.revision)} srcLang={target} label={`Översättning (${target})`} default />}</video> : <audio ref={(node) => { ref.current = node; }} {...props} />;
  }
  return <section className="ts-card ts-preview">
    <div className="ts-row"><h2>Förhandsgranskning</h2><div className="ts-toggle"><button aria-pressed={!translated} onClick={() => change(false)}>Original</button><button disabled={!hasTranslation} aria-pressed={translated} onClick={() => change(true)}>{outputLabel}</button></div></div>
    <div className="ts-export-row"><label>Uppspelningshastighet<select value={playbackRate} onChange={(event) => { const rate = Number(event.target.value); setPlaybackRate(rate); if (original.current) original.current.playbackRate = rate; if (output.current) output.current.playbackRate = rate; }}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}</select></label>{videoFormats.length > 1 && <label>Videoversion<select value={previewFormat} onChange={(event) => { const previous = output.current; pendingSeek.current = { output: true, time: previous?.currentTime || 0, play: previous ? !previous.paused : false }; previous?.pause(); setVideoFormat(event.target.value); }}><option value="mp4">MP4 med valbara undertexter</option><option value="mp4-captioned">MP4 med inbrända undertexter</option></select></label>}{job.media?.video && hasTranslation && <a className="ts-button" href={fileUrl(job.id, target, previewFormat, false, true, job.revision)} download>Hämta visad videoversion</a>}</div>
    <div className="ts-media-comparison"><div><h3>Original</h3>{renderPlayer(false)}</div><div><h3>{outputLabel} ({target})</h3>{hasTranslation ? renderPlayer(true) : <p className="ts-muted">{job.options.mode === "subtitles" ? "Undertextläget behåller originalets ljud. Hämta översättningen som SRT eller VTT via Exportformat när den är klar." : "Uppspelning visas när bearbetningen är klar. Granska osäkra segment innan dubbningen fortsätter."}</p>}</div></div>
    {playError && <p className="ts-alert" role="alert">{playError}</p>}
    {job.media && <><button className="ts-waveform" aria-label="Sök i ljudvågformen" onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (media.current) media.current.currentTime = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * job.media!.duration; }} onKeyDown={(event) => { if (media.current && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); media.current.currentTime = Math.max(0, Math.min(job.media!.duration, media.current.currentTime + (event.key === "ArrowRight" ? 5 : -5))); } }}>
      <svg viewBox="0 0 1000 96" preserveAspectRatio="none" aria-hidden="true">{job.media.waveform.map((amplitude, n) => <line key={n} x1={n * 1000 / job.media!.waveform.length} x2={n * 1000 / job.media!.waveform.length} y1={48 - Math.max(1, amplitude * 44)} y2={48 + Math.max(1, amplitude * 44)} stroke={n / job.media!.waveform.length <= position / job.media!.duration ? "#bdf58c" : "#53684b"} />)}<line x1={position / job.media.duration * 1000} x2={position / job.media.duration * 1000} y1="0" y2="96" stroke="#f5f6ef" /></svg>
    </button><div className="ts-row ts-muted"><span>{position.toFixed(1)} / {job.media.duration.toFixed(1)} s</span><span>{job.media.sampleRate} Hz · {job.media.channels} kanaler · källa</span></div></>}
    <p className="ts-muted">Spelaren använder samma exporterade MP3/MP4 som nedladdningen. Växling behåller tidspositionen. Ljudvågformen visar originalet. Genererade röster är AI-skapade.</p>
  </section>;
}

export function TranslationEditor({ job, target, caps, onSaved, onDirty }: { job: Job; target: string; caps?: Capabilities; onSaved: (job: Job) => void; onDirty?: (dirty: boolean) => void }) {
  const translated = useMemo(() => new Map((job.translations[target] || []).map((t) => [t.id, t])), [job.translations, target]);
  const originals = useMemo(() => new Map(job.segments.map((segment) => [segment.id, segment])), [job.segments]);
  const [base] = useState(() => editorSnapshot(job, target));
  const [history, setHistory] = useState<EditorHistory>(() => ({ past: [], present: base, future: [] }));
  const historyRef = useRef(history);
  const [ready, setReady] = useState(false); const [draftStatus, setDraftStatus] = useState("Läser lokalt utkast…");
  const [recovery, setRecovery] = useState<{ stored: StoredEditorDraft; snapshot: EditorSnapshot; conflicts: string[]; orphaned: string[] }>();
  const [page, setPage] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [search, setSearch] = useState(""); const [replacement, setReplacement] = useState("");
  const [asrModel, setAsrModel] = useState(""); const [denoise, setDenoise] = useState(false); const [comparing, setComparing] = useState("");
  const draftKey = editorDraftKey(job.id, target);
  const dirtyCallback = useRef(onDirty);
  useEffect(() => { dirtyCallback.current = onDirty; }, [onDirty]);
  useEffect(() => {
    try {
      const stored = readEditorDraft(localStorage, job.id, target);
      if (stored) {
        const recovered = recoverEditorDraft(stored, base);
        if (recovered.conflicts.length || recovered.orphaned.length) {
          setRecovery({ stored, ...recovered }); setDraftStatus("Ett tidigare utkast behöver jämföras med den sparade versionen."); dirtyCallback.current?.(true);
        } else {
          const restored = { past: [], present: recovered.snapshot, future: [] };
          historyRef.current = restored; setHistory(restored);
          writeEditorDraft(localStorage, job, target, base, recovered.snapshot);
          const dirty = !sameEditorSnapshot(base, recovered.snapshot);
          setDraftStatus(dirty ? "Lokalt utkast återställt. Spara ändringarna till projektet när du har granskat dem." : "Alla ändringar är sparade till projektet."); dirtyCallback.current?.(dirty);
        }
      } else setDraftStatus("Alla ändringar är sparade till projektet.");
    } catch { setDraftStatus("Webbläsaren kunde inte läsa lokala utkast. Spara ändringarna till projektet innan du lämnar sidan."); }
    setReady(true);
    // Parent keys this editor by job, target, revision and status. Rebase once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const drafts = history.present.segments; const voices = history.present.voices;
  const hasDraftChanges = !sameEditorSnapshot(base, history.present);
  useEffect(() => { if (ready) dirtyCallback.current?.(hasDraftChanges || !!recovery); }, [ready, hasDraftChanges, recovery]);
  useEffect(() => {
    if (!hasDraftChanges && !recovery) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasDraftChanges, recovery]);
  function persist(next: EditorHistory) {
    historyRef.current = next; setHistory(next);
    const dirty = !sameEditorSnapshot(base, next.present); dirtyCallback.current?.(dirty);
    try { writeEditorDraft(localStorage, job, target, base, next.present); setDraftStatus(dirty ? "Utkast autosparat i den här webbläsaren. Spara ändringarna till projektet före export." : "Alla ändringar är sparade till projektet."); }
    catch { setDraftStatus("Utkastet finns bara i den här fliken. Webbläsarens lagring är otillgänglig eller full. Spara ändringarna till projektet."); }
  }
  function change(snapshot: EditorSnapshot) { persist(recordEditorChange(historyRef.current, snapshot)); }
  function restoreDraft() {
    if (!recovery || recovery.orphaned.length) return;
    change(recovery.snapshot); setRecovery(undefined);
  }
  function discardDraft() {
    try { localStorage.removeItem(draftKey); } catch { setError("Det lokala utkastet kunde inte raderas."); return; }
    setRecovery(undefined); persist({ past: [], present: base, future: [] });
  }
  function downloadDraft() {
    const stored = recovery?.stored || { version: 1, jobId: job.id, target, revision: job.revision, base, snapshot: history.present };
    const url = URL.createObjectURL(new Blob([JSON.stringify(stored, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `translation-draft-${job.id}-${target}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const editable = ready && !recovery && !busy && !comparing && ["paused", "failed", "review", "completed"].includes(job.status); const speakers = [...new Set(job.segments.map((s) => s.speaker))];
  const availableVoices = caps?.voices.filter((v) => v !== "xtts" && job.options.targets.every((t) => !caps.voiceLanguages[v] || caps.voiceLanguages[v].includes(t)) && (!job.options.targets.includes("en") || !caps.voiceLocales?.[v] || caps.voiceLocales[v] === job.options.englishLocale)) || [];
  const [reviewOnly, setReviewOnly] = useState(false);
  const [playingSegment, setPlayingSegment] = useState<{ id: string; translated: boolean; start: number; end: number; sequence: number }>();
  const playbackSequence = useRef(0);
  const segmentPlayer = useRef<HTMLAudioElement>(null);
  function playSegment(value: { id: string; translated: boolean; start: number; end: number }) {
    segmentPlayer.current?.pause(); setPlayingSegment({ ...value, sequence: ++playbackSequence.current });
  }
  const pendingIds = new Set(pendingSourceSegments(job).map((s) => s.id));
  const visibleSegments = job.segments.filter((s) => (!reviewOnly || pendingIds.has(s.id) || translated.get(s.id)?.timing?.review || translated.get(s.id)?.reviewRequired) && (!search || drafts[s.id]?.text.includes(search)));
  function replaceMatches() {
    const result = replaceTranslationText(historyRef.current.present, search, replacement, new Set(visibleSegments.map((s) => s.id)));
    if (Object.values(result.snapshot.segments).some((segment) => segment.text.length > 4000)) { setError("Ersättningen gör en översättning längre än 4 000 tecken. Använd en kortare text."); return; }
    change(result.snapshot); setPage(0); setError("");
  }
  async function compareAsr(id: string) {
    const model = asrModel || caps?.asrModels?.[0]?.id;
    if (!model || !editable || hasDraftChanges) return;
    setComparing(id); setError("");
    try { onSaved(await jsonRequest<Job>(`/api/translation/jobs/${job.id}/asr`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: job.revision, segmentIds: [id], models: [model], denoise }) })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Segmentet kunde inte transkriberas igen."); }
    finally { setComparing(""); }
  }
  async function approve(id: string) {
    setBusy(true); setError("");
    try { onSaved(await jsonRequest(`/api/translation/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve-source", ids: [id] }) })); }
    catch (e) { setError(e instanceof Error ? e.message : "Segmentet kunde inte godkännas."); } finally { setBusy(false); }
  }
  async function save(regenerateId?: string) {
    if (!editable) return;
    setBusy(true); setError("");
    try {
      const edits = Object.values(drafts).filter((d) => { const s = originals.get(d.id)!; return d.text !== (translated.get(d.id)?.text || "") || d.original !== s.text || d.start !== s.start || d.end !== s.end || d.speaker !== s.speaker; });
      const voicesChanged = !sameEditorSnapshot({ segments: {}, voices }, { segments: {}, voices: job.options.speakerVoices });
      if (!edits.length && !voicesChanged && !regenerateId) { setError("Inga ändringar att spara."); return; }
      if (voicesChanged && !edits.length) edits.push(Object.values(drafts)[0]);
      const latest = await jsonRequest<Job>(`/api/translation/jobs/${job.id}`);
      if (latest.revision !== job.revision) { onSaved(latest); return; }
      let next: Job = job;
      if (edits.length) next = await jsonRequest<Job>(`/api/translation/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "edit", revision: job.revision, edits, ...(voicesChanged ? { speakerVoices: voices } : {}) }) });
      if (regenerateId) {
        // A source correction must be approved/retranslated first. Saving it
        // already revokes old audio; never play or regenerate the stale text.
        if (!pendingSourceSegments(next).some((s) => s.id === regenerateId) && next.translations[target]?.some((t) => t.id === regenerateId)) next = await jsonRequest<Job>(`/api/translation/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "regenerate", target, ids: [regenerateId] }) });
      }
      try { localStorage.removeItem(draftKey); } catch { /* Recovery will see that saved fields already match. */ }
      dirtyCallback.current?.(false);
      onSaved(next);
    }
    catch (e) { setError(e instanceof Error ? e.message : "Ändringarna kunde inte sparas."); } finally { setBusy(false); }
  }
  return <section className="ts-card ts-editor" onKeyDown={(event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === "s") { event.preventDefault(); if (editable) void save(); }
    if (event.altKey && event.key.toLowerCase() === "z") { event.preventDefault(); if (editable) persist(event.shiftKey ? redoEditorChange(historyRef.current) : undoEditorChange(historyRef.current)); }
  }}>
    <div className="ts-row"><div><span className="ts-eyebrow">TRANSKRIPT & ÖVERSÄTTNING</span><h2>{job.segments.length} tidsatta segment</h2></div><button className="ts-button" disabled={!editable || busy} onClick={() => void save()}><Save size={16} />Spara ändringar</button></div>
    <p className="ts-muted">Lyssna på markerade ord, rätta och spara. Godkänn varje osäkert källsegment när du har lyssnat. Rå ASR och ändringshistorik behålls separat. Rättad källtext översätts på nytt; oförändrat tal återanvänds vid ny komplett export.</p>
    <p className="ts-muted" role="status">{draftStatus}</p>
    <div className="ts-actions"><button className="ts-button" aria-keyshortcuts="Control+Alt+Z Meta+Alt+Z" disabled={!editable || !history.past.length} onClick={() => persist(undoEditorChange(historyRef.current))}><Undo2 size={15} />Ångra utkast</button><button className="ts-button" aria-keyshortcuts="Control+Alt+Shift+Z Meta+Alt+Shift+Z" disabled={!editable || !history.future.length} onClick={() => persist(redoEditorChange(historyRef.current))}><Redo2 size={15} />Gör om utkast</button>{hasDraftChanges && <button className="ts-button" onClick={downloadDraft}>Hämta utkast</button>}</div>
    <p className="ts-muted">Ctrl/Cmd+S sparar till projektet. Ctrl/Cmd+Alt+Z ångrar; lägg till Shift för att göra om. Lokala utkast innehåller text och röstval och sparas i den här webbläsaren.</p>
    {recovery && <div className="ts-review-callout" role="alert"><strong>Projektet har ändrats sedan ditt lokala utkast sparades.</strong><p>Konflikter: {recovery.conflicts.join(", ") || "inga"}. Segment som saknas i projektet: {recovery.orphaned.join(", ") || "inga"}. Hämta utkastet för att bevara en egen kopia. Återställning fyller redigeraren och godkänner ingen källtext.</p><div className="ts-actions"><button className="ts-button" onClick={downloadDraft}>Hämta tidigare utkast</button><button className="ts-button" disabled={!!recovery.orphaned.length} onClick={restoreDraft}>Återställ utkast för granskning</button><button className="ts-button" onClick={discardDraft}>Kasta lokalt utkast · behåll projektets text</button></div></div>}
    <div className="ts-export-row"><label>Sök i översättningar<input type="search" maxLength={4000} value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></label><label>Ersätt med<input maxLength={4000} value={replacement} onChange={(event) => setReplacement(event.target.value)} /></label><button className="ts-button" disabled={!editable || !search || !visibleSegments.length} onClick={replaceMatches}>Ersätt alla träffar ({visibleSegments.length} segment)</button></div>
    <p className="ts-muted">Sökningen är exakt och skiljer på stora och små bokstäver. Ersättning ändrar endast översättningar som matchar filtren, över alla sidor. Granska och spara efteråt.</p>
    <label className="ts-check"><input type="checkbox" checked={reviewOnly} onChange={(e) => { setReviewOnly(e.target.checked); setPage(0); }} /><span>Visa bara segment som behöver granskas ({pendingIds.size} osäkra källsegment)</span></label>
    {playingSegment && <div className="ts-segment-player"><strong>{playingSegment.id} · {playingSegment.translated ? "Genererat AI-segment (före tidsanpassning)" : "Originalsegment"}</strong><audio key={playingSegment.sequence} ref={segmentPlayer} aria-label="Spela valt segment" controls autoPlay src={playingSegment.translated ? segmentUrl(job.id, target, playingSegment.id, job.revision) : originalPreviewUrl(job.id, target)} onLoadedMetadata={(e) => { e.currentTarget.currentTime = playingSegment.translated ? 0 : playingSegment.start; }} onTimeUpdate={(e) => { if (!playingSegment.translated && e.currentTarget.currentTime >= playingSegment.end) e.currentTarget.pause(); }} onError={() => setError("Segmentet kunde inte spelas. Spara, regenerera eller använd originalspelaren.")} /></div>}
    <div className="ts-speakers">{speakers.map((speaker) => <label key={speaker}>Röst för {speaker}<select disabled={!editable || job.options.mode === "subtitles" || job.options.preserveVoice} value={voices[speaker] || ""} onChange={(e) => { const next = { ...historyRef.current.present.voices }; if (e.target.value) next[speaker] = e.target.value; else delete next[speaker]; change({ ...historyRef.current.present, voices: next }); }}><option value="">Automatisk, konsekvent tilldelning</option>{availableVoices.map((voice) => <option key={voice}>{voice}</option>)}</select></label>)}</div>
    {!!caps?.asrModels?.length && <fieldset><legend>Jämför akustisk transkription</legend><div className="ts-export-row"><label>Installerad ASR-modell<select value={asrModel || caps.asrModels[0].id} disabled={!editable} onChange={(event) => setAsrModel(event.target.value)}>{caps.asrModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label><label className="ts-check"><input type="checkbox" checked={denoise} disabled={!editable} onChange={(event) => setDenoise(event.target.checked)} /><span>Brusreducera jämförelseprovet</span></label></div><p className="ts-muted">Spara utkastet först och välj sedan ”Jämför ASR” på ett segment. Originalets råa transkription bevaras. Modellresultat är förslag som du måste kontrollera genom att lyssna.</p></fieldset>}
    {error && <p className="ts-alert" role="alert">{error}</p>}
    <div className="ts-segments">{visibleSegments.slice(page * 30, page * 30 + 30).map((s) => {
      const draft = drafts[s.id]; const t = translated.get(s.id); if (!draft) return null;
      const update = (value: Partial<typeof draft>) => { const present = historyRef.current.present; change({ ...present, segments: { ...present.segments, [s.id]: { ...present.segments[s.id], ...value } } }); };
      return <article key={s.id} className={`ts-segment ${s.uncertain || t?.timing?.review ? "ts-needs-review" : ""}`}>
        <div className="ts-segment-time"><strong>{s.id}</strong><button className="ts-button" onClick={() => { playSegment({ id: s.id, translated: false, start: draft.start, end: draft.end }); }}><Play size={14} />Spela original {s.id}</button><button className="ts-button" disabled={!job.segmentOutputs?.[target]?.[s.id] || draft.text !== t?.text || draft.original !== s.text || draft.start !== s.start || draft.end !== s.end} onClick={() => { playSegment({ id: s.id, translated: true, start: 0, end: 0 }); }}><Play size={14} />Spela översättning {s.id}</button><button className="ts-button" disabled={!editable || busy || !draft.text || pendingIds.has(s.id)} onClick={() => void save(s.id)}><RefreshCw size={14} />Regenerera {s.id} & export</button>{pendingIds.has(s.id) ? <button className="ts-button" disabled={!editable || busy || hasDraftChanges} onClick={() => void approve(s.id)}><Check size={14} />Godkänn källa {s.id}</button> : s.uncertain && <small>Källsegment granskat</small>}<label>Start (s)<input type="number" min="0" step="0.01" value={draft.start} disabled={!editable} onChange={(e) => update({ start: Number(e.target.value) })} /></label><label>Slut (s)<input type="number" min="0" step="0.01" value={draft.end} disabled={!editable} onChange={(e) => update({ end: Number(e.target.value) })} /></label><label>Talare<input value={draft.speaker} maxLength={80} disabled={!editable} onChange={(e) => update({ speaker: e.target.value })} /></label></div>
        <div><label>Original {pendingIds.has(s.id) && <span className="ts-warning">· osäkert / överlapp</span>}<textarea aria-label={`Original ${s.id}`} dir="auto" maxLength={4000} value={draft.original} disabled={!editable} onChange={(e) => update({ original: e.target.value })} /></label>{!!caps?.asrModels?.length && <button className="ts-button" disabled={!editable || hasDraftChanges} onClick={() => void compareAsr(s.id)}>{comparing === s.id ? "Transkriberar igen…" : `Jämför ASR ${s.id}`}</button>}<details><summary>Rå ASR & ändringar {s.id}</summary><p dir="auto">{s.rawText || s.text}</p>{s.asrAlternatives?.map((a, index) => <div key={`${a.model}-${index}`}><p dir="auto">{a.model}: {a.text} · {Math.round(a.disagreement * 100)} % textavvikelse (inget facit)</p><button className="ts-button" disabled={!editable || !a.text.trim()} onClick={() => update({ original: a.text })}>Använd som källutkast · {a.model}</button></div>)}{job.sourceEdits?.filter((edit) => edit.id === s.id).map((edit, n) => <div key={n}><time>{edit.at}</time><p dir="auto">{edit.before.text} → {edit.after.text}</p><small>{edit.before.start}–{edit.before.end} s → {edit.after.start}–{edit.after.end} s</small></div>)}</details>{s.codeSwitch && <p className="ts-muted">Möjlig kodväxling: arabiska och latinsk skrift. Lyssna på låneord och namn.</p>}{s.confidence !== undefined && <p className="ts-muted">ASR-signal: {s.confidence < 0.5 ? "låg" : s.confidence < 0.8 ? "måttlig" : "hög"} (modellskattning). Kontrollera mot originalet.</p>}{!!s.qualityReasons?.length && <p className="ts-warning">Granskningsorsak: {s.qualityReasons.join(" · ")}</p>}{s.words?.some((w) => w.uncertain || (w.probability !== undefined && w.probability < 0.55)) && <p dir="auto" className="ts-word-confidence">{s.words.map((w, i) => { const uncertain = w.uncertain || (w.probability !== undefined && w.probability < 0.55); return uncertain ? <mark key={i}><button title={`Spela osäkert ord · ${w.start.toFixed(2)}–${w.end.toFixed(2)} s`} onClick={() => { playSegment({ id: `${s.id}-w${i}`, translated: false, start: Math.max(s.start, w.start - 0.15), end: Math.min(s.end, w.end + 0.15) }); }}>{w.word}{" "}</button></mark> : <span key={i}>{w.word}{" "}</span>; })}</p>}<label>Översättning ({target})<textarea aria-label={`Översättning (${target})`} dir="auto" maxLength={4000} value={draft.text} disabled={!editable} placeholder="Skriv eller rätta översättningen" onChange={(e) => update({ text: e.target.value })} /></label>{t?.reviewRequired && <p className="ts-warning">{t.reviewMessage || "Kontrollera översättningens innehåll och spara en rättelse."}</p>}{t?.timing && <p className={t.timing.review ? "ts-warning" : "ts-muted"}>Tal {t.timing.generated.toFixed(2)} s · fönster {t.timing.window.toFixed(2)} s · tempo ×{t.timing.tempo.toFixed(2)} · överskridande {t.timing.deviationMs} ms {t.timing.review ? "· behöver justeras" : "· ryms"}</p>}</div>
      </article>;
    })}</div>
    {visibleSegments.length > 30 && <div className="ts-row"><button className="ts-button" disabled={!page} onClick={() => setPage((p) => p - 1)}>Föregående</button><span>Sida {page + 1} av {Math.ceil(visibleSegments.length / 30)}</span><button className="ts-button" disabled={(page + 1) * 30 >= visibleSegments.length} onClick={() => setPage((p) => p + 1)}>Nästa</button></div>}
  </section>;
}
