"use client";

import { useState } from "react";
import { Check, Download, Info, LoaderCircle, LockKeyhole, Music2, Pause, Play, Plus, X } from "lucide-react";
import type { Track } from "@/lib/types";
import { durationLabel, sourceLabel } from "./client-utils";

export function Artwork({ track, className = "" }: { track?: Track | null; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <div className={`artwork ${className}`}>
      {track?.artworkUrl && failedUrl !== track.artworkUrl ?
        // Source-hosted images can be absent, oversized or later withdrawn.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={track.artworkUrl} alt={track.album ? `Omslag för ${track.album}` : `Omslag för ${track.title}`} loading="lazy" onError={() => setFailedUrl(track.artworkUrl)} referrerPolicy="no-referrer" /> :
        <><span className="artwork-disc" /><Music2 size={22} strokeWidth={1.5} aria-hidden="true" /></>}
    </div>
  );
}

export default function TrackCard({ track, index, queued, active, playing, busy, queueMode, onPlay, onInfo, onToggle, onDownload }: {
  track: Track;
  index: number;
  queued: boolean;
  active: boolean;
  playing: boolean;
  busy: boolean;
  queueMode?: boolean;
  onPlay: () => void;
  onInfo: () => void;
  onToggle: () => void;
  onDownload: () => void;
}) {
  return (
    <article className={`track-row ${active ? "track-active" : ""}`}>
      <span className="track-number" aria-hidden="true">{active && playing ? <span className="mini-equalizer"><i /><i /><i /></span> : String(index + 1).padStart(2, "0")}</span>
      <div className="track-art-wrap"><Artwork track={track} /><button className="art-play" onClick={onPlay} disabled={!track.playbackAllowed} aria-label={`${active && playing ? "Pausa" : "Spela"} ${track.title}`} title={track.playbackAllowed ? "Spela upp" : "Källan tillåter inte uppspelning"}>{active && playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button></div>
      <div className="track-identity"><h3 title={track.title}>{track.title}</h3><p title={track.artist}>{track.artist}</p><span className="track-mobile-meta">{sourceLabel(track.source)} · {track.format.toUpperCase()} · {durationLabel(track.duration)}</span></div>
      <div className="track-source"><span>{sourceLabel(track.source)}</span><span className="format-label">{track.format.toUpperCase()}{track.album ? ` · ${track.album}` : ""}</span></div>
      <button className={`license-badge ${track.downloadAllowed ? "license-allowed" : "license-blocked"}`} onClick={onInfo} title={track.license.reason}>{track.downloadAllowed ? <Check size={13} /> : <LockKeyhole size={13} />}<span>{track.license.name}</span></button>
      <span className="track-duration">{durationLabel(track.duration)}</span>
      <div className="track-actions">
        <button className="icon-button info-button" onClick={onInfo} aria-label={`Visa källa och licens för ${track.title}`} title="Källa och licens"><Info size={18} /></button>
        <button className={`icon-button ${queued ? "is-selected" : ""}`} onClick={onToggle} aria-pressed={queued} aria-label={`${queued ? "Ta bort" : "Lägg till"} ${track.title} ${queued ? "från" : "i"} nedladdningslistan`} title={queued ? "Ta bort från listan" : "Lägg till i listan"}>{queueMode ? <X size={18} /> : queued ? <Check size={18} /> : <Plus size={18} />}</button>
        <button className={`icon-button track-download ${!track.downloadAllowed ? "unavailable" : ""}`} onClick={track.downloadAllowed ? onDownload : onInfo} disabled={busy} aria-label={track.downloadAllowed ? `Ladda ner ${track.title} som MP3` : `Visa varför ${track.title} inte kan laddas ner`} title={track.downloadAllowed ? "Ladda ner MP3" : "Nedladdningsrättigheter saknas"}>{busy ? <LoaderCircle size={18} className="spin" /> : track.downloadAllowed ? <Download size={18} /> : <LockKeyhole size={17} />}</button>
      </div>
    </article>
  );
}
