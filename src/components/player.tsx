"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Headphones, LoaderCircle, Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { trackQuery, type Track } from "@/lib/types";
import { Artwork } from "./track-card";
import { playbackTime } from "./client-utils";

export interface PlaySelection { track: Track; playlist: Track[]; requestId: number }

export default function Player({ selection, onSelect, onActiveChange, onPlayingChange }: {
  selection: PlaySelection | null;
  onSelect: (track: Track, playlist: Track[]) => void;
  onActiveChange: (key: string) => void;
  onPlayingChange: (playing: boolean) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const currentTrack = useRef<Track | null>(null);
  const generation = useRef(0);
  const [active, setActive] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.75);
  const [error, setError] = useState<string>();
  const [muted, setMuted] = useState(false);

  const play = () => {
    const audio = audioRef.current;
    if (!audio || !currentTrack.current) return;
    const attempt = generation.current;
    setError(undefined);
    void audio.play().catch((cause: unknown) => {
      if (attempt !== generation.current || (cause instanceof DOMException && cause.name === "AbortError")) return;
      setLoading(false);
      setError("Uppspelningen kunde inte starta. Försök igen eller lyssna hos originalkällan.");
    });
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!selection || !audio) return;
    if (currentTrack.current?.key === selection.track.key) {
      if (audio.paused) play(); else audio.pause();
      return;
    }
    generation.current += 1;
    audio.pause();
    currentTrack.current = selection.track;
    setActive(selection.track);
    onActiveChange(selection.track.key);
    setTime(0);
    setDuration(selection.track.duration ?? 0);
    setLoading(true);
    setError(undefined);
    audio.src = `/api/audio?${trackQuery(selection.track)}`;
    audio.load();
    play();
    // Each selection is an explicit playback command, including a second click on the same track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, onActiveChange]);

  useEffect(() => {
    if (audioRef.current) { audioRef.current.volume = volume; audioRef.current.muted = muted; }
  }, [volume, muted]);

  const next = (direction: 1 | -1) => {
    const playlist = selection?.playlist.filter((track) => track.playbackAllowed) ?? [];
    if (!active || !playlist.length) return;
    const index = playlist.findIndex((track) => track.key === active.key);
    const track = playlist[(index + direction + playlist.length) % playlist.length];
    if (track.key === active.key) {
      if (audioRef.current) audioRef.current.currentTime = 0;
      play();
    } else onSelect(track, playlist);
  };

  return (
    <footer className="music-player" aria-label="Musikspelare">
      <audio ref={audioRef} preload="metadata" onPlay={() => { setPlaying(true); onPlayingChange(true); setLoading(false); }} onPause={() => { setPlaying(false); onPlayingChange(false); }} onWaiting={() => setLoading(true)} onCanPlay={() => setLoading(false)} onTimeUpdate={() => setTime(audioRef.current?.currentTime ?? 0)} onLoadedMetadata={() => {
        const length = audioRef.current?.duration;
        if (length && Number.isFinite(length)) setDuration(length);
      }} onEnded={() => next(1)} onError={() => {
        if (!currentTrack.current) return;
        setLoading(false);
        setPlaying(false);
        onPlayingChange(false);
        setError("Ljudfilen är inte tillgänglig just nu. Öppna originalkällan för mer information.");
      }} />
      <div className="player-track"><Artwork track={active} className="player-artwork" /><div><strong>{active?.title ?? "Lite tyst här än så länge"}</strong><span>{active?.artist ?? "Välj ett spår och tryck på spela"}</span>{error && active && <a className="player-error" href={active.sourceUrl} target="_blank" rel="noopener noreferrer" title={error}>Lyssna hos källan <ExternalLink size={11} /></a>}</div></div>
      <div className="player-center">
        <div className="player-controls"><button className="icon-button" disabled={!active} onClick={() => next(-1)} aria-label="Föregående spår"><SkipBack size={18} fill="currentColor" /></button><button className="player-play" disabled={!active} onClick={() => audioRef.current?.paused ? play() : audioRef.current?.pause()} aria-label={playing ? "Pausa musiken" : "Spela musiken"}>{loading ? <LoaderCircle size={19} className="spin" /> : playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button><button className="icon-button" disabled={!active} onClick={() => next(1)} aria-label="Nästa spår"><SkipForward size={18} fill="currentColor" /></button></div>
        <div className="player-timeline"><time>{playbackTime(time)}</time><input type="range" className="range-control" aria-label="Uppspelningstid" aria-valuetext={`${playbackTime(time)} av ${playbackTime(duration)}`} min={0} max={duration || 1} step={0.1} value={Math.min(time, duration || 1)} disabled={!active || !duration} style={{ "--range-fill": `${duration ? time / duration * 100 : 0}%` } as React.CSSProperties} onChange={(event) => { const position = Number(event.target.value); if (audioRef.current) { audioRef.current.currentTime = position; setTime(position); } }} /><time>{playbackTime(duration)}</time></div>
      </div>
      <div className="player-volume"><Headphones size={16} className="player-headphones" /><span className="volume-divider" /><button className="icon-button" onClick={() => setMuted((value) => !value)} aria-label={muted ? "Slå på ljudet" : "Stäng av ljudet"}>{muted || volume === 0 ? <VolumeX size={18} /> : volume < 0.5 ? <Volume1 size={18} /> : <Volume2 size={18} />}</button><input className="range-control" type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} aria-label="Volym" aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)} procent`} style={{ "--range-fill": `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties} onChange={(event) => { setVolume(Number(event.target.value)); setMuted(false); }} /></div>
      {error && <span className="sr-only" role="alert">{error}</span>}
    </footer>
  );
}
