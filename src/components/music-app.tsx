"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDownToLine, ArrowRight, AudioLines, Check, CheckCircle2, ChevronDown, Disc3, Download, ExternalLink, FileAudio2, FolderDown, Globe2, Headphones, Info, LibraryBig, ListMusic, LoaderCircle, LockKeyhole, Mic, Music2, Search, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { trackQuery, trackRef, type MusicSource, type SearchResponse, type Track } from "@/lib/types";
import Converter, { type ServiceStatus } from "./converter";
import Dialog from "./dialog";
import Player, { type PlaySelection } from "./player";
import Recorder from "./recorder";
import TrackCard, { Artwork } from "./track-card";
import { durationLabel, isStoredTrack, readableBytes, responseError, responseFilename, safeFilename, saveBlob, sourceLabel } from "./client-utils";

type View = "search" | "queue" | "convert" | "record";
type SourceFilter = "all" | MusicSource;
interface Failure { title: string; message: string; sourceUrl?: string }
interface SavedDownload { filename: string; url: string; sourceUrl?: string; licenseEndpoint?: string }

function parseFailures(value: unknown): Failure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.message !== "string") return [];
    const sourceUrl = typeof record.sourceUrl === "string" && /^https:\/\/(archive\.org|commons\.wikimedia\.org)\//.test(record.sourceUrl) ? record.sourceUrl : undefined;
    return [{ title: typeof record.title === "string" ? record.title : "Okänt spår", message: record.message, sourceUrl }];
  });
}

