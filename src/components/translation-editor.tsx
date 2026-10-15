"use client";
import { useRef, useState } from "react";
import { Save } from "lucide-react";
import { fileUrl, jsonRequest } from "@/lib/translation/client";
import type { Capabilities, Job } from "@/lib/translation/types";

export function TranslationPlayer({ job, target }: { job: Job; target: string }) {
  const [translated, setTranslated] = useState(false); const [position, setPosition] = useState(0); const [playError, setPlayError] = useState("");
  const media = useRef<HTMLMediaElement | null>(null); const pending = useRef<{ time: number; play: boolean } | null>(null);
  const hasTranslation = job.outputs[target]?.includes("wav") || job.outputs[target]?.includes("mp4");
  const actualTranslated = translated && hasTranslation;
  function change(value: boolean) { pending.current = { time: media.current?.currentTime || 0, play: media.current ? !media.current.paused : false }; setTranslated(value); }
  const url = fileUrl(job.id, target, job.media?.video ? "mp4" : "wav", !actualTranslated);
  const props = { src: url, controls: true, preload: "metadata", onTimeUpdate: () => setPosition(media.current?.currentTime || 0), onError: () => setPlayError("Webbläsaren kan inte spela denna kodek. Prova den exporterade MP4-/WAV-filen i en kompatibel spelare."), onLoadedMetadata: () => { setPlayError(""); if (pending.current && media.current) { media.current.currentTime = Math.min(pending.current.time, media.current.duration || 0); if (pending.current.play) void media.current.play().catch(() => undefined); pending.current = null; } } };
  return <section className="ts-card ts-preview">
    <div className="ts-row"><h2>Förhandsgranskning</h2><div className="ts-toggle"><button aria-pressed={!actualTranslated} onClick={() => change(false)}>Original</button><button disabled={!hasTranslation || job.options.mode === "subtitles"} aria-pressed={!!actualTranslated} onClick={() => change(true)}>Översatt AI-tal</button></div></div>
    {job.media?.video ? <video ref={(node) => { media.current = node; }} {...props} playsInline /> : <audio ref={(node) => { media.current = node; }} {...props} />}
    {playError && <p className="ts-alert" role="alert">{playError}</p>}
    {job.media && <><button className="ts-waveform" aria-label="Sök i ljudvågformen" onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (media.current) media.current.currentTime = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * job.media!.duration; }} onKeyDown={(event) => { if (media.current && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); media.current.currentTime = Math.max(0, Math.min(job.media!.duration, media.current.currentTime + (event.key === "ArrowRight" ? 5 : -5))); } }}>
      <svg viewBox="0 0 1000 96" preserveAspectRatio="none" aria-hidden="true">{job.media.waveform.map((amplitude, n) => <line key={n} x1={n * 1000 / job.media!.waveform.length} x2={n * 1000 / job.media!.waveform.length} y1={48 - Math.max(1, amplitude * 44)} y2={48 + Math.max(1, amplitude * 44)} stroke={n / job.media!.waveform.length <= position / job.media!.duration ? "#bdf58c" : "#53684b"} />)}<line x1={position / job.media.duration * 1000} x2={position / job.media.duration * 1000} y1="0" y2="96" stroke="#f5f6ef" /></svg>
    </button><div className="ts-row ts-muted"><span>{position.toFixed(1)} / {job.media.duration.toFixed(1)} s</span><span>{job.media.sampleRate} Hz · {job.media.channels} kanaler · källa</span></div></>}
    <p className="ts-muted">Växling behåller tidspositionen. Ljudvågformen visar originalet. Genererade röster är AI-skapade.</p>
  </section>;
}

