"use client";

import { useEffect, useRef, useState, type FormEvent, type SyntheticEvent } from "react";
import { Check, CheckCircle2, Download, LoaderCircle, Mic, ShieldCheck, Square, Trash2, X } from "lucide-react";
import type { Bitrate } from "@/lib/types";
import { musicRequest } from "@/lib/music-request";
import { microphoneError, recordingExtension, selectRecordingMime } from "@/lib/recording-format";
import { deleteRecording, listRecordings, MAX_RECORDINGS, saveRecording, type StoredRecording } from "@/lib/recordings-store";
import type { ServiceStatus } from "./converter";
import { playbackTime, readableBytes, responseError, responseFilename } from "./client-utils";

type Phase = "idle" | "permission" | "recording" | "stopping" | "converting";
type Recording = { blob: Blob; duration: number };
const MAX_SECONDS = 600;
const qualities: { bitrate: Bitrate; name: string }[] = [
  { bitrate: 128, name: "Liten fil" }, { bitrate: 192, name: "Balanserad" },
  { bitrate: 256, name: "Hög kvalitet" }, { bitrate: 320, name: "Bäst kvalitet" },
];

function useAudioUrl(blob: Blob | null): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) { setUrl(undefined); return; }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

function pauseOtherAudio(current?: HTMLAudioElement) {
  document.querySelectorAll("audio").forEach((audio) => { if (audio !== current) audio.pause(); });
}