export default function MusicApp() {
  const [view, setCurrentView] = useState<View>("search");
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [input, setInput] = useState("");
  const [term, setTerm] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [licensedOnly, setLicensedOnly] = useState(true);
  const [searchRevision, setSearchRevision] = useState(0);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [searchError, setSearchError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueReady, setQueueReady] = useState(false);
  const [selection, setSelection] = useState<PlaySelection | null>(null);
  const [activeKey, setActiveKey] = useState("");
  const [playing, setPlaying] = useState(false);
  const [infoTrack, setInfoTrack] = useState<Track | null>(null);
  const [licenseInfo, setLicenseInfo] = useState(false);
  const [toast, setToast] = useState<string>();
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<{ message: string; sourceUrl?: string }>();
  const [savedDownload, setSavedDownload] = useState<SavedDownload>();
  const [failures, setFailures] = useState<Failure[]>([]);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const requestController = useRef<AbortController | null>(null);
  const searchGeneration = useRef(0);
  const playRevision = useRef(0);
  const savedUrl = useRef<string | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const maxQueue = status?.limits.batchTracks ?? 10;

  const setView = useCallback((next: View) => {
    if (recordingBusy && next !== "record") {
      setToast("Avsluta inspelningen eller bearbetningen innan du byter sida.");
      return;
    }
    setCurrentView(next);
  }, [recordingBusy]);

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("ton-download-list-v1") ?? "[]");
      if (Array.isArray(saved)) setQueue(saved.filter(isStoredTrack).slice(0, 10));
    } catch { /* A damaged or unavailable browser store starts with an empty list. */ }
    setQueueReady(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    void fetch("/api/status", { signal: controller.signal }).then(async (response) => {
      if (response.ok) setStatus(await response.json() as ServiceStatus);
    }).catch(() => { /* Individual actions still return their own useful error messages. */ }).finally(() => window.clearTimeout(timeout));
    return () => {
      controller.abort();
      requestController.current?.abort();
      downloadController.current?.abort();
      if (savedUrl.current) URL.revokeObjectURL(savedUrl.current);
    };
  }, []);

  useEffect(() => {
    if (!queueReady) return;
    try { localStorage.setItem("ton-download-list-v1", JSON.stringify(queue)); }
    catch { setToast("Listan kan inte sparas i den här webbläsaren. Den finns kvar medan sidan är öppen."); }
  }, [queue, queueReady]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(undefined), 6000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setView("search");
        window.setTimeout(() => searchInput.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [setView]);

  const runSearch = useCallback(async (query: string, filter: SourceFilter, onlyLicensed: boolean, requestedPage: number, append: boolean) => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const generation = ++searchGeneration.current;
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    setSearchError(undefined);
    if (append) setLoadingMore(true);
    else { setLoading(true); setLoadingMore(false); setTracks([]); setWarnings([]); setHasMore(false); }
    try {
      const params = new URLSearchParams({ q: query, source: filter, page: String(requestedPage), licensedOnly: String(onlyLicensed) });
      const response = await fetch(`/api/search?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response, "Sökningen kunde inte genomföras"));
      const result = await response.json() as SearchResponse;
      if (generation !== searchGeneration.current) return;
      setTracks((current) => {
        const combined = append ? [...current, ...result.tracks] : result.tracks;
        return combined.filter((track, index) => combined.findIndex((item) => item.key === track.key) === index);
      });
      setWarnings(result.warnings);
      setHasMore(result.hasMore);
      setPage(result.page);
    } catch (cause) {
      if (generation !== searchGeneration.current) return;
      setSearchError(controller.signal.aborted ? "Sökningen tog för lång tid. Prova igen eller välj en källa i taget." : cause instanceof Error ? cause.message : "Källan kunde inte nås. Kontrollera anslutningen och försök igen.");
    } finally {
      window.clearTimeout(timeout);
      if (generation === searchGeneration.current) { setLoading(false); setLoadingMore(false); }
    }
  }, []);

  useEffect(() => {
    if (!term) return;
    void runSearch(term, source, licensedOnly, 1, false);
    return () => {
      searchGeneration.current += 1;
      requestController.current?.abort();
    };
  }, [term, source, licensedOnly, searchRevision, runSearch]);

  const search = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 2) { setSearchError("Skriv minst två tecken, till exempel ett låtnamn eller en artist."); searchInput.current?.focus(); return; }
    setInput(trimmed);
    setTerm(trimmed);
    setSearchRevision((current) => current + 1);
    setView("search");
  };

  const selectTrack = useCallback((track: Track, playlist: Track[]) => {
    if (!track.playbackAllowed) { setInfoTrack(track); return; }
    setSelection({ track, playlist: playlist.filter((item) => item.playbackAllowed), requestId: ++playRevision.current });
  }, []);

  const toggleQueue = (track: Track) => {
    const exists = queue.some((item) => item.key === track.key);
    if (exists) { setQueue((current) => current.filter((item) => item.key !== track.key)); setToast("Spåret har tagits bort från din lista."); return; }
    if (queue.length >= maxQueue) { setToast(`Du kan lägga till högst ${maxQueue} spår åt gången. Hämta listan eller ta bort ett spår först.`); return; }
    setQueue((current) => [...current, track]);
    setToast(track.downloadAllowed ? "Spåret har lagts till i din nedladdningslista." : "Spåret har lagts till. Verifierade nedladdningsrättigheter saknas och visas i listan.");
  };

  const rememberDownload = (blob: Blob, filename: string, sourceUrl?: string, licenseEndpoint?: string) => {
    if (savedUrl.current) URL.revokeObjectURL(savedUrl.current);
    const url = saveBlob(blob, filename);
    savedUrl.current = url;
    setSavedDownload({ url, filename, sourceUrl, licenseEndpoint });
  };

  const downloadTrack = async (track: Track) => {
    if (!track.downloadAllowed) { setInfoTrack(track); return; }
    if (downloadBusy || batchBusy) { setToast("En nedladdning pågår. Vänta tills den är klar."); return; }
    setDownloadBusy(track.key);
    setDownloadError(undefined);
    const controller = new AbortController();
    downloadController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 180_000);
    try {
      const response = await fetch(`/api/download?${trackQuery(track)}&bitrate=192`, { signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response, "Spåret kunde inte laddas ner"));
      const blob = await response.blob();
      if (!blob.size) throw new Error("Källan returnerade en tom ljudfil.");
      const filename = responseFilename(response, `${safeFilename(`${track.artist} - ${track.title}`)}.mp3`);
      rememberDownload(blob, filename, track.sourceUrl, `/api/license?${trackQuery(track)}`);
      setToast("Din MP3 är klar. Följ källans licensvillkor när du använder den.");
    } catch (cause) {
      setDownloadError({ message: controller.signal.aborted ? "Nedladdningen tog för lång tid. Försök igen eller öppna originalkällan." : cause instanceof Error ? cause.message : "Nedladdningen misslyckades. Försök igen.", sourceUrl: track.sourceUrl });
    } finally {
      window.clearTimeout(timeout);
      downloadController.current = null;
      setDownloadBusy(null);
    }
  };

  const downloadBatch = async () => {
    const allowed = queue.filter((track) => track.downloadAllowed);
    if (!allowed.length || batchBusy || downloadBusy) return;
    setBatchBusy(true);
    setDownloadError(undefined);
    const blocked = queue.filter((track) => !track.downloadAllowed).map((track) => ({ title: track.title, message: track.license.reason, sourceUrl: track.sourceUrl }));
    setFailures(blocked);
    const controller = new AbortController();
    downloadController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 600_000);
    try {
      const response = await fetch("/api/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracks: allowed.map(trackRef), bitrate: 192 }), signal: controller.signal });
      if (!response.ok) {
        let message = `Listan kunde inte hämtas (${response.status}).`;
        try {
          const body = await response.json() as { error?: string; failures?: unknown };
          if (typeof body.error === "string") message = body.error;
          setFailures([...blocked, ...parseFailures(body.failures)]);
        } catch { /* Preserve the HTTP error. */ }
        throw new Error(message);
      }
      const skipped = response.headers.get("X-Skipped-Tracks");
      if (skipped) {
        try { setFailures([...blocked, ...parseFailures(JSON.parse(decodeURIComponent(skipped)))]); }
        catch { setToast("Läs FEL.json i ZIP-filen för detaljer om eventuella spår som hoppades över."); }
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error("Nedladdningspaketet är tomt. Försök igen.");
      rememberDownload(blob, responseFilename(response, "TON-musik.zip"));
      setToast("Ditt ZIP-paket är klart. Licensinformation finns i LICENSER.json.");
    } catch (cause) {
      setDownloadError({ message: controller.signal.aborted ? "Hämtningen tog för lång tid. Försök med färre spår åt gången." : cause instanceof Error ? cause.message : "Listan kunde inte hämtas. Försök igen." });
    } finally {
      window.clearTimeout(timeout);
      downloadController.current = null;
      setBatchBusy(false);
    }
  };

  const sourceCard = (selectedSource: MusicSource) => {
    setSource(selectedSource);
    window.setTimeout(() => searchInput.current?.focus(), 0);
  };

  const eligible = queue.filter((track) => track.downloadAllowed).length;
  const blockedCount = queue.length - eligible;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Hoppa till innehållet</a>
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("search")} aria-label="TON startsida"><span className="brand-mark"><i /><i /><i /></span><span className="brand-logo">TON<span className="brand-dot" /></span></button>
        <span className="brand-tagline">din musik. dina villkor.</span>
        <div className="sidebar-label">DITT BIBLIOTEK</div>
        <nav className="desktop-navigation" aria-label="Huvudmeny">
          <button className={`nav-item ${view === "search" ? "nav-active" : ""}`} onClick={() => setView("search")} aria-current={view === "search" ? "page" : undefined}><Search size={20} /><span>Upptäck musik</span></button>
          <button className={`nav-item ${view === "queue" ? "nav-active" : ""}`} onClick={() => setView("queue")} aria-current={view === "queue" ? "page" : undefined}><ListMusic size={20} /><span>Nedladdningslista</span><span className="nav-count">{queue.length}</span></button>
          <button className={`nav-item ${view === "convert" ? "nav-active" : ""}`} onClick={() => setView("convert")} aria-current={view === "convert" ? "page" : undefined}><FileAudio2 size={20} /><span>Konvertera & CD</span></button>
          <button className={`nav-item ${view === "record" ? "nav-active" : ""}`} onClick={() => setView("record")} aria-current={view === "record" ? "page" : undefined}><Mic size={20} /><span>Spela in ljud</span></button>
        </nav>
        <div className="sidebar-divider" />
        <div className="sidebar-label">ÖPPNA MUSIKKÄLLOR</div>
        <div className="sidebar-source"><span className="source-glyph"><LibraryBig size={16} /></span><span>Internet Archive<small>Musik från världens arkiv</small></span></div>
        <div className="sidebar-source"><span className="source-glyph"><Globe2 size={16} /></span><span>Wikimedia Commons<small>Ljud med öppna licenser</small></span></div>
        <div className="sidebar-bottom"><div className="sidebar-note"><span className="note-icon"><ShieldCheck size={19} /></span><strong>Musik med tillstånd.</strong><p>Hitta öppna inspelningar.<br />Spara med respekt för skaparen.</p><button onClick={() => setLicenseInfo(true)}>Så fungerar licenser <ArrowRight size={13} /></button></div><span className="sidebar-footer">BYGGT FÖR DIN MUSIK <AudioLines size={14} /></span></div>
      </aside>
      <div className="workspace">
        <header className="topbar"><div className="topbar-location"><span>Bibliotek</span><span className="breadcrumb-slash">/</span><strong>{view === "search" ? "Upptäck" : view === "queue" ? "Din lista" : view === "record" ? "Spela in ljud" : "Dina ljudfiler"}</strong></div><button className="topbar-license" onClick={() => setLicenseInfo(true)}><span className="small-dot" /> Verklig musik. Tydliga licenser.<ShieldCheck size={15} /></button><div className="mobile-brand">TON<span className="brand-dot" /></div></header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {view === "search" && <>
            <section className="search-hero"><div className="hero-copy"><div className="section-eyebrow"><span className="small-dot" /> UPPTÄCK UTAN GRÄNSER</div><h1>Hitta ljud.<br /><span>Behåll musiken.</span></h1><p>Från okända pärlor till tidlösa inspelningar.<br className="desktop-break" /> Sök, lyssna och ladda ner med tillstånd.</p><div className="hero-tags"><span><Globe2 size={13} /> Öppna arkiv</span><span><Headphones size={13} /> Lyssna direkt</span><span><ArrowDownToLine size={13} /> Riktig MP3</span></div></div><div className="record-art" aria-hidden="true"><div className="record-topline"><span>TON / ÖPPNA ARKIV</span><AudioLines size={20} /></div><div className="vinyl-record"><div className="vinyl-label"><span>TON</span><i /><small>LJUD UTAN GRÄNSER</small></div></div><span className="record-bottomline">MER MUSIK. FLER MÖJLIGHETER.</span><span className="record-plus">+</span></div></section>
            <section className="search-section" aria-label="Sök efter musik">
              <form className="search-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); search(input); }}><Search className="search-field-icon" size={23} strokeWidth={1.7} /><input ref={searchInput} value={input} onChange={(event) => setInput(event.target.value)} type="search" name="q" placeholder="Sök efter en låt, artist eller något nytt…" aria-label="Låtnamn eller artist" autoComplete="off" maxLength={150} minLength={2} /><kbd>Ctrl K</kbd><button type="submit" className="search-submit" disabled={loading}>{loading ? <LoaderCircle size={17} className="spin" /> : <><span>Sök musik</span><ArrowRight size={18} /></>}</button></form>
              <div className="search-filters"><div className="source-filters" role="group" aria-label="Välj musikkälla">{([{ value: "all", text: "Alla källor" }, { value: "archive", text: "Internet Archive" }, { value: "commons", text: "Wikimedia Commons" }] as const).map((filter) => <button key={filter.value} className={`source-filter ${source === filter.value ? "filter-active" : ""}`} aria-pressed={source === filter.value} onClick={() => setSource(filter.value)}>{filter.value === "all" && <AudioLines size={14} />}{filter.text}</button>)}</div><label className="license-filter"><input type="checkbox" checked={licensedOnly} onChange={(event) => setLicensedOnly(event.target.checked)} /><span className="toggle-track" /><span>Bara med nedladdningstillstånd</span><Info size={13} aria-hidden="true" /></label></div>
            </section>
            {downloadError && <DownloadError value={downloadError} onClose={() => setDownloadError(undefined)} />}
            {savedDownload && <DownloadSuccess value={savedDownload} onClose={() => setSavedDownload(undefined)} />}
            {searchError && <div className="notice notice-error search-notice" role="alert"><Info size={18} /><span>{searchError}</span>{term && <button onClick={() => setSearchRevision((current) => current + 1)}>Försök igen</button>}</div>}
            {warnings.length > 0 && <div className="notice notice-warning search-notice" role="status"><Info size={18} /><div>{warnings.map((warning, index) => <p key={`${warning}-${index}`}>{warning}</p>)}</div></div>}
            {term ? <section className="results-section" aria-label="Sökresultat"><div className="section-heading"><div><span className="section-kicker">DIN SÖKNING</span><h2>Resultat för <span>”{term}”</span></h2></div><span className="result-count">{loading ? "Söker i arkiven…" : `${tracks.length} ${tracks.length === 1 ? "spår" : "spår"}`}{tracks.length > 0 && <Music2 size={15} />}</span></div>{loading ? <div className="loading-results" role="status" aria-label="Söker efter musik">{[0, 1, 2, 3].map((item) => <div className="skeleton-row" key={item}><span className="skeleton-art" /><div><span /><span /></div><span className="skeleton-meta" /></div>)}<p><LoaderCircle size={16} className="spin" /> Hämtar verkliga ljudfiler och kontrollerar licenser…</p></div> : tracks.length > 0 ? <><div className="track-list-heading"><span>SPÅR</span><span>KÄLLA & FORMAT</span><span>LICENS</span><span>TID</span><span /></div><div className="track-list">{tracks.map((track, index) => <TrackCard key={track.key} track={track} index={index} active={activeKey === track.key} playing={playing} queued={queue.some((item) => item.key === track.key)} busy={downloadBusy === track.key} onPlay={() => selectTrack(track, tracks)} onInfo={() => setInfoTrack(track)} onToggle={() => toggleQueue(track)} onDownload={() => void downloadTrack(track)} />)}</div>{hasMore && <div className="load-more-wrap"><button className="button button-secondary" disabled={loadingMore} onClick={() => void runSearch(term, source, licensedOnly, page + 1, true)}>{loadingMore ? <LoaderCircle size={17} className="spin" /> : <ChevronDown size={17} />} {loadingMore ? "Hämtar fler spår…" : "Visa fler resultat"}</button></div>}<p className="results-footnote"><ShieldCheck size={13} /> Licenser hämtas från originalkällan och kontrolleras igen vid nedladdning.</p></> : !searchError && <div className="empty-state search-empty"><span className="empty-icon"><Search size={30} strokeWidth={1.3} /></span><h3>Inga spår hittades den här gången.</h3><p>Prova ett annat artistnamn eller en bredare sökning.{licensedOnly && " Du kan också visa spår utan verifierat nedladdningstillstånd."}</p>{licensedOnly && <button className="button button-secondary" onClick={() => setLicensedOnly(false)}>Visa alla licensstatusar <ArrowRight size={15} /></button>}</div>}</section> : <>
              <section className="discover-section"><div className="section-heading"><div><span className="section-kicker">STORA ARKIV. SMÅ UPPTÄCKTER.</span><h2>En värld av öppet ljud.</h2></div><span className="section-counter">01 — 03</span></div><div className="source-cards"><button className="source-card archive-card" onClick={() => sourceCard("archive")}><div className="source-card-top"><span className="provider-icon"><LibraryBig size={23} strokeWidth={1.5} /></span><span className="provider-label">OFFICIELL KÄLLA</span></div><h3>Internet Archive</h3><p>Musik, liveinspelningar och historiska ljud. Ett arkiv att gå vilse i.</p><span className="source-card-link">Utforska arkivet <ArrowRight size={17} /></span><span className="card-watermark" aria-hidden="true"><LibraryBig size={120} strokeWidth={0.7} /></span></button><button className="source-card commons-card" onClick={() => sourceCard("commons")}><div className="source-card-top"><span className="provider-icon"><Globe2 size={23} strokeWidth={1.5} /></span><span className="provider-label">OFFICIELL KÄLLA</span></div><h3>Wikimedia Commons</h3><p>Öppna ljud från hela världen, med licenser som följer med varje spår.</p><span className="source-card-link">Upptäck Commons <ArrowRight size={17} /></span><span className="card-watermark" aria-hidden="true"><Globe2 size={120} strokeWidth={0.7} /></span></button><button className="source-card own-card" onClick={() => setView("convert")}><div className="source-card-top"><span className="provider-icon"><Disc3 size={23} strokeWidth={1.5} /></span><span className="provider-label">DITT EGET LJUD</span></div><h3>Din musik. Som MP3.</h3><p>Ge dina egna ljudfiler ett nytt format. Välj kvalitet och ta musiken med dig.</p><span className="source-card-link">Konvertera en fil <ArrowRight size={17} /></span><span className="card-watermark" aria-hidden="true"><Disc3 size={120} strokeWidth={0.7} /></span></button></div></section>
              <section className="search-inspiration"><div><Sparkles size={18} /><span>Var börjar man?</span><p>Prova en stil och hitta något oväntat.</p></div><div className="suggestion-buttons">{["Jazz", "Piano", "Klassisk musik", "Ambient"].map((suggestion) => <button key={suggestion} onClick={() => search(suggestion === "Klassisk musik" ? "classical" : suggestion)}>{suggestion}<ArrowRight size={13} /></button>)}</div></section>
            </>}
          </>}
          {view === "queue" && <section className="queue-page"><div className="section-eyebrow"><span className="small-dot" /> SAMLAT FÖR DIG</div><div className="page-heading queue-heading"><div><h1>Din nästa<br /><span>musiksamling.</span></h1><p>Välj dina spår. Hämta dem tillsammans.<br className="desktop-break" /> Källor och licenser följer med i paketet.</p></div><div className="queue-total"><FolderDown size={28} strokeWidth={1.3} /><strong>{String(queue.length).padStart(2, "0")}</strong><span>VALDA SPÅR</span></div></div><div className="queue-toolbar"><div><span><span className="small-dot" /> {eligible} kan hämtas</span>{blockedCount > 0 && <span className="blocked-count"><LockKeyhole size={13} /> {blockedCount} saknar tillstånd</span>}</div><button className="button button-primary" onClick={() => void downloadBatch()} disabled={!eligible || batchBusy || !!downloadBusy}>{batchBusy ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}{batchBusy ? "Skapar ditt ZIP-paket…" : "Hämta som ZIP"}</button></div>{batchBusy && <p className="batch-status" role="status">Filerna hämtas och konverteras vid behov. Det kan ta en stund. Stanna kvar tills paketet är klart.</p>}{downloadError && <DownloadError value={downloadError} onClose={() => setDownloadError(undefined)} />}{savedDownload && <DownloadSuccess value={savedDownload} onClose={() => setSavedDownload(undefined)} />}{failures.length > 0 && <div className="failed-tracks notice notice-warning"><Info size={19} /><div><strong>Följande spår kunde inte hämtas</strong>{failures.map((failure, index) => <p key={`${failure.title}-${index}`}><b>{failure.title}</b> — {failure.message}{failure.sourceUrl && <a href={failure.sourceUrl} target="_blank" rel="noopener noreferrer"> Originalkälla <ExternalLink size={11} /></a>}</p>)}</div></div>}{queue.length ? <><div className="track-list">{queue.map((track, index) => <TrackCard key={track.key} track={track} index={index} active={activeKey === track.key} playing={playing} queued={true} queueMode busy={downloadBusy === track.key} onPlay={() => selectTrack(track, queue)} onInfo={() => setInfoTrack(track)} onToggle={() => toggleQueue(track)} onDownload={() => void downloadTrack(track)} />)}</div><div className="queue-footer"><p><ShieldCheck size={14} /> Upp till {maxQueue} spår. Vi kontrollerar varje fil och licens innan hämtning.</p><button className="text-button" disabled={batchBusy} onClick={() => { setQueue([]); setFailures([]); setToast("Din nedladdningslista har tömts."); }}><Trash2 size={14} /> Töm listan</button></div>{blockedCount > 0 && <div className="blocked-explanation"><LockKeyhole size={19} /><div><strong>Några spår saknar verifierade rättigheter.</strong><p>De följer inte med i ZIP-filen. Klicka på licensen för att se källans information och varför nedladdningen inte är tillgänglig.</p></div></div>}<div className="zip-note"><FolderDown size={20} /><p>ZIP-paketet innehåller riktiga MP3-filer, <strong>LICENSER.json</strong> med källa och attribution samt <strong>FEL.json</strong> om någon fil inte kunde hämtas.</p></div></> : <div className="empty-state queue-empty"><span className="empty-icon"><ListMusic size={36} strokeWidth={1.2} /></span><h2>En tom lista. Oändliga möjligheter.</h2><p>Tryck på plus bredvid ett spår i sökresultaten.<br />Dina val sparas i den här webbläsaren.</p><button className="button button-primary" onClick={() => { setView("search"); window.setTimeout(() => searchInput.current?.focus(), 0); }}>Hitta ditt första spår <ArrowRight size={16} /></button></div>}</section>}
          {view === "convert" && <Converter status={status} />}
          <div hidden={view !== "record"}><Recorder status={status} onRecordingChange={setRecordingBusy} /></div>
          <div className="content-footer"><span>TON<span className="footer-dot">.</span> <span>En plats för öppet ljud.</span></span><button onClick={() => setLicenseInfo(true)}>Källor & licenser <ArrowRight size={12} /></button></div>
        </main>
      </div>
      <nav className="mobile-navigation" aria-label="Mobilmeny">
        <button className={view === "search" ? "mobile-nav-active" : ""} onClick={() => setView("search")} aria-current={view === "search" ? "page" : undefined}><Search size={20} /><span>Upptäck</span></button>
        <button className={view === "queue" ? "mobile-nav-active" : ""} onClick={() => setView("queue")} aria-current={view === "queue" ? "page" : undefined}><span className="mobile-queue-icon"><ListMusic size={20} />{queue.length > 0 && <i>{queue.length}</i>}</span><span>Din lista</span></button>
        <button className={view === "convert" ? "mobile-nav-active" : ""} onClick={() => setView("convert")} aria-current={view === "convert" ? "page" : undefined}><FileAudio2 size={20} /><span>Konvertera</span></button>
        <button className={view === "record" ? "mobile-nav-active" : ""} onClick={() => setView("record")} aria-current={view === "record" ? "page" : undefined}><Mic size={20} /><span>Spela in ljud</span></button>
      </nav>
      <Player selection={selection} onSelect={selectTrack} onActiveChange={setActiveKey} onPlayingChange={setPlaying} suspended={recordingBusy} />
      {toast && <div className="toast" role="status"><CheckCircle2 size={18} /><span>{toast}</span><button className="icon-button" onClick={() => setToast(undefined)} aria-label="Stäng meddelandet"><X size={15} /></button></div>}
      {infoTrack && <TrackInfo track={infoTrack} onClose={() => setInfoTrack(null)} onDownload={() => void downloadTrack(infoTrack)} busy={downloadBusy === infoTrack.key} downloadError={downloadError?.sourceUrl === infoTrack.sourceUrl ? downloadError.message : undefined} savedDownload={savedDownload?.sourceUrl === infoTrack.sourceUrl ? savedDownload : undefined} />}
      {licenseInfo && <Dialog title="Musik med tydliga villkor" onClose={() => setLicenseInfo(false)}><div className="legal-intro"><ShieldCheck size={26} /><p>TON hjälper dig hitta ljud som originalkällan gör tillgängligt. Upphovsrätt och licensvillkor följer alltid med musiken.</p></div><div className="license-explanation"><h3><Check size={17} /> Verifierat nedladdningstillstånd</h3><p>En känd öppen licens eller en public domain-markering finns i källans metadata. Appen kontrollerar licensen och filens tillgänglighet igen när du hämtar den.</p><h3><LockKeyhole size={17} /> Saknad eller oklar licens</h3><p>Att en fil finns på internet ger inte automatiskt rätt att ladda ner den. När vi saknar tydligt stöd i licensen erbjuder appen ingen MP3-nedladdning.</p><h3><Info size={17} /> Följ licensen när du använder musiken</h3><p>Vissa licenser kräver att du anger skapare och källa, begränsar kommersiell användning eller kräver att bearbetningar delas med samma licens. Läs alltid villkoren för varje spår. Ingen nedladdning kringgår skyddade strömmar eller DRM.</p></div><div className="legal-sources"><a href="https://archive.org/about/terms.php" target="_blank" rel="noopener noreferrer">Internet Archives villkor <ExternalLink size={14} /></a><a href="https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia" target="_blank" rel="noopener noreferrer">Återanvända Wikimedia Commons <ExternalLink size={14} /></a></div><p className="dialog-footnote">Sökning hos dessa källor kräver ingen registrering eller API-nyckel. Originalkällans villkor gäller.</p></Dialog>}
    </div>
  );
}

function DownloadError({ value, onClose }: { value: { message: string; sourceUrl?: string }; onClose: () => void }) {
  return <div className="notice notice-error download-notice" role="alert"><Info size={19} /><div><strong>Nedladdningen kunde inte slutföras</strong><p>{value.message}</p>{value.sourceUrl && <a href={value.sourceUrl} target="_blank" rel="noopener noreferrer">Öppna originalkällan <ExternalLink size={13} /></a>}</div><button className="icon-button" onClick={onClose} aria-label="Stäng felmeddelandet"><X size={16} /></button></div>;
}

function DownloadSuccess({ value, onClose }: { value: SavedDownload; onClose: () => void }) {
  return <div className="notice notice-success download-notice" role="status"><CheckCircle2 size={19} /><div><strong>Din fil är klar: {value.filename}</strong><p>Om hämtningen inte startade, <a href={value.url} download={value.filename}>klicka här för att spara filen</a>.{value.sourceUrl && <> Du kan också <a href={value.sourceUrl} target="_blank" rel="noopener noreferrer">öppna originalkällan <ExternalLink size={11} /></a>.</>}</p>{value.licenseEndpoint && <p><a href={value.licenseEndpoint} download>Spara även källa och licensinformation <Download size={11} /></a></p>}</div><button className="icon-button" onClick={onClose} aria-label="Stäng nedladdningsmeddelandet"><X size={16} /></button></div>;
}

function TrackInfo({ track, onClose, onDownload, busy, downloadError, savedDownload }: { track: Track; onClose: () => void; onDownload: () => void; busy: boolean; downloadError?: string; savedDownload?: SavedDownload }) {
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [licenseError, setLicenseError] = useState<string>();
  const downloadLicense = async () => {
    if (licenseBusy) return;
    setLicenseBusy(true);
    setLicenseError(undefined);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(`/api/license?${trackQuery(track)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response, "Licensinformationen kunde inte hämtas"));
      const url = saveBlob(await response.blob(), responseFilename(response, `${safeFilename(`${track.artist} - ${track.title}`)}.licens.json`));
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setLicenseError(controller.signal.aborted ? "Licensinformationen kunde inte hämtas i tid. Försök igen." : cause instanceof Error ? cause.message : "Licensinformationen kunde inte hämtas.");
    } finally { window.clearTimeout(timeout); setLicenseBusy(false); }
  };
  return <Dialog title="Om spåret" onClose={onClose}><div className="info-track-header"><Artwork track={track} /><div><span>{sourceLabel(track.source)}</span><h3>{track.title}</h3><p>{track.artist}</p></div></div><dl className="track-info-grid"><div><dt>Filformat</dt><dd>{track.format.toUpperCase()}</dd></div><div><dt>Längd</dt><dd>{durationLabel(track.duration)}</dd></div>{track.album && <div><dt>Album</dt><dd>{track.album}</dd></div>}{track.size && <div><dt>Originalfilens storlek</dt><dd>{readableBytes(track.size)}</dd></div>}</dl><div className={`info-license-box ${track.downloadAllowed ? "info-license-allowed" : "info-license-blocked"}`}>{track.downloadAllowed ? <ShieldCheck size={22} /> : <LockKeyhole size={22} />}<div><strong>{track.downloadAllowed ? "MP3-nedladdning tillåten enligt källans licens" : "MP3-nedladdning inte tillgänglig"}</strong><p>{track.license.reason}</p><span>{track.license.name}</span></div></div>{track.license.attribution && <div className="attribution-box"><h4>Attribution från källan</h4><p>{track.license.attribution}</p><span>Behåll attributionen och följ licensens villkor när du använder spåret.</span></div>}<div className="info-links"><a href={track.sourceUrl} target="_blank" rel="noopener noreferrer">Visa originalkällan <ExternalLink size={14} /></a>{track.license.url && <a href={track.license.url} target="_blank" rel="noopener noreferrer">Läs licensvillkoren <ExternalLink size={14} /></a>}<button onClick={() => void downloadLicense()} disabled={licenseBusy}>{licenseBusy ? "Hämtar licensinformation…" : "Spara licensinformation"}{licenseBusy ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}</button></div>{licenseError && <div className="notice notice-error download-notice" role="alert">{licenseError}</div>}{track.downloadAllowed && <button className="button button-primary info-download" onClick={onDownload} disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}{busy ? "Hämtar MP3…" : "Ladda ner MP3"}</button>}{downloadError && <div className="notice notice-error download-notice" role="alert">{downloadError}</div>}{savedDownload && <div className="notice notice-success download-notice" role="status"><CheckCircle2 size={18} /><div><strong>Din MP3 är klar</strong><p><a href={savedDownload.url} download={savedDownload.filename}>Hämta filen igen</a> och spara licensinformationen ovan.</p></div></div>}<p className="dialog-footnote">Uppspelning: {track.playbackAllowed ? "tillgänglig från källan" : "inte tillgänglig"}. Rättigheterna kontrolleras på servern vid varje hämtning.</p></Dialog>;
}