export function TranslationEditor({ job, target, caps, onSaved }: { job: Job; target: string; caps?: Capabilities; onSaved: (job: Job) => void }) {
  const translated = new Map((job.translations[target] || []).map((t) => [t.id, t]));
  const [drafts, setDrafts] = useState(() => Object.fromEntries(job.segments.map((s) => [s.id, { id: s.id, target, start: s.start, end: s.end, speaker: s.speaker, text: translated.get(s.id)?.text || "", original: s.text }])));
  const [voices, setVoices] = useState(job.options.speakerVoices); const [page, setPage] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const editable = ["paused", "failed", "review", "completed"].includes(job.status); const speakers = [...new Set(job.segments.map((s) => s.speaker))];
  async function save() {
    setBusy(true); setError("");
    try {
      const originals = new Map(job.segments.map((s) => [s.id, s]));
      const edits = Object.values(drafts).filter((d) => { const s = originals.get(d.id)!; return d.text !== (translated.get(d.id)?.text || "") || d.original !== s.text || d.start !== s.start || d.end !== s.end || d.speaker !== s.speaker; });
      const voicesChanged = JSON.stringify(voices) !== JSON.stringify(job.options.speakerVoices);
      if (!edits.length && !voicesChanged) { setError("Inga ändringar att spara."); return; }
      if (!edits.length) edits.push(Object.values(drafts)[0]);
      onSaved(await jsonRequest(`/api/translation/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "edit", edits, speakerVoices: voices }) }));
    }
    catch (e) { setError(e instanceof Error ? e.message : "Ändringarna kunde inte sparas."); } finally { setBusy(false); }
  }
  return <section className="ts-card ts-editor">
    <div className="ts-row"><div><span className="ts-eyebrow">TRANSKRIPT & ÖVERSÄTTNING</span><h2>{job.segments.length} tidsatta segment</h2></div><button className="ts-button" disabled={!editable || busy} onClick={() => void save()}><Save size={16} />Spara ändringar</button></div>
    <p className="ts-muted">Pausa för att redigera. Spara och återuppta för att uppdatera ljudexporten. Tider och talaridentiteter delas mellan alla målspråk.</p>
    <div className="ts-speakers">{speakers.map((speaker) => <label key={speaker}>Röst för {speaker}<select disabled={!editable} value={voices[speaker] || ""} onChange={(e) => setVoices((v) => { const next = { ...v }; if (e.target.value) next[speaker] = e.target.value; else delete next[speaker]; return next; })}><option value="">Automatisk, konsekvent tilldelning</option>{caps?.voices.map((voice) => <option key={voice}>{voice}</option>)}</select></label>)}</div>
    {error && <p className="ts-alert" role="alert">{error}</p>}
    <div className="ts-segments">{job.segments.slice(page * 30, page * 30 + 30).map((s) => {
      const draft = drafts[s.id]; const t = translated.get(s.id); if (!draft) return null;
      const update = (value: Partial<typeof draft>) => setDrafts((v) => ({ ...v, [s.id]: { ...v[s.id], ...value } }));
      return <article key={s.id} className={`ts-segment ${t?.timing?.review ? "ts-needs-review" : ""}`}>
        <div className="ts-segment-time"><strong>{s.id}</strong><label>Start (s)<input type="number" min="0" step="0.01" value={draft.start} disabled={!editable} onChange={(e) => update({ start: Number(e.target.value) })} /></label><label>Slut (s)<input type="number" min="0" step="0.01" value={draft.end} disabled={!editable} onChange={(e) => update({ end: Number(e.target.value) })} /></label><label>Talare<input value={draft.speaker} maxLength={80} disabled={!editable} onChange={(e) => update({ speaker: e.target.value })} /></label></div>
        <div><label>Original {s.uncertain && <span className="ts-warning">· osäkert / överlapp</span>}<textarea dir="auto" value={draft.original} disabled={!editable} onChange={(e) => update({ original: e.target.value })} /></label><label>Översättning ({target})<textarea dir="auto" value={draft.text} disabled={!editable || !t} onChange={(e) => update({ text: e.target.value })} /></label>{t?.timing && <p className={t.timing.review ? "ts-warning" : "ts-muted"}>Tal {t.timing.generated.toFixed(2)} s · fönster {t.timing.window.toFixed(2)} s · tempo ×{t.timing.tempo.toFixed(2)} · överskridande {t.timing.deviationMs} ms {t.timing.review ? "· behöver justeras" : "· ryms"}</p>}</div>
      </article>;
    })}</div>
    {job.segments.length > 30 && <div className="ts-row"><button className="ts-button" disabled={!page} onClick={() => setPage((p) => p - 1)}>Föregående</button><span>Sida {page + 1} av {Math.ceil(job.segments.length / 30)}</span><button className="ts-button" disabled={(page + 1) * 30 >= job.segments.length} onClick={() => setPage((p) => p + 1)}>Nästa</button></div>}
  </section>;
}