export default function Recorder({ status, onRecordingChange }: { status: ServiceStatus | null; onRecordingChange?: (active: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const callbackRef = useRef(onRecordingChange);
  const aliveRef = useRef(false);
  const attemptRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const limitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);
  const durationRef = useRef(0);
  const bytesRef = useRef(0);
  const failedRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [title, setTitle] = useState("");
  const [bitrate, setBitrate] = useState<Bitrate>(192);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [storageError, setStorageError] = useState<string>();
  const [saved, setSaved] = useState<StoredRecording[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(true);
  const [removing, setRemoving] = useState<string>();
  const [fallback, setFallback] = useState<StoredRecording | null>(null);
  const previewUrl = useAudioUrl(recording?.blob ?? null);
  const fallbackUrl = useAudioUrl(fallback?.blob ?? null);
  const uploadMb = status?.limits.uploadMb ?? 100;
  callbackRef.current = onRecordingChange;

  const changePhase = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
    callbackRef.current?.(next !== "idle");
  };
  const clearTimers = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (limitRef.current) clearTimeout(limitRef.current);
    timerRef.current = null;
    limitRef.current = null;
  };
  const releaseMicrophone = () => {
    streamRef.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    streamRef.current = null;
  };

  useEffect(() => {
    aliveRef.current = true;
    void listRecordings().then((items) => { if (aliveRef.current) setSaved(items); }).catch((cause: unknown) => {
      if (aliveRef.current) setStorageError(cause instanceof Error ? cause.message : "Sparade inspelningar kunde inte läsas.");
    }).finally(() => { if (aliveRef.current) setLoadingSaved(false); });
    return () => {
      aliveRef.current = false;
      attemptRef.current += 1;
      requestRef.current?.abort();
      clearTimers();
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* Already stopped. */ } }
      }
      releaseMicrophone();
      chunksRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (phase === "idle" && !recording && !fallback) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase, recording, fallback]);

  const stopRecording = (notice?: string) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive" || phaseRef.current === "stopping") return;
    durationRef.current = Math.min(MAX_SECONDS, (performance.now() - startedRef.current) / 1000);
    setElapsed(durationRef.current);
    clearTimers();
    changePhase("stopping");
    if (notice) setMessage(notice);
    try { recorder.stop(); }
    catch { failedRef.current = true; setError("Inspelningen kunde inte avslutas. Försök igen."); changePhase("idle"); }
    releaseMicrophone();
  };

  const startRecording = async () => {
    if (phaseRef.current !== "idle") return;
    setError(undefined);
    setMessage(undefined);
    if (!window.isSecureContext) { setError("Mikrofonen kräver en säker anslutning. Öppna appen via localhost, 127.0.0.1 eller HTTPS."); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setError("Din webbläsare stöder inte ljudinspelning. Prova en aktuell version av Chrome, Edge, Firefox eller Safari."); return; }
    const attempt = ++attemptRef.current;
    pauseOtherAudio();
    changePhase("permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!aliveRef.current || attempt !== attemptRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const mime = typeof MediaRecorder.isTypeSupported === "function" ? selectRecordingMime((type) => MediaRecorder.isTypeSupported(type)) : undefined;
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128_000 }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      bytesRef.current = 0;
      durationRef.current = 0;
      failedRef.current = false;
      const maxBytes = uploadMb * 1024 * 1024;
      recorder.ondataavailable = (event) => {
        if (!aliveRef.current || attempt !== attemptRef.current || failedRef.current || !event.data.size) return;
        bytesRef.current += event.data.size;
        if (bytesRef.current > maxBytes) {
          failedRef.current = true;
          chunksRef.current = [];
          setError(`Inspelningen blev större än ${uploadMb} MB. Spela in ett kortare ljud och försök igen.`);
          stopRecording();
          return;
        }
        chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (!aliveRef.current || attempt !== attemptRef.current) return;
        clearTimers();
        releaseMicrophone();
        recorderRef.current = null;
        // onstop follows the final dataavailable, so the final audio chunk is included.
        if (!failedRef.current) {
          try {
            const actualMime = recorder.mimeType || chunksRef.current.find((part) => part.type)?.type || mime || "";
            recordingExtension(actualMime);
            const blob = new Blob(chunksRef.current, { type: actualMime });
            if (!blob.size) throw new Error("Inspelningen innehåller inget ljud. Kontrollera mikrofonen och försök igen.");
            setRecording({ blob, duration: durationRef.current });
          } catch (cause) { setError(cause instanceof Error ? cause.message : "Ljudfilen kunde inte skapas."); }
        }
        chunksRef.current = [];
        changePhase("idle");
      };
      recorder.onerror = () => {
        if (!aliveRef.current || attempt !== attemptRef.current) return;
        failedRef.current = true;
        chunksRef.current = [];
        setError("Webbläsaren avbröt inspelningen. Kontrollera mikrofonen och spela in igen.");
        stopRecording();
        clearTimers();
        releaseMicrophone();
        changePhase("idle");
      };
      stream.getAudioTracks().forEach((track) => { track.onended = () => stopRecording("Mikrofonen kopplades bort. Ljudet fram till avbrottet kan sparas."); });
      startedRef.current = performance.now();
      recorder.start(1000);
      // Preserve any previous recording if opening or starting this capture fails.
      setRecording(null);
      setFallback(null);
      setConfirmed(false);
      setElapsed(0);
      if (!title.trim()) setTitle(`Inspelning ${new Date().toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })}`);
      changePhase("recording");
      timerRef.current = setInterval(() => {
        const seconds = Math.min(MAX_SECONDS, (performance.now() - startedRef.current) / 1000);
        durationRef.current = seconds;
        setElapsed(seconds);
      }, 250);
      limitRef.current = setTimeout(() => stopRecording("Inspelningen stoppades efter 10 minuter. Du kan nu spara den som MP3."), MAX_SECONDS * 1000);
    } catch (cause) {
      if (!aliveRef.current || attempt !== attemptRef.current) return;
      clearTimers();
      releaseMicrophone();
      recorderRef.current = null;
      setError(microphoneError(cause));
      changePhase("idle");
    }
  };

  const cancelPermission = () => { attemptRef.current += 1; changePhase("idle"); setMessage("Inspelningen avbröts. Ingen mikrofon kommer att användas när tillståndsfrågan stängs."); };

  const playPreview = (event: SyntheticEvent<HTMLAudioElement>) => {
    if (phaseRef.current !== "idle") { event.currentTarget.pause(); return; }
    pauseOtherAudio(event.currentTarget);
  };

  const convertAndSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!recording || !confirmed || !title.trim() || phaseRef.current !== "idle") return;
    setError(undefined);
    setMessage(undefined);
    setFallback(null);
    changePhase("converting");
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
      const extension = recordingExtension(recording.blob.type);
      const form = new FormData();
      form.append("file", new File([recording.blob], `inspelning.${extension}`, { type: recording.blob.type }));
      form.append("title", title.trim());
      form.append("bitrate", String(bitrate));
      form.append("rightsConfirmed", "true");
      const response = await musicRequest("/api/convert", { method: "POST", body: form, signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response, "Inspelningen kunde inte konverteras"));
      if (response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "audio/mpeg") throw new Error("Servern skickade inte en MP3-fil. Försök igen.");
      const blob = await response.blob();
      if (!blob.size) throw new Error("MP3-filen är tom. Spela in ljudet igen.");
      if (!aliveRef.current) return;
      const item: StoredRecording = {
        id: crypto.randomUUID(), title: title.trim(), filename: responseFilename(response, `${title.trim()}.mp3`),
        createdAt: Date.now(), duration: recording.duration, bitrate, blob: new Blob([blob], { type: "audio/mpeg" }),
      };
      try {
        await saveRecording(item);
        if (!aliveRef.current) return;
        setSaved((items) => [item, ...items]);
        setStorageError(undefined);
        setRecording(null);
        setElapsed(0);
        setConfirmed(false);
        setMessage("Din MP3 är sparad i den här webbläsaren. Du kan lyssna eller ladda ner den nedan.");
      } catch (cause) {
        if (!aliveRef.current) return;
        setFallback(item);
        setError(`${cause instanceof Error ? cause.message : "Inspelningen kunde inte sparas."} MP3-filen är färdig och finns nedan för nedladdning tills du stänger sidan.`);
      }
    } catch (cause) {
      if (!aliveRef.current) return;
      setError(controller.signal.aborted ? "Konverteringen avbröts eller tog för lång tid. Din inspelning finns kvar; försök igen." : cause instanceof Error ? cause.message : "Inspelningen kunde inte sparas som MP3.");
    } finally {
      clearTimeout(timeout);
      if (requestRef.current === controller) requestRef.current = null;
      if (aliveRef.current) changePhase("idle");
    }
  };

  const removeSaved = async (item: StoredRecording) => {
    if (removing) return;
    setRemoving(item.id);
    try {
      await deleteRecording(item.id);
      if (aliveRef.current) { setSaved((items) => items.filter((record) => record.id !== item.id)); setStorageError(undefined); }
    } catch (cause) { if (aliveRef.current) setStorageError(cause instanceof Error ? cause.message : "Inspelningen kunde inte tas bort."); }
    finally { if (aliveRef.current) setRemoving(undefined); }
  };

  return (
    <section className="converter-page recording-page">
      <div className="section-eyebrow"><span className="small-dot" /> FRÅN MIKROFON TILL MP3.</div>
      <div className="page-heading"><div><h1>Spela in.<br /><span>Spara din ton.</span></h1><p>Fånga en idé, din röst eller ett eget ljud.<br className="desktop-break" /> Lyssna, spara och ladda ner som MP3.</p></div><div className="conversion-illustration" aria-hidden="true"><Mic size={48} strokeWidth={1} /><div>MP3<span>128–320 kbps</span></div></div></div>
      {status?.ffmpeg.available === false && <div className="notice notice-warning" role="status"><ShieldCheck size={20} /><div><strong>MP3-konvertering behöver FFmpeg</strong><p>Du kan spela in och lyssna. Installera FFmpeg enligt README för att spara som MP3.</p></div></div>}
      <div className="converter-layout">
        <form className="conversion-form panel" onSubmit={convertAndSave}>
          <div className="step-heading"><span>01</span><h2>Spela in ditt ljud</h2></div>
          <div className={`recording-stage ${phase === "recording" ? "is-recording" : ""}`}>
            <span className="recording-indicator" aria-hidden="true"><Mic size={30} /></span>
            <div className="recording-clock" role="timer" aria-label="Inspelningstid">{playbackTime(elapsed)}</div>
            <p>{phase === "recording" ? "Mikrofonen spelar in" : phase === "permission" ? "Tillåt mikrofonen i webbläsaren" : phase === "stopping" ? "Avslutar inspelningen…" : recording ? "Din inspelning är redo" : "Mikrofonen startar först när du väljer att spela in"}</p>
            <div className="recording-controls">
              {phase === "recording" ? <button type="button" className="button button-primary" onClick={() => stopRecording()}><Square size={16} /> Stoppa inspelning</button>
                : phase === "permission" ? <><button type="button" className="button button-secondary" disabled><LoaderCircle className="spin" size={16} /> Väntar på mikrofon…</button><button type="button" className="button button-secondary" onClick={cancelPermission}><X size={16} /> Avbryt</button></>
                : <button type="button" className="button button-primary" onClick={() => void startRecording()} disabled={phase !== "idle"}><Mic size={17} /> {recording ? "Ny inspelning" : "Starta inspelning"}</button>}
            </div>
            <small>Högst 10 minuter · Max {uploadMb} MB</small>
          </div>
          {previewUrl && <div className="recording-preview"><strong>Lyssna innan du sparar</strong><audio controls={phase === "idle"} onPlay={playPreview} preload="metadata" src={previewUrl} aria-label="Lyssna på inspelningen" /></div>}
          <div className="step-heading"><span>02</span><h2>Spara som MP3</h2></div>
          <div className="file-details recording-title"><label>Namn på inspelningen<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={150} required placeholder="Till exempel Min nya låtidé" disabled={phase !== "idle"} /></label></div>
          <div className="quality-options" role="radiogroup" aria-label="Inspelningens MP3-kvalitet">{qualities.map((quality) => <label key={quality.bitrate} className={`quality-option ${bitrate === quality.bitrate ? "quality-selected" : ""}`}><input className="sr-only" type="radio" name="recording-bitrate" value={quality.bitrate} checked={bitrate === quality.bitrate} onChange={() => setBitrate(quality.bitrate)} disabled={phase !== "idle"} aria-label={`${quality.bitrate} kbps, ${quality.name}`} /><strong>{quality.bitrate}<span> kbps</span></strong><small>{quality.name}</small>{bitrate === quality.bitrate && <Check size={13} />}</label>)}</div>
          <label className="rights-checkbox"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required disabled={phase !== "idle"} /><span>Jag äger inspelningen eller har tillstånd att spela in och konvertera ljudet.</span></label>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          {message && <div className="conversion-success" role="status"><CheckCircle2 size={21} /><div><p>{message}</p></div></div>}
          {fallback && fallbackUrl && <div className="recording-preview"><strong>MP3 klar — kunde inte sparas i webbläsaren</strong><audio controls={phase === "idle"} onPlay={playPreview} preload="metadata" src={fallbackUrl} aria-label="Lyssna på färdig MP3" /><a className="button button-secondary" href={fallbackUrl} download={fallback.filename}><Download size={16} /> Ladda ner MP3</a></div>}
          <button type="submit" className="button button-primary convert-submit" disabled={!recording || !title.trim() || !confirmed || phase !== "idle" || status?.ffmpeg.available === false}>{phase === "converting" ? <><LoaderCircle size={18} className="spin" /> Skapar och sparar MP3…</> : <><Download size={18} /> Spara som MP3</>}</button>
          {phase === "converting" && <button type="button" className="button button-secondary" onClick={() => requestRef.current?.abort()}>Avbryt konvertering</button>}
          <p className="form-footnote">{phase === "converting" ? "Ljudet konverteras med FFmpeg. Första gången hämtas konverteringsverktyget. Din inspelning finns kvar vid fel." : status?.conversionLocation === "browser" ? "Din mikrofon stängs efter inspelningen. Ljudet konverteras och sparas i din webbläsare." : "Din mikrofon stängs efter inspelningen. Ljudet skickas till appens server först när du sparar som MP3."}</p>
        </form>
        <aside className="conversion-aside"><div className="aside-note"><ShieldCheck size={25} /><h3>Dina egna ljud.<br />{" "}Sparade hos dig.</h3><p>MP3-inspelningar lagras i den här webbläsaren och finns kvar när du öppnar appen igen på samma adress.</p><p className="muted">Ladda ner filer du vill behålla. Rensad webbplatsdata eller privat läge kan radera sparade inspelningar.</p></div><div className="aside-note"><Mic size={25} /><h3>Redo för mikrofonen?</h3><p>Välj Starta inspelning och ge webbläsaren tillåtelse. På mobilen krävs HTTPS, även när du öppnar appen från din dator.</p><p className="muted">Inspelningen använder mikrofonen. Max 20 sparade inspelningar och 100 MB tillsammans.</p></div></aside>
      </div>
      <section className="recordings-panel panel" aria-labelledby="saved-recordings-heading">
        <div className="recordings-heading"><h2 id="saved-recordings-heading">Sparade inspelningar</h2><span>{saved.length} / {MAX_RECORDINGS}</span></div>
        {storageError && <div className="notice notice-warning" role="alert">{storageError}</div>}
        {loadingSaved ? <p className="recordings-empty">Hämtar dina sparade inspelningar…</p> : !saved.length ? <p className="recordings-empty">Din första MP3 visas här när du har spelat in och sparat.</p> : <div className="recordings-list">{saved.map((item) => <SavedRecording key={item.id} item={item} removing={removing === item.id} playbackDisabled={phase !== "idle"} onPlay={playPreview} onRemove={() => void removeSaved(item)} />)}</div>}
      </section>
    </section>
  );
}

function SavedRecording({ item, removing, playbackDisabled, onPlay, onRemove }: { item: StoredRecording; removing: boolean; playbackDisabled: boolean; onPlay: (event: SyntheticEvent<HTMLAudioElement>) => void; onRemove: () => void }) {
  const url = useAudioUrl(item.blob);
  return <article className="recording-item"><div className="recording-item-details"><h3>{item.title}</h3><p>{new Date(item.createdAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })} · {playbackTime(item.duration)} · {item.bitrate} kbps · {readableBytes(item.blob.size)}</p>{url && <audio controls={!playbackDisabled} onPlay={onPlay} preload="none" src={url} aria-label={`Lyssna på ${item.title}`} />}</div><div className="recording-item-actions">{url && <a className="button button-secondary" href={url} download={item.filename}><Download size={15} /> Ladda ner MP3</a>}<button type="button" className="icon-button" disabled={removing} onClick={onRemove} aria-label={`Ta bort ${item.title}`}>{removing ? <LoaderCircle size={17} className="spin" /> : <Trash2 size={17} />}</button></div></article>;
}
