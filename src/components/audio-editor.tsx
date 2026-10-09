"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Download, LoaderCircle, Scissors, Trash2, Undo2 } from "lucide-react";
import { editedDuration, MAX_AUDIO_CUTS, parseAudioCuts, type AudioCut } from "@/lib/audio-edits";
import { musicRequest } from "@/lib/music-request";
import type { Bitrate } from "@/lib/types";
import { playbackTime, readableBytes, responseError, responseFilename } from "./client-utils";
import Dialog from "./dialog";

export interface EditedAudio { file: File; title: string; duration: number; bitrate: Bitrate }
export interface EditableAudio { file: File; title: string; duration?: number; bitrate?: Bitrate }

async function measuredDuration(blob: Blob, fallback: number): Promise<number> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    const finish = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallback;
      clearTimeout(timer); audio.onloadedmetadata = null; audio.onerror = null;
      audio.removeAttribute("src"); audio.load(); URL.revokeObjectURL(url); resolve(duration);
    };
    const timer = setTimeout(finish, 3000);
    audio.onloadedmetadata = finish; audio.onerror = finish; audio.preload = "metadata"; audio.src = url;
  });
}

export default function AudioEditor({ source, onClose, onSave }: {
  source: EditableAudio;
  onClose: () => void;
  onSave?: (audio: EditedAudio) => Promise<string | void> | string | void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const resultAudioRef = useRef<HTMLAudioElement>(null);
  const markerId = useId();
  const requestRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(false);
  const [sourceUrl, setSourceUrl] = useState<string>();
  const [resultUrl, setResultUrl] = useState<string>();
  const [duration, setDuration] = useState(source.duration ?? 0);
  const [position, setPosition] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.min(5, source.duration ?? 0));
  const [cuts, setCuts] = useState<AudioCut[]>([]);
  const [previewCuts, setPreviewCuts] = useState(true);
  const [title, setTitle] = useState(`${source.title || "Mitt ljud"} – redigerad`.slice(0, 150));
  const [bitrate, setBitrate] = useState<Bitrate>(source.bitrate ?? 320);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [result, setResult] = useState<EditedAudio>();
  const merged = parseAudioCuts(cuts);
  const remaining = editedDuration(duration, merged);
  const validSelection = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= Math.min(duration, 86_400) && end - start >= 0.01;

  useEffect(() => {
    aliveRef.current = true;
    const url = URL.createObjectURL(source.file); setSourceUrl(url);
    const player = audioRef.current;
    document.querySelectorAll("audio").forEach(audio => audio.pause());
    return () => { aliveRef.current = false; requestRef.current?.abort(); player?.pause(); URL.revokeObjectURL(url); };
  }, [source.file]);

  useEffect(() => {
    if (!result) return;
    const url = URL.createObjectURL(result.file); setResultUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);

  useEffect(() => {
    const player = resultAudioRef.current;
    return () => player?.pause();
  }, [resultUrl]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (cuts.length || busy) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [cuts.length, busy]);

  // timeupdate can be too sparse for short selections. This remains a preview;
  // the exported MP3 uses FFmpeg's sample-based trimming.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let frame = 0;
    const stop = () => cancelAnimationFrame(frame);
    const tick = () => {
      if (audio.paused) return;
      if (previewCuts) {
        const cut = merged.find(part => audio.currentTime >= part.start && audio.currentTime < part.end);
        if (cut) {
          if (cut.end >= duration - 0.001) { audio.pause(); audio.currentTime = duration; setPosition(duration); return; }
          audio.currentTime = cut.end;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    const startMonitor = () => { stop(); tick(); };
    audio.addEventListener("play", startMonitor); audio.addEventListener("pause", stop); audio.addEventListener("ended", stop);
    if (!audio.paused) startMonitor();
    return () => { stop(); audio.removeEventListener("play", startMonitor); audio.removeEventListener("pause", stop); audio.removeEventListener("ended", stop); };
  }, [cuts, previewCuts, duration, sourceUrl]);

  const pauseOtherPlayers = (current: HTMLAudioElement) => document.querySelectorAll("audio").forEach(audio => { if (audio !== current) audio.pause(); });

  const readDuration = () => {
    const measured = audioRef.current?.duration;
    if (measured && Number.isFinite(measured)) {
      setDuration(measured);
      setEnd(current => current || Math.min(5, measured));
    }
  };
  const seek = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, seconds));
    setPosition(audio.currentTime);
  };
  const updatePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (previewCuts && !audio.paused) {
      const cut = merged.find(part => audio.currentTime >= part.start && audio.currentTime < part.end);
      if (cut) {
        if (cut.end >= duration - 0.001) { audio.pause(); seek(duration); return; }
        audio.currentTime = cut.end;
      }
    }
    setPosition(audio.currentTime);
  };
  const addCut = () => {
    if (!validSelection || busy) return;
    const next = [...cuts, { start, end }];
    if (editedDuration(duration, next) < 0.05) { setError("Behåll minst en liten del av ljudet. Hela filen kan inte tas bort."); return; }
    setCuts(next); setError(undefined); setResult(undefined); setNotice(undefined);
  };
  const exportAudio = async () => {
    if (busy || !confirmed || !title.trim() || !cuts.length || remaining < 0.05) return;
    setBusy(true); setError(undefined); setResult(undefined); setNotice(undefined); audioRef.current?.pause();
    const controller = new AbortController(); requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
      const data = new FormData(); data.append("file", source.file); data.append("cuts", JSON.stringify(merged));
      data.append("title", title.trim()); data.append("bitrate", String(bitrate)); data.append("rightsConfirmed", "true");
      const response = await musicRequest("/api/convert", { method: "POST", body: data, signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response, "Ljudet kunde inte redigeras"));
      if (response.headers.get("Content-Type")?.split(";", 1)[0] !== "audio/mpeg") throw new Error("Konverteringen gav ingen MP3-fil.");
      const blob = await response.blob(); if (!blob.size) throw new Error("Det redigerade ljudet är tomt. Behåll en större del och försök igen.");
      const next: EditedAudio = {
        file: new File([blob], responseFilename(response, `${title.trim()}.mp3`), { type: "audio/mpeg" }),
        title: title.trim(), bitrate, duration: await measuredDuration(blob, remaining),
      };
      if (!aliveRef.current) return;
      if (controller.signal.aborted) throw new DOMException("Avbruten", "AbortError");
      setResult(next);
      try {
        const message = await onSave?.(next);
        if (aliveRef.current) setNotice(message || "Din redigerade MP3 är klar. Originalet finns kvar.");
      } catch (cause) {
        if (aliveRef.current) setNotice(`${cause instanceof Error ? cause.message : "Kopian kunde inte sparas."} Du kan ladda ner den färdiga MP3-filen här.`);
      }
    } catch (cause) {
      if (aliveRef.current) setError(controller.signal.aborted ? "Redigeringen avbröts eller tog för lång tid. Originalet och dina markeringar finns kvar." : cause instanceof Error ? cause.message : "Ljudet kunde inte redigeras.");
    } finally { clearTimeout(timeout); if (requestRef.current === controller) requestRef.current = null; if (aliveRef.current) setBusy(false); }
  };

  return <Dialog title="Redigera ljud" onClose={onClose} closeLabel="Stäng ljudredigeraren" className="audio-editor-dialog">
    <div className="audio-editor">
      <p>Markera en del du vill ta bort. Du kan göra flera markeringar och ångra dem innan du sparar en ny MP3.</p>
      <audio ref={audioRef} src={sourceUrl} controls={!busy} preload="metadata" aria-label="Lyssna på originalet" onLoadedMetadata={readDuration} onDurationChange={readDuration} onTimeUpdate={updatePlayback} onPlay={event => { pauseOtherPlayers(event.currentTarget); updatePlayback(); }} onError={() => { if (!duration) setError("Ljudets längd kunde inte läsas. Konvertera filen till MP3 först och öppna den igen."); }} />
      {!duration && <p role="status">Läser ljudets längd…</p>}
      <div className="edit-timeline" aria-label="Ljudöversikt: markerade delar tas bort">
        {merged.map((cut, i) => <span key={i} className="edit-cut" style={{ left: `${100 * cut.start / duration}%`, width: `${100 * (Math.min(duration, cut.end) - cut.start) / duration}%` }} />)}
        {validSelection && <span className="edit-selection" style={{ left: `${100 * start / duration}%`, width: `${100 * (end - start) / duration}%` }} />}
        <span className="edit-playhead" style={{ left: `${duration ? 100 * position / duration : 0}%` }} />
      </div>
      <input className="edit-seek" type="range" aria-label="Uppspelningens position" min={0} max={duration || 1} step="0.01" value={Math.min(position, duration)} disabled={!duration || busy} onChange={event => seek(Number(event.target.value))} />
      <div className="edit-times"><span>{playbackTime(position)} / {playbackTime(duration)}</span><span>Kvar: {playbackTime(remaining)}</span></div>
      <label className="edit-check"><input type="checkbox" checked={previewCuts} onChange={event => setPreviewCuts(event.target.checked)} disabled={busy} />Hoppa över borttagna delar när jag lyssnar</label>
      <fieldset className="edit-markers" disabled={!duration || busy}>
        <legend>Del som ska tas bort</legend>
        <div className="edit-marker"><label htmlFor={`${markerId}-start`}>Start (sekunder)</label><input id={`${markerId}-start`} type="number" min="0" max={duration} step="0.01" value={Number.isNaN(start) ? "" : start} onChange={event => setStart(event.target.value === "" ? NaN : Number(event.target.value))} /><input type="range" aria-label="Startmarkering" min="0" max={duration || 1} step="0.01" value={Number.isFinite(start) ? start : 0} onChange={event => setStart(Number(event.target.value))} /><button type="button" className="button button-secondary" onClick={() => setStart(Number(position.toFixed(2)))}>Start vid spelaren</button></div>
        <div className="edit-marker"><label htmlFor={`${markerId}-end`}>Slut (sekunder)</label><input id={`${markerId}-end`} type="number" min="0" max={duration} step="0.01" value={Number.isNaN(end) ? "" : end} onChange={event => setEnd(event.target.value === "" ? NaN : Number(event.target.value))} /><input type="range" aria-label="Slutmarkering" min="0" max={duration || 1} step="0.01" value={Number.isFinite(end) ? end : 0} onChange={event => setEnd(Number(event.target.value))} /><button type="button" className="button button-secondary" onClick={() => setEnd(Number(position.toFixed(2)))}>Slut vid spelaren</button></div>
      </fieldset>
      <div className="edit-actions"><button type="button" className="button button-secondary" disabled={!validSelection || busy || cuts.length >= MAX_AUDIO_CUTS} onClick={addCut}><Scissors size={17} /> Ta bort markerad del</button><button type="button" className="button button-secondary" disabled={!cuts.length || busy} onClick={() => { setCuts(items => items.slice(0, -1)); setResult(undefined); setError(undefined); setNotice(undefined); }}><Undo2 size={17} /> Ångra</button></div>
      {!!merged.length && <ol className="edit-cut-list" aria-label="Delar som tas bort">{merged.map((cut, i) => <li key={i}><span>{cut.start.toFixed(2)}–{cut.end.toFixed(2)} sekunder</span><button type="button" className="icon-button" aria-label={`Återställ del ${i + 1}`} disabled={busy} onClick={() => { setCuts(merged.filter((_, index) => index !== i)); setResult(undefined); setNotice(undefined); }}><Trash2 size={17} /></button></li>)}</ol>}
      <div className="file-details edit-output"><label>Namn på kopian<input maxLength={150} value={title} onChange={event => setTitle(event.target.value)} disabled={busy} /></label><label>MP3-kvalitet<select value={bitrate} onChange={event => setBitrate(Number(event.target.value) as Bitrate)} disabled={busy}>{[128, 192, 256, 320].map(value => <option key={value} value={value}>{value} kbps</option>)}</select></label></div>
      <label className="edit-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />Jag äger ljudet eller har tillstånd att redigera och konvertera det.</label>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="edit-actions"><button type="button" className="button button-primary" disabled={!cuts.length || !confirmed || !title.trim() || busy || remaining < 0.05} onClick={() => void exportAudio()}>{busy ? <><LoaderCircle size={18} className="spin" /> Sparar redigerad MP3…</> : <><Scissors size={18} /> Spara redigerad kopia</>}</button>{busy && <button type="button" className="button button-secondary" onClick={() => requestRef.current?.abort()}>Avbryt redigering</button>}</div>
      {result && resultUrl && <div className="edit-result" role="status"><strong>{notice || "Din redigerade MP3 är klar."}</strong><p>{result.file.name} · {playbackTime(result.duration)} · {readableBytes(result.file.size)}</p><audio ref={resultAudioRef} controls src={resultUrl} preload="metadata" aria-label="Lyssna på redigerad MP3" onPlay={event => pauseOtherPlayers(event.currentTarget)} /><a className="button button-secondary" href={resultUrl} download={result.file.name}><Download size={17} /> Ladda ner redigerad MP3</a></div>}
      <p className="edit-footnote">Originalet ändras aldrig. Delarna klipps bort utan volymjustering. Förhandslyssningen är ungefärlig; kontrollera klippen i den färdiga MP3-kopian.</p>
    </div>
  </Dialog>;
}
