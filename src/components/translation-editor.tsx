"use client";
import { useRef, useState } from "react";
import { Save } from "lucide-react";
import { fileUrl, jsonRequest } from "@/lib/translation/client";
import type { Capabilities, Job } from "@/lib/translation/types";

export function TranslationPlayer({ job, target }: { job: Job; target: string }) {
  const [translated, setTranslated] = useState(false); const [position, setPosition] = useState(0); const [playError, setPlayError] = useState("");
  const original = useRef<HTMLMediaElement | null>(null); const output = useRef<HTMLMediaElement | null>(null);
  const hasTranslation = !!job.outputs[target]?.includes(job.media?.video ? "mp4" : "wav");
  const media = translated && hasTranslation ? output : original;
  const outputLabel = job.options.mode === "subtitles" ? "Översatta undertexter" : "Översatt AI-tal";
  function change(value: boolean) {
    const previous = media.current; const next = value ? output.current : original.current;
    const play = previous ? !previous.paused : false; const time = previous?.currentTime || 0;
    previous?.pause(); setTranslated(value);
    if (next?.readyState) { next.currentTime = Math.min(time, Number.isFinite(next.duration) ? next.duration : time); if (play) void next.play().catch(() => setPlayError("Tryck på play i spelaren för att starta ljudet.")); }
    setPosition(time);
  }
  function renderPlayer(isOutput: boolean) {
    const ref = isOutput ? output : original; const other = isOutput ? original : output;
    const props = { src: fileUrl(job.id, target, job.media?.video ? "mp4" : "wav", !isOutput), controls: true, preload: "metadata", "aria-label": isOutput ? outputLabel : "Originalinspelning", onPlay: () => { other.current?.pause(); setTranslated(isOutput); }, onTimeUpdate: () => { if (ref.current && !ref.current.paused) setPosition(ref.current.currentTime); }, onSeeked: () => setPosition(ref.current?.currentTime || 0), onError: () => setPlayError("Webbläsaren kan inte spela denna kodek. Hämta filen och använd en kompatibel spelare."), onLoadedMetadata: () => setPlayError("") };
    return job.media?.video ? <video ref={(node) => { ref.current = node; }} {...props} playsInline>{isOutput && job.outputs[target]?.includes("vtt") && <track kind="subtitles" src={fileUrl(job.id, target, "vtt")} srcLang={target} label={`Översättning (${target})`} default />}</video> : <audio ref={(node) => { ref.current = node; }} {...props} />;
  }
  return <section className="ts-card ts-preview">
    <div className="ts-row"><h2>Förhandsgranskning</h2><div className="ts-toggle"><button aria-pressed={!translated} onClick={() => change(false)}>Original</button><button disabled={!hasTranslation} aria-pressed={translated} onClick={() => change(true)}>{outputLabel}</button></div></div>
    <div className="ts-media-comparison"><div><h3>Original</h3>{renderPlayer(false)}</div><div><h3>{outputLabel} ({target})</h3>{hasTranslation ? renderPlayer(true) : <p className="ts-muted">{job.options.mode === "subtitles" ? "Undertextläget behåller originalets ljud. Hämta översättningen som SRT eller VTT via Exportformat när den är klar." : "Uppspelning visas när bearbetningen är klar. Granska osäkra segment innan dubbningen fortsätter."}</p>}</div></div>
    {playError && <p className="ts-alert" role="alert">{playError}</p>}
    {job.media && <><button className="ts-waveform" aria-label="Sök i ljudvågformen" onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (media.current) media.current.currentTime = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * job.media!.duration; }} onKeyDown={(event) => { if (media.current && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); media.current.currentTime = Math.max(0, Math.min(job.media!.duration, media.current.currentTime + (event.key === "ArrowRight" ? 5 : -5))); } }}>
      <svg viewBox="0 0 1000 96" preserveAspectRatio="none" aria-hidden="true">{job.media.waveform.map((amplitude, n) => <line key={n} x1={n * 1000 / job.media!.waveform.length} x2={n * 1000 / job.media!.waveform.length} y1={48 - Math.max(1, amplitude * 44)} y2={48 + Math.max(1, amplitude * 44)} stroke={n / job.media!.waveform.length <= position / job.media!.duration ? "#bdf58c" : "#53684b"} />)}<line x1={position / job.media.duration * 1000} x2={position / job.media.duration * 1000} y1="0" y2="96" stroke="#f5f6ef" /></svg>
    </button><div className="ts-row ts-muted"><span>{position.toFixed(1)} / {job.media.duration.toFixed(1)} s</span><span>{job.media.sampleRate} Hz · {job.media.channels} kanaler · källa</span></div></>}
    <p className="ts-muted">Växling behåller tidspositionen. Ljudvågformen visar originalet. Genererade röster är AI-skapade.</p>
  </section>;
}

