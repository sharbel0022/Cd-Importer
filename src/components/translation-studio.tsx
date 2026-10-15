"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, AudioLines, Check, Download, FileAudio, Languages, LoaderCircle, Mic, Pause, Play, Plus, Radio, ShieldCheck, Square, Trash2, UploadCloud, X } from "lucide-react";
import { EDITOR_DRAFT_PREFIX } from "@/lib/translation/editor-draft";
import { fileUrl, jsonRequest } from "@/lib/translation/client";
import { EXTENSIONS, LANGUAGES, pendingSourceSegments, type Capabilities, type Job, type StudioOptions } from "@/lib/translation/types";
import TranslationLive from "./translation-live";
import TranslationProjectActions from "./translation-project-actions";
import TranslationRenderSettings from "./translation-render-settings";
import TranslationGlossary from "./translation-glossary";
import TranslationVoicePreview from "./translation-voice-preview";
import { TranslationEditor, TranslationPlayer } from "./translation-editor";

type Summary = Pick<Job, "id" | "name" | "status" | "stage" | "createdAt" | "message"> & { targets: string[] };
const stages = [["uploading", "Uppladdning"], ["transcribing", "Transkriberar ljud"], ["translating", "Översätter text"], ["generating", "Genererar röst"], ["synchronizing", "Anpassar ljudet"], ["exporting", "Förbereder förhandsvisning"], ["completed", "Klar för uppspelning"]];
const statusLabels: Record<string, string> = { queued: "I kö", running: "Bearbetas", paused: "Pausat", cancelled: "Avbrutet", failed: "Fel", review: "Granskning krävs", completed: "Klart" };
const defaultOptions: StudioOptions = { source: "auto", targets: ["en"], englishLocale: "en-US", speechRate: 1, translationMode: "faithful", style: "natural", mode: "replace", voice: "auto", speakerVoices: {}, diarize: false, preserveBackground: false, preserveVoice: false, voiceConsent: false, rights: true, cloudConsent: false };
const languageEntries = Object.entries(LANGUAGES).sort(([a], [b]) => (["en", "sv", "ar"].indexOf(a) + 1 || 99) - (["en", "sv", "ar"].indexOf(b) + 1 || 99));
function languageLabel(code: string, locale = "en-US") { return code === "en" ? locale === "en-GB" ? "English (UK)" : "English (US)" : LANGUAGES[code as keyof typeof LANGUAGES] || code; }
export default function TranslationStudio() {
  const [caps, setCaps] = useState<Capabilities>(); const [options, setOptions] = useState(defaultOptions); const [rights, setRights] = useState(false);
  const [mode, setMode] = useState<"file" | "live">("file"); const [file, setFile] = useState<File>(); const [job, setJob] = useState<Job>(); const [selected, setSelected] = useState("");
  const [jobSearch, setJobSearch] = useState("");
  const [jobs, setJobs] = useState<Summary[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [controlling, setControlling] = useState(false); const [progress, setProgress] = useState<number>(); const [preferred, setPreferred] = useState("en"); const [recording, setRecording] = useState(false);
  const [format, setFormat] = useState("wav"); const picker = useRef<HTMLInputElement>(null); const upload = useRef<XMLHttpRequest | null>(null);
  const [fileDuration, setFileDuration] = useState<number>();
  const [editorDirty, setEditorDirty] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null); const microphone = useRef<MediaStream | null>(null); const recordTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const openingMicrophone = useRef(false);
  const target = job?.options.targets.includes(preferred) ? preferred : job?.options.targets[0] || preferred;
  useEffect(() => { setEditorDirty(false); }, [selected, target, job?.revision]);
  const refresh = useCallback(async () => { const [c, j] = await Promise.all([jsonRequest<Capabilities>("/api/translation/status"), jsonRequest<Summary[]>("/api/translation/jobs")]); setCaps(c); setJobs(j); }, []);
  useEffect(() => { void refresh().catch((e) => setError(e.message)); const timer = setInterval(() => { void refresh().catch(() => undefined); }, 10000); const id = new URLSearchParams(location.search).get("job"); if (id) setSelected(id); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (!selected) return; const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() { try { const next = await jsonRequest<Job>(`/api/translation/jobs/${selected}`, { signal: abort.signal }); setJob(next); if (["running", "queued"].includes(next.status)) timer = setTimeout(() => void poll(), 1500); } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Jobbet kunde inte läsas."); } }
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [selected, job?.status]);
  const voices = caps?.voices.filter((voice) => (voice !== "xtts" || options.preserveVoice) && options.targets.every((target) => !caps.voiceLanguages[voice] || caps.voiceLanguages[voice].includes(target)) && (!options.targets.includes("en") || !caps.voiceLocales?.[voice] || caps.voiceLocales[voice] === options.englishLocale)) || [];
  const voiceSupported = options.voice === "auto" || voices.includes(options.voice);
  useEffect(() => { if (caps && !voiceSupported) setOptions((o) => ({ ...o, voice: "auto" })); }, [caps, voiceSupported]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; upload.current?.abort(); if (recorder.current?.state === "recording") recorder.current.stop(); microphone.current?.getTracks().forEach((t) => t.stop()); clearTimeout(recordTimer.current); }; }, []);
  useEffect(() => {
    setFileDuration(undefined);
    if (!file) return;
    const url = URL.createObjectURL(file); const media = document.createElement("video");
    media.preload = "metadata";
    media.onloadedmetadata = () => { if (Number.isFinite(media.duration)) setFileDuration(media.duration); };
    media.src = url;
    return () => { media.onloadedmetadata = null; media.removeAttribute("src"); media.load(); URL.revokeObjectURL(url); };
  }, [file]);
  function chooseFile(value?: File) { if (!value) return; setError(""); const ext = value.name.split(".").pop()?.toLowerCase() || ""; if (!EXTENSIONS[ext]) { setError("Filformatet stöds inte. Välj ett ljud- eller videoformat från listan."); return; } if (!value.size || value.size > (caps?.maxUploadMb || 500) * 1024 ** 2) { setError("Filen är tom eller överskrider uppladdningsgränsen."); return; } setFile(value); }
  async function record() {
    if (openingMicrophone.current) return;
    if (recording) { recorder.current?.stop(); microphone.current?.getTracks().forEach((t) => t.stop()); return; }
    openingMicrophone.current = true;
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Mikrofonen kräver HTTPS eller localhost.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: false } }); if (!alive.current) { stream.getTracks().forEach((t) => t.stop()); return; } microphone.current = stream;
      const mime = ["audio/webm;codecs=opus", "audio/mp4"].find((v) => MediaRecorder.isTypeSupported(v)); if (!mime) throw new Error("Webbläsaren saknar ett inspelningsformat som stöds.");
      const rec = new MediaRecorder(stream, { mimeType: mime }); recorder.current = rec; const parts: Blob[] = []; let size = 0;
      rec.ondataavailable = (e) => { if (e.data.size) { parts.push(e.data); size += e.data.size; if (size > 20 * 1024 ** 2 && rec.state === "recording") rec.stop(); } };
      rec.onstop = () => { clearTimeout(recordTimer.current); stream.getTracks().forEach((t) => t.stop()); setRecording(false); if (parts.length) chooseFile(new File(parts, `mikrofon-${Date.now()}.${mime.startsWith("audio/mp4") ? "m4a" : "webm"}`, { type: mime })); };
      rec.onerror = () => { setError("Inspelningen misslyckades."); stream.getTracks().forEach((t) => t.stop()); setRecording(false); };
      rec.start(1000); setRecording(true); recordTimer.current = setTimeout(() => { if (rec.state === "recording") rec.stop(); }, 600000);
    } catch (e) { microphone.current?.getTracks().forEach((t) => t.stop()); setError(e instanceof Error ? e.message : "Mikrofonen kunde inte öppnas."); }
    finally { openingMicrophone.current = false; }
  }
  async function startJob() {
    if (!file || upload.current || !alive.current) return; setBusy(true); setError(""); setProgress(0);
    let cancelled = false;
    try {
      const token = await new Promise<string>((resolve, reject) => {
        const preflight = new XMLHttpRequest(); upload.current = preflight; preflight.open("POST", "/api/translation/options"); preflight.setRequestHeader("Content-Type", "application/json");
        preflight.onload = () => { try { const body = JSON.parse(preflight.responseText); if (preflight.status < 200 || preflight.status >= 300) reject(new Error(body.error || `HTTP ${preflight.status}`)); else if (typeof body.token !== "string") reject(new Error("Servern saknar en giltig uppladdningstoken.")); else resolve(body.token); } catch { reject(new Error("Servern returnerade ett ogiltigt svar.")); } };
        preflight.onerror = () => reject(new Error("Översättningsinställningarna kunde inte förberedas.")); preflight.onabort = () => { cancelled = true; reject(new Error("Uppladdningen avbröts.")); }; preflight.send(JSON.stringify({ ...options, rights }));
      });
      if (cancelled || !alive.current) return;
      const result = await new Promise<Job>((resolve, reject) => {
        if (cancelled || !alive.current) { reject(new Error("Uppladdningen avbröts.")); return; }
        const xhr = new XMLHttpRequest(); upload.current = xhr; xhr.open("POST", "/api/translation/jobs"); xhr.setRequestHeader("Content-Type", "application/octet-stream"); xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name)); xhr.setRequestHeader("x-studio-options-token", token);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(Math.round(e.loaded / e.total * 100)); };
        xhr.onload = () => { try { const body = JSON.parse(xhr.responseText); if (xhr.status < 200 || xhr.status >= 300) reject(new Error(body.error || `HTTP ${xhr.status}`)); else resolve(body); } catch { reject(new Error("Servern returnerade ett ogiltigt svar.")); } };
        xhr.onerror = () => reject(new Error("Uppladdningen misslyckades.")); xhr.onabort = () => { cancelled = true; reject(new Error("Uppladdningen avbröts.")); }; xhr.send(file);
      });
      if (cancelled || !alive.current) return;
      setSelected(result.id); setJob(result); history.replaceState(null, "", `?job=${result.id}`); await refresh();
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Jobbet kunde inte startas."); } finally { if (alive.current) { setBusy(false); setProgress(undefined); } upload.current = null; }
  }
  async function control(action: "pause" | "resume" | "cancel" | "approve-source") {
    if (!job || controlling) return; setError(""); setControlling(true);
    try { const next = await jsonRequest<Job>(`/api/translation/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }); setJob(next); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Jobbkontrollen misslyckades."); } finally { setControlling(false); }
  }
  async function remove() { if (!job) return; try { await jsonRequest(`/api/translation/jobs/${job.id}`, { method: "DELETE" }); try { for (const key of Object.keys(localStorage)) if (key.startsWith(`${EDITOR_DRAFT_PREFIX}${job.id}:`)) localStorage.removeItem(key); } catch { /* Server data is deleted even if browser storage is unavailable. */ } setSelected(""); setJob(undefined); history.replaceState(null, "", location.pathname); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Radering misslyckades."); } }
  const unsupportedTargets = options.mode !== "subtitles" ? options.targets.filter((code) => caps && !caps.languages.includes(code)) : [];
  const activeReady = options.mode === "subtitles" ? !!caps?.subtitleReady : !!caps?.ready;
  const activeCloud = options.mode === "subtitles" ? !!(caps?.subtitleCloud ?? caps?.cloud) : !!caps?.cloud;
  const missingEnglishAccent = options.mode !== "subtitles" && !options.preserveVoice && options.targets.includes("en") && !!caps?.voiceLocales && caps.voices.some((v) => caps.voiceLocales?.[v]?.startsWith("en-")) && !caps.voices.some((v) => caps.voiceLocales?.[v] === options.englishLocale);
  const canRun = activeReady && rights && (!activeCloud || options.cloudConsent) && !unsupportedTargets.length && !missingEnglishAccent;
  const needsSourceReview = !!job && pendingSourceSegments(job).length > 0;
  const activeFormats = job?.outputs[target] || []; const exportFormat = activeFormats.includes(format) ? format : activeFormats[0];
  return <div className="ts-shell">
    <a href="#translation-main" className="skip-link">Hoppa till studion</a>
    <aside className="ts-sidebar"><a className="brand" href="/"><span className="brand-mark"><i /><i /><i /></span><span className="brand-logo">TON<span className="brand-dot" /></span></a><p className="ts-muted">CD-IMPORTER / STUDIO</p><a className="ts-back" href="/"><ArrowLeft size={16} />Musikbibliotek</a><a className="ts-back" href="/studio/index.html"><AudioLines size={16} />Ljud & noter</a><div className="ts-side-active"><Languages size={18} />AI Translation Studio</div>
      <div className="ts-row"><span className="ts-eyebrow">DINA JOBB</span><button className="ts-icon" aria-label="Nytt projekt" onClick={() => { setSelected(""); setJob(undefined); history.replaceState(null, "", location.pathname); }}><Plus size={17} /></button></div>
      <label>Sök projekt<input type="search" value={jobSearch} onChange={(e) => setJobSearch(e.target.value)} /></label><div className="ts-job-list">{jobs.length ? jobs.filter((item) => item.name.toLocaleLowerCase().includes(jobSearch.toLocaleLowerCase())).map((item) => <button key={item.id} className={selected === item.id ? "ts-job-selected" : ""} onClick={() => { setJob(undefined); setSelected(item.id); history.replaceState(null, "", `?job=${item.id}`); }}><FileAudio size={17} /><span><strong>{item.name}</strong><small>{statusLabels[item.status]} · {item.targets.join(", ")}</small></span></button>) : <p className="ts-muted">Dina översättningar visas här.</p>}</div>
      <div className="ts-sidebar-note"><ShieldCheck size={20} /><strong>Du styr dina medier.</strong><p>Lokala jobb rensas automatiskt. Hämta exporter du vill behålla.</p><a href="/translation/guide" target="_blank" rel="noreferrer">Installation & begränsningar <ArrowRight size={13} /></a></div>
    </aside>
    <main id="translation-main" className="ts-main">
      <header className="ts-topbar"><span>Studio <span>/</span> Tal & översättning</span><span className={`ts-status-dot ${activeReady ? "ts-ready" : ""}`}>{caps?.ready ? "AI konfigurerad" : activeReady ? "Undertexter konfigurerade" : "AI behöver konfigureras"}</span></header>
      <div className="ts-content"><div className="ts-heading"><div><span className="ts-eyebrow"><Languages size={14} /> AI TRANSLATION STUDIO</span><h1>Ge ditt innehåll<br /><em>en ny röst.</em></h1><p>Ladda upp → Välj språk → Översätt → Granska → Förhandsvisa → Ladda ner.<br />Arabiska, svenska och engelska. English (US) är förvalt.</p></div><div className="ts-heading-mark" aria-hidden="true"><AudioLines size={88} strokeWidth={1} /><span>VOICE → VOICE</span></div></div>
      <div className="ts-tabs" role="tablist" aria-label="Översättningsläge"><button role="tab" aria-selected={mode === "file"} disabled={recording} onClick={() => setMode("file")}><FileAudio size={17} />Ljud & video</button><button role="tab" aria-selected={mode === "live"} disabled={recording} onClick={() => { setMode("live"); setOptions((o) => ({ ...o, targets: [o.targets[0]], mode: "replace", preserveVoice: false, voiceConsent: false, preserveBackground: false, diarize: false })); }}><Radio size={17} />Live Translate</button></div>
      <div className={`ts-provider ${activeReady ? "" : "ts-provider-missing"}`} role="status"><ShieldCheck size={19} /><div><strong>{activeReady && !caps?.ready ? "Transkription och översättning är tillgängliga. AI-tal kräver en separat röstmodell." : caps?.message || "Kontrollerar AI-konfiguration…"}</strong><p>{caps ? activeCloud ? "Översättningen använder molnbearbetning med ditt godkännande." : "Lokal AI-bearbetning." : "Kontrollerar tillgänglig bearbetning…"}{options.mode === "subtitles" && " Originalets ljud behålls."}{caps && !caps.worker && " Bearbetningstjänsten är inte startad. Se AI-inställningar."}</p></div><a href="/translation/settings">AI-inställningar <ArrowRight size={14} /></a></div>
      {error && <div className="ts-alert ts-row" role="alert"><span>{error}</span><button className="ts-icon" aria-label="Stäng felmeddelande" onClick={() => setError("")}><X size={16} /></button></div>}
      <div className="ts-grid"><section className="ts-card ts-settings"><div className="ts-card-title"><div><span className="ts-eyebrow">02 / SPRÅK & INSTÄLLNINGAR</span><h2>Språk & uttryck</h2></div><Languages size={23} /></div>
        <label>Källspråk<select value={options.source} disabled={mode === "live" && recording} onChange={(e) => setOptions((o) => ({ ...o, source: e.target.value }))}><option value="auto">Identifiera automatiskt</option>{languageEntries.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
        <label>Målspråk<select aria-label="Målspråk" value={options.targets[0]} onChange={(e) => setOptions((o) => ({ ...o, targets: [e.target.value, ...o.targets.slice(1).filter((t) => t !== e.target.value)] }))}>{languageEntries.filter(([code]) => options.targets.includes(code) || options.mode === "subtitles" || !caps || caps.languages.includes(code)).map(([code]) => <option key={code} value={code}>{languageLabel(code, options.englishLocale)}</option>)}</select></label>
        {options.targets.includes("en") && <label>Engelsk variant<select value={options.englishLocale} onChange={(e) => setOptions((o) => ({ ...o, englishLocale: e.target.value as StudioOptions["englishLocale"] }))}><option value="en-US">English (US)</option><option value="en-GB">English (UK)</option></select><small>Textvariant och önskat uttal. Lokal accent följer den installerade rösten.</small></label>}
        {mode === "file" && <fieldset><legend>Fler målspråk <span>Upp till tre totalt</span></legend><div className="ts-language-chips">{options.targets.slice(1).map((code) => <button key={code} aria-label={`Ta bort ${languageLabel(code, options.englishLocale)}`} onClick={() => setOptions((o) => ({ ...o, targets: o.targets.filter((l) => l !== code) }))}>{languageLabel(code, options.englishLocale)}<X size={12} /></button>)}</div><select aria-label="Lägg till målspråk" value="" onChange={(e) => { const value = e.target.value; if (value) setOptions((o) => ({ ...o, targets: [...o.targets, value] })); }} disabled={options.targets.length >= 3}><option value="">Lägg till språk…</option>{languageEntries.filter(([code]) => !options.targets.includes(code) && (options.mode === "subtitles" || !caps || caps.languages.includes(code))).map(([code]) => <option key={code} value={code}>{languageLabel(code, options.englishLocale)}</option>)}</select></fieldset>}
        {unsupportedTargets.length > 0 && <p className="ts-warning" role="status">AI-tal saknas för {unsupportedTargets.map((t) => languageLabel(t, options.englishLocale)).join(", ")}. Installera en röst eller välj undertextläget.</p>}
        {missingEnglishAccent && <p className="ts-warning" role="status">Ingen installerad röst för {languageLabel("en", options.englishLocale)}. Installera rätt röst eller byt engelsk variant.</p>}
        <label>Översättningsläge<select aria-label="Översättningsläge" value={options.translationMode} onChange={(e) => setOptions((o) => ({ ...o, translationMode: e.target.value as StudioOptions["translationMode"] }))}><option value="faithful">Faithful Translation · bevara vad som sägs</option><option value="natural">Natural Translation · naturligare språk</option><option value="professional">Professional Translation · fackspråk</option><option value="literal">Literal Translation · nära källans struktur</option></select><small>Alla lägen bevarar fakta, namn, siffror, negationer och motsägelser. Faithful behåller även felsägningar och självrättelser.</small></label>
        <TranslationGlossary options={options} onChange={(value) => setOptions((o) => ({ ...o, ...value }))} />
        <label>AI-röst<select disabled={options.mode === "subtitles" || options.preserveVoice} value={options.voice} onChange={(e) => setOptions((o) => ({ ...o, voice: e.target.value }))}><option value="auto">Automatisk röst för målspråket</option>{voices.map((v) => <option key={v} value={v}>{v === "sv-mms-nc" ? "MMS svenska · endast icke-kommersiellt" : [v, caps?.voiceLocales?.[v], caps?.voiceGenders?.[v]].filter(Boolean).join(" · ")}</option>)}</select>{options.preserveVoice && <small>XTTS använder ett rent originalröstprov med ditt bekräftade samtycke.</small>}</label>
        <label>Taltempo ×{options.speechRate.toFixed(2)}<input aria-label="Taltempo" type="range" min="0.85" max="1.2" step="0.05" disabled={options.mode === "subtitles"} value={options.speechRate} onChange={(e) => setOptions((o) => ({ ...o, speechRate: Number(e.target.value) }))} /><small>0,85–1,20 ×. Synkronisering kan behöva justera tempot inom dessa gränser.</small></label>
        <label>Ljudläge<select disabled={mode === "live"} value={options.mode} onChange={(e) => setOptions((o) => ({ ...o, mode: e.target.value as StudioOptions["mode"], preserveBackground: false, preserveVoice: false, voiceConsent: false }))}><option value="replace">Dub · ersätt originaltal</option><option value="voiceover">Voice-over · justerbar originalröst</option><option value="subtitles">Subtitles · original + separata undertexter</option></select></label>
        <label className="ts-check"><input type="checkbox" disabled={!caps?.diarization || mode === "live"} checked={options.diarize} onChange={(e) => setOptions((o) => ({ ...o, diarize: e.target.checked }))} /><span>Identifiera olika talare<small>En konsekvent AI-röst per talar-ID.</small></span></label>
        <label className="ts-check"><input type="checkbox" disabled={!caps?.separation || mode === "live" || options.mode !== "replace"} checked={options.preserveBackground} onChange={(e) => setOptions((o) => ({ ...o, preserveBackground: e.target.checked }))} /><span>Separera och behåll bakgrund<small>{caps?.separation ? "Kan ge artefakter. Lyssna igenom resultatet." : "Kräver lokal Demucs. Annars ersätts hela ljudspåret."}</small></span></label>
        <label className="ts-check"><input type="checkbox" disabled={!caps?.cloning || mode === "live" || options.mode === "subtitles"} checked={options.preserveVoice} onChange={(e) => setOptions((o) => ({ ...o, preserveVoice: e.target.checked }))} /><span>Bevara originalröstens karaktär<small>{caps?.cloning ? "XTTS: kräver rena röstprov. Svenska stöds inte." : "Kräver lokal XTTS. Molnläget använder AI-standardröster."}</small></span></label>
        {options.preserveVoice && <label className="ts-check"><input type="checkbox" checked={options.voiceConsent} onChange={(e) => setOptions((o) => ({ ...o, voiceConsent: e.target.checked }))} /><span>Jag har uttryckligt samtycke från alla personer vars röster klonas.</span></label>}
        <TranslationRenderSettings options={options} caps={caps} onChange={(value) => setOptions((o) => ({ ...o, ...value }))} />
        <div className="ts-consent"><label className="ts-check"><input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} /><span>Jag har rätt att översätta och bearbeta detta material.</span></label>{activeCloud && <label className="ts-check"><input type="checkbox" checked={options.cloudConsent} onChange={(e) => setOptions((o) => ({ ...o, cloudConsent: e.target.checked }))} /><span>Jag godkänner att ljud och text skickas till OpenAI för bearbetning. API-avgifter kan tillkomma.</span></label>}</div>
        <TranslationVoicePreview key={JSON.stringify(options)} options={{ ...options, rights: true }} enabled={canRun} />
      </section>
      <div className="ts-workspace">{mode === "live" ? <TranslationLive key={JSON.stringify([options, rights])} options={{ ...options, rights: true }} enabled={canRun} /> : <>
        <section className="ts-card"><span className="ts-eyebrow">01 / LADDA UPP MATERIAL</span><div className="ts-dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!busy && !recording) chooseFile(e.dataTransfer.files[0]); }}><span className="ts-upload-icon"><UploadCloud size={34} strokeWidth={1.3} /></span><h2>{file ? file.name : "Släpp ljud eller video här"}</h2><p>{file ? `${(file.size / 1024 ** 2).toFixed(1)} MB · ${fileDuration !== undefined ? `${fileDuration.toFixed(2)} s` : "längd kontrolleras av worker"} · redo att bearbetas` : `Ljud och video, upp till ${caps?.maxUploadMb || 500} MB`}</p><button className="ts-button" disabled={busy || recording} onClick={() => picker.current?.click()}><Plus size={16} />{file ? "Välj en annan fil" : "Välj fil"}</button><input ref={picker} type="file" hidden aria-label="Välj ljud eller video" accept={Object.keys(EXTENSIONS).map((e) => `.${e}`).join(",")} onChange={(e) => { chooseFile(e.target.files?.[0]); e.target.value = ""; }} /><small>MP3 · WAV · M4A · AAC · FLAC · OGG<br />MP4 · MOV · MKV · WEBM</small></div>
          <div className="ts-record-row"><div><strong>Eller använd din mikrofon</strong><p className="ts-muted">Spela in upp till tio minuter.</p></div><button className={`ts-button ${recording ? "ts-danger" : ""}`} disabled={busy} onClick={() => void record()}>{recording ? <Square size={16} /> : <Mic size={16} />}{recording ? "Stoppa inspelning" : "Spela in"}</button></div>
          <button className="ts-button ts-primary ts-start" disabled={!file || !canRun || busy || recording || (options.preserveVoice && !options.voiceConsent)} onClick={() => void startJob()}>{busy ? <LoaderCircle className="spin" size={18} /> : <Languages size={18} />}{busy ? `Laddar upp ${progress || 0} %` : "Översätt ljud / Translate Audio"}<ArrowRight size={18} /></button>{busy && <button className="ts-button" onClick={() => upload.current?.abort()}>Avbryt uppladdning</button>}
        </section>
        <div className="ts-note"><ShieldCheck size={18} /><p>Det som sägs bevaras, även felaktiga sakuppgifter. Osäkra ord granskas per segment. Långa repliker markeras utan att innehåll tas bort.</p></div>
      </>}</div></div>
      {job && <div className="ts-job-result"><section className="ts-card"><div className="ts-row"><div><span className="ts-eyebrow">AKTUELLT JOBB · {statusLabels[job.status]}</span><h2>{job.name}</h2></div><div className="ts-actions">{["queued", "running"].includes(job.status) && <button className="ts-button" disabled={!!job.command || controlling} onClick={() => void control("pause")}><Pause size={15} />Pausa</button>}{["paused", "failed", "review"].includes(job.status) && !needsSourceReview && <button className="ts-button ts-primary" disabled={controlling} onClick={() => void control("resume")}><Play size={15} />Återuppta</button>}{["running", "queued", "paused", "failed", "review"].includes(job.status) && <button className="ts-button" disabled={!!job.command || controlling} onClick={() => void control("cancel")}><X size={15} />Avbryt</button>}{!["running", "queued"].includes(job.status) && <button className="ts-icon" disabled={controlling} aria-label="Radera jobb och dess medier" onClick={() => void remove()}><Trash2 size={17} /></button>}</div></div>
        <TranslationProjectActions key={`${job.id}-${job.name}`} job={job} disabled={editorDirty} onUpdated={(next) => { setJob(next); void refresh(); }} onDuplicated={(next) => { setJob(next); setSelected(next.id); history.replaceState(null, "", `?job=${next.id}`); void refresh(); }} />
        <ol className="ts-steps">{stages.map(([code, label], i) => <li key={code} className={stages.findIndex(([c]) => c === job.stage) >= i ? "ts-step-active" : ""}><span>{job.status === "completed" || stages.findIndex(([c]) => c === job.stage) > i ? <Check size={13} /> : i + 1}</span>{label}</li>)}</ol><p role="status" className={job.status === "failed" ? "ts-warning" : "ts-muted"}>{job.message}</p>
        {job.detectedLanguage && <p className="ts-muted">Identifierat källspråk: {languageLabel(job.detectedLanguage)} · bearbetning {(job.metrics.processingMs / 1000).toFixed(1)} s · största tidsöverskridande {job.metrics.syncMaxDeviationMs ?? "–"} ms</p>}{job.warnings.map((w) => <p className="ts-warning" key={w}>{w}</p>)}
        {needsSourceReview && ["review", "paused", "failed"].includes(job.status) && <div className="ts-review-callout" role="status"><strong>Granska originaltranskriptet före dubbning</strong><p>Tillförlitliga segment bearbetas redan. Lyssna på de markerade originalsegmenten, spara rättelser och godkänn varje segment i redigeraren. Här kan du även godkänna alla återstående efter granskning.</p><button className="ts-button ts-primary" disabled={controlling || editorDirty} onClick={() => void control("approve-source")}><Check size={16} />Jag har granskat transkriptet · fortsätt</button>{editorDirty && <p>Spara ändringarna i transkriptet först.</p>}</div>}
        <div className="ts-export-row"><label>Visa målspråk<select value={target} onChange={(e) => setPreferred(e.target.value)}>{job.options.targets.map((t) => <option value={t} key={t}>{languageLabel(t, job.options.englishLocale)}</option>)}</select></label></div>
      </section>
      <TranslationPlayer key={`${job.id}-${target}-${job.revision}`} job={job} target={target} />
      {activeFormats.length > 0 && <section className="ts-card"><h2>Ladda ner</h2><p className="ts-muted">Lyssna i spelaren ovan. Hämta samma exporterade ljud eller video här.</p><div className="ts-export-row">{activeFormats.length > 0 && <><label>Exportformat<select value={exportFormat} onChange={(e) => setFormat(e.target.value)}>{activeFormats.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}</select></label><a className="ts-button ts-primary" href={fileUrl(job.id, target, exportFormat, false, true, job.revision)} download><Download size={16} />Hämta {exportFormat?.toUpperCase()}</a></>}</div>{activeFormats.length > 0 && <div className="ts-downloads" aria-label="Ladda ner färdig export">{(job.media?.video ? ["mp4", "mp3", "srt", "vtt"] : ["mp3", "wav", "m4a"]).filter((f) => activeFormats.includes(f) && f !== exportFormat).map((f) => <a key={f} className="ts-button" href={fileUrl(job.id, target, f, false, true, job.revision)} download><Download size={16} />Hämta {f.toUpperCase()}</a>)}</div>}</section>}
      {job.segments.length > 0 && <TranslationEditor key={`${job.id}-${target}-${job.revision}-${job.status}-${job.translations[target]?.length || 0}`} job={job} target={target} caps={caps} onDirty={setEditorDirty} onSaved={(next) => { setEditorDirty(false); setJob(next); }} />}</div>}
      <footer className="ts-footer"><span>TON<span className="footer-dot">.</span> Fler språk. Samma berättelse.</span><a href="/translation/guide">Så fungerar studion <ArrowRight size={13} /></a></footer>
      </div>
    </main>
  </div>;
}
