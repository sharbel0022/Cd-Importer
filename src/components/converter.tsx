"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, CheckCircle2, Disc3, Download, FileAudio2, FolderOpen, LoaderCircle, Scissors, ShieldCheck, Upload, X } from "lucide-react";
import type { Bitrate } from "@/lib/types";
import { musicRequest } from "@/lib/music-request";
import { readableBytes, responseError, responseFilename, saveBlob } from "./client-utils";
import AudioEditor, { type EditableAudio } from "./audio-editor";

export interface ServiceStatus {
  conversionLocation?: "browser" | "server";
  ffmpeg: { available: boolean; message: string };
  limits: { uploadMb: number; batchTracks: number };
}

const allowedExtensions = /\.(wav|flac|m4a|mp3|aac|ogg|aiff|aif)$/i;
const qualities: { bitrate: Bitrate; name: string }[] = [
  { bitrate: 128, name: "Liten fil" }, { bitrate: 192, name: "Balanserad" },
  { bitrate: 256, name: "Hög kvalitet" }, { bitrate: 320, name: "Bäst kvalitet" },
];

export default function Converter({ status }: { status: ServiceStatus | null }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const savedUrlRef = useRef<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [bitrate, setBitrate] = useState<Bitrate>(192);
  const [confirmed, setConfirmed] = useState(false);
  const [artist, setArtist] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string>();
  const [download, setDownload] = useState<{ url: string; filename: string; size: number }>();
  const [editing, setEditing] = useState<EditableAudio | null>(null);
  const uploadMb = status?.limits.uploadMb ?? 100;

  useEffect(() => () => {
    requestRef.current?.abort();
    if (savedUrlRef.current) URL.revokeObjectURL(savedUrlRef.current);
  }, []);

  const chooseFile = (selected: File | undefined) => {
    if (!selected || busy) return;
    setError(undefined);
    setDownload(undefined);
    if (savedUrlRef.current) { URL.revokeObjectURL(savedUrlRef.current); savedUrlRef.current = null; }
    if (!allowedExtensions.test(selected.name)) {
      setError("Välj en ljudfil i formatet WAV, FLAC, M4A, MP3, AAC, OGG eller AIFF.");
      setFile(null);
      return;
    }
    if (selected.size > uploadMb * 1024 * 1024 || selected.size === 0) {
      setError(selected.size === 0 ? "Ljudfilen är tom. Välj en annan fil." : `Filen är för stor. Du kan ladda upp högst ${uploadMb} MB.`);
      setFile(null);
      return;
    }
    setFile(selected);
    setTitle(selected.name.replace(/\.[^.]+$/, ""));
  };

  const convert = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || !confirmed || busy) return;
    setBusy(true);
    setError(undefined);
    setDownload(undefined);
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 180_000);
    try {
      const data = new FormData();
      data.append("file", file);
      data.append("bitrate", String(bitrate));
      data.append("rightsConfirmed", "true");
      if (artist.trim()) data.append("artist", artist.trim());
      if (title.trim()) data.append("title", title.trim());
      const response = await musicRequest("/api/convert", { method: "POST", body: data, signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response, "Filen kunde inte konverteras"));
      const blob = await response.blob();
      if (!blob.size) throw new Error("Konverteringen gav en tom fil. Försök med en annan ljudfil.");
      const filename = responseFilename(response, `${title || "Min musik"}.mp3`);
      if (savedUrlRef.current) URL.revokeObjectURL(savedUrlRef.current);
      const url = saveBlob(blob, filename);
      savedUrlRef.current = url;
      setDownload({ url, filename, size: blob.size });
    } catch (cause) {
      if (controller.signal.aborted) setError("Konverteringen tog för lång tid. Försök med en mindre fil.");
      else setError(cause instanceof Error ? cause.message : "Konverteringen misslyckades. Försök igen.");
    } finally {
      window.clearTimeout(timeout);
      requestRef.current = null;
      setBusy(false);
    }
  };

  return (
    <section className="converter-page">
      <div className="section-eyebrow"><span className="small-dot" /> DITT LJUD. DITT FORMAT.</div>
      <div className="page-heading"><div><h1>Ge dina filer<br /><span>en ny ton.</span></h1><p>M4A, WAV, FLAC och andra ljudfiler till MP3.<br className="desktop-break" /> Du kan också göra om en MP3 med vald kvalitet.</p></div><div className="conversion-illustration" aria-hidden="true"><FileAudio2 size={48} strokeWidth={1} /><ArrowRight size={25} strokeWidth={1.5} /><div>MP3<span>128–320 kbps</span></div></div></div>
      {status && !status.ffmpeg.available && <div className="notice notice-warning" role="status"><InfoIcon /><div><strong>Konvertering är inte tillgänglig just nu</strong><p>Servern behöver FFmpeg för att skapa MP3-filer. Följ installationen i projektets README och starta om appen.</p></div></div>}
      <div className="converter-layout">
        <form className="conversion-form panel" onSubmit={convert}>
          <div className="step-heading"><span>01</span><h2>Välj din ljudfil</h2></div>
          <div className={`upload-zone ${dragging ? "upload-dragging" : ""} ${file ? "has-file" : ""}`} onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }}>
            <input ref={inputRef} id="audio-upload" className="sr-only" type="file" accept=".wav,.flac,.m4a,.mp3,.aac,.ogg,.aiff,.aif" disabled={busy} onChange={(event) => chooseFile(event.target.files?.[0])} />
            <label htmlFor="audio-upload" className="upload-label">
              <span className="upload-icon">{file ? <FileAudio2 size={26} /> : <Upload size={26} />}</span>
              <strong>{file ? file.name : "Dra in en fil eller välj från din dator"}</strong>
              <span>{file ? `${readableBytes(file.size)} · Klicka för att byta fil` : `WAV, FLAC, M4A, MP3, AAC, OGG, AIFF · Max ${uploadMb} MB`}</span>
              {!file && <span className="button button-secondary upload-button"><FolderOpen size={16} /> Välj ljudfil</span>}
            </label>
            {file && !busy && <button type="button" className="icon-button remove-file" aria-label="Ta bort vald fil" onClick={() => { setFile(null); setDownload(undefined); if (inputRef.current) inputRef.current.value = ""; }}><X size={17} /></button>}
          </div>
          {file && <button type="button" className="button button-secondary" disabled={busy || status?.ffmpeg.available === false} onClick={() => setEditing({ file, title: title.trim() || file.name.replace(/\.[^.]+$/, ""), bitrate })}><Scissors size={17} /> Redigera ljud</button>}
          <div className="step-heading"><span>02</span><h2>Välj MP3-kvalitet</h2></div>
          <div className="quality-options" role="radiogroup" aria-label="MP3-kvalitet">{qualities.map((quality) => <label key={quality.bitrate} className={`quality-option ${bitrate === quality.bitrate ? "quality-selected" : ""}`}><input className="sr-only" type="radio" name="mp3-bitrate" value={quality.bitrate} checked={bitrate === quality.bitrate} onChange={() => setBitrate(quality.bitrate)} disabled={busy} aria-label={`${quality.bitrate} kbps, ${quality.name}`} /><strong>{quality.bitrate}<span> kbps</span></strong><small>{quality.name}</small>{bitrate === quality.bitrate && <Check size={13} />}</label>)}</div>
          <div className="file-details"><label>Artist <span>(valfritt)</span><input value={artist} onChange={(event) => setArtist(event.target.value)} placeholder="Artistens namn" maxLength={150} disabled={busy} /></label><label>Låttitel <span>(valfritt)</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Låtens namn" maxLength={150} disabled={busy} /></label></div>
          <label className="rights-checkbox"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required disabled={busy} /><span>Jag äger filen eller har uttryckligt tillstånd att konvertera den.</span></label>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          {download && <div className="conversion-success" role="status"><CheckCircle2 size={22} /><div><strong>Din MP3 är klar</strong><p>{download.filename} · {readableBytes(download.size)}</p><a href={download.url} download={download.filename}>Hämta filen igen <Download size={13} /></a></div></div>}
          <button className="button button-primary convert-submit" disabled={!file || !confirmed || busy || status?.ffmpeg.available === false} type="submit">{busy ? <><LoaderCircle size={18} className="spin" /> Konverterar din fil…</> : <><Download size={18} /> Konvertera till MP3</>}</button>
          <p className="form-footnote">{busy ? "Filen bearbetas. Första gången hämtas konverteringsverktyget. Stanna kvar tills din MP3 är klar." : status?.conversionLocation === "browser" ? "Filen konverteras i din webbläsare. Ditt ljud laddas inte upp till Sites." : "Filen konverteras på den lokala servern. Temporära filer raderas efter bearbetning."}</p>
        </form>
        <aside className="conversion-aside"><div className="aside-note"><ShieldCheck size={25} /><h3>En riktig MP3.<br />Hela vägen.</h3><p>Vi konverterar ljudet med FFmpeg. Resultatet blir en MP3 som fungerar i vanliga musikspelare.</p></div><div className="aside-note cd-note"><Disc3 size={25} /><h3>Musik från din CD?</h3><p>Exportera först ljudfiler från en CD som du har rätt att kopiera. Välj sedan filerna här, en i taget.</p><p className="muted">Webbläsaren kan inte läsa eller rippa en fysisk CD direkt.</p></div><div className="aside-note"><h3>Vilken kvalitet passar?</h3><p><strong>192 kbps</strong> ger en bra balans. <strong>320 kbps</strong> ger större filer med högre kvalitet.</p><p className="muted">En högre bithastighet återskapar inte detaljer som saknas i originalet.</p></div></aside>
      </div>
      {editing && <AudioEditor source={editing} onClose={() => setEditing(null)} onSave={audio => {
        if (savedUrlRef.current) URL.revokeObjectURL(savedUrlRef.current);
        const url = URL.createObjectURL(audio.file); savedUrlRef.current = url;
        setDownload({ url, filename: audio.file.name, size: audio.file.size });
        return "Din redigerade MP3 är klar för nedladdning. Originalfilen finns kvar.";
      }} />}
    </section>
  );
}

function InfoIcon() { return <ShieldCheck size={20} />; }