export function TranslationEditor({ job, target, caps, onSaved, onDirty }: { job: Job; target: string; caps?: Capabilities; onSaved: (job: Job) => void; onDirty?: (dirty: boolean) => void }) {
  const translated = new Map((job.translations[target] || []).map((t) => [t.id, t]));
  const [drafts, setDrafts] = useState(() => Object.fromEntries(job.segments.map((s) => [s.id, { id: s.id, target, start: s.start, end: s.end, speaker: s.speaker, text: translated.get(s.id)?.text || "", original: s.text }])));
  const [voices, setVoices] = useState(job.options.speakerVoices); const [page, setPage] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const editable = ["paused", "failed", "review", "completed"].includes(job.status); const speakers = [...new Set(job.segments.map((s) => s.speaker))];
  const availableVoices = caps?.voices.filter((v) => v !== "xtts" && job.options.targets.every((t) => !caps.voiceLanguages[v] || caps.voiceLanguages[v].includes(t)) && (!job.options.targets.includes("en") || !caps.voiceLocales?.[v] || caps.voiceLocales[v] === job.options.englishLocale)) || [];
  async function save() {
    setBusy(true); setError("");
    try {
      const originals = new Map(job.segments.map((s) => [s.id, s]));
      const edits = Object.values(drafts).filter((d) => { const s = originals.get(d.id)!; return d.text !== (translated.get(d.id)?.text || "") || d.original !== s.text || d.start !== s.start || d.end !== s.end || d.speaker !== s.speaker; });
      const voicesChanged = JSON.stringify(voices) !== JSON.stringify(job.options.speakerVoices);
      if (!edits.length && !voicesChanged) { setError("Inga ändringar att spara."); return; }
      if (!edits.length) edits.push(Object.values(drafts)[0]);
      onSaved(await jsonRequest(`/api/translation/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "edit", edits, ...(voicesChanged ? { speakerVoices: voices } : {}) }) }));
    }
    catch (e) { setError(e instanceof Error ? e.message : "Ändringarna kunde inte sparas."); } finally { setBusy(false); }
  }
  return <section className="ts-card ts-editor">
    <div className="ts-row"><div><span className="ts-eyebrow">TRANSKRIPT & ÖVERSÄTTNING</span><h2>{job.segments.length} tidsatta segment</h2></div><button className="ts-button" disabled={!editable || busy} onClick={() => void save()}><Save size={16} />Spara ändringar</button></div>
    <p className="ts-muted">Pausa för att redigera. Spara och återuppta för att uppdatera ljudexporten. Rättad källtext översätts på nytt; oförändrade ljudsegment återanvänds. Tider och talaridentiteter delas mellan alla målspråk.</p>
    <div className="ts-speakers">{speakers.map((speaker) => <label key={speaker}>Röst för {speaker}<select disabled={!editable || job.options.mode === "subtitles" || job.options.preserveVoice} value={voices[speaker] || ""} onChange={(e) => { onDirty?.(true); setVoices((v) => { const next = { ...v }; if (e.target.value) next[speaker] = e.target.value; else delete next[speaker]; return next; }); }}><option value="">Automatisk, konsekvent tilldelning</option>{availableVoices.map((voice) => <option key={voice}>{voice}</option>)}</select></label>)}</div>
    {error && <p className="ts-alert" role="alert">{error}</p>}
    <div className="ts-segments">{job.segments.slice(page * 30, page * 30 + 30).map((s) => {
      const draft = drafts[s.id]; const t = translated.get(s.id); if (!draft) return null;
      const update = (value: Partial<typeof draft>) => { onDirty?.(true); setDrafts((v) => ({ ...v, [s.id]: { ...v[s.id], ...value } })); };
      return <article key={s.id} className={`ts-segment ${s.uncertain || t?.timing?.review ? "ts-needs-review" : ""}`}>
        <div className="ts-segment-time"><strong>{s.id}</strong><label>Start (s)<input type="number" min="0" step="0.01" value={draft.start} disabled={!editable} onChange={(e) => update({ start: Number(e.target.value) })} /></label><label>Slut (s)<input type="number" min="0" step="0.01" value={draft.end} disabled={!editable} onChange={(e) => update({ end: Number(e.target.value) })} /></label><label>Talare<input value={draft.speaker} maxLength={80} disabled={!editable} onChange={(e) => update({ speaker: e.target.value })} /></label></div>
        <div><label>Original {s.uncertain && <span className="ts-warning">· osäkert / överlapp</span>}<textarea dir="auto" value={draft.original} disabled={!editable} onChange={(e) => update({ original: e.target.value })} /></label>{s.confidence !== undefined && <p className="ts-muted">ASR-signal: {s.confidence < 0.5 ? "låg" : s.confidence < 0.8 ? "måttlig" : "hög"} (modellskattning). Kontrollera mot originalet.</p>}{!!s.qualityReasons?.length && <p className="ts-warning">Granskningsorsak: {s.qualityReasons.join(" · ")}</p>}{s.words?.some((w) => w.uncertain || (w.probability !== undefined && w.probability < 0.55)) && <p dir="auto" className="ts-word-confidence">{s.words.map((w, i) => { const uncertain = w.uncertain || (w.probability !== undefined && w.probability < 0.55); return uncertain ? <mark key={i} title={`Osäkert ord · ${w.start.toFixed(2)}–${w.end.toFixed(2)} s`}>{w.word}{" "}</mark> : <span key={i}>{w.word}{" "}</span>; })}</p>}<label>Översättning ({target})<textarea dir="auto" value={draft.text} disabled={!editable} placeholder="Skriv eller rätta översättningen" onChange={(e) => update({ text: e.target.value })} /></label>{t?.timing && <p className={t.timing.review ? "ts-warning" : "ts-muted"}>Tal {t.timing.generated.toFixed(2)} s · fönster {t.timing.window.toFixed(2)} s · tempo ×{t.timing.tempo.toFixed(2)} · överskridande {t.timing.deviationMs} ms {t.timing.review ? "· behöver justeras" : "· ryms"}</p>}</div>
      </article>;
    })}</div>
    {job.segments.length > 30 && <div className="ts-row"><button className="ts-button" disabled={!page} onClick={() => setPage((p) => p - 1)}>Föregående</button><span>Sida {page + 1} av {Math.ceil(job.segments.length / 30)}</span><button className="ts-button" disabled={(page + 1) * 30 >= job.segments.length} onClick={() => setPage((p) => p + 1)}>Nästa</button></div>}
  </section>;
}
