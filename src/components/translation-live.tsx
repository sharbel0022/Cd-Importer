"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { wavBlob } from "@/lib/translation/client";
import { liveCapture, liveElapsed, liveQueueDelay, liveTiming, type LiveBlockMetrics, type LiveCapture } from "@/lib/translation/live-metrics";
import type { StudioOptions } from "@/lib/translation/types";
import { liveRequestBody } from "@/lib/translation/request-options";

type CapturedBlock = LiveCapture & { blob: Blob };
type QueuedAudio = LiveCapture & { url: string };
const seconds = (value?: number) => value === undefined ? "–" : `${(value / 1000).toFixed(2)} s`;

export default function TranslationLive({ options, enabled }: { options: StudioOptions; enabled: boolean }) {
  const [active, setActive] = useState(false); const [error, setError] = useState("");
  const [lines, setLines] = useState<{ original: string; translated: string }[]>([]);
  const [latency, setLatency] = useState<number>(); const [pending, setPending] = useState(0);
  const [metrics, setMetrics] = useState<LiveBlockMetrics[]>([]);
  const [bilingual, setBilingual] = useState(true); const [volume, setVolume] = useState(0.8); const [muted, setMuted] = useState(false);
  const resources = useRef<{ stream?: MediaStream; context?: AudioContext; node?: AudioWorkletNode; abort?: AbortController }>({});
  const running = useRef(false); const queue = useRef<CapturedBlock[]>([]);
  const processing = useRef<number | undefined>(undefined); const session = useRef(0); const blockId = useRef(0);
  const contextText = useRef(""); const player = useRef<HTMLAudioElement | null>(null);
  const audioQueue = useRef<QueuedAudio[]>([]); const currentAudio = useRef<QueuedAudio | undefined>(undefined); const urls = useRef(new Set<string>());
  const liveOptions = useRef(options);
  useEffect(() => { if (player.current) { player.current.volume = volume; player.current.muted = muted; } }, [volume, muted]);
  function updateMetrics(id: number, patch: Partial<LiveBlockMetrics>) {
    setMetrics((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }
  function stop() {
    running.current = false; session.current++; queue.current = []; audioQueue.current = []; currentAudio.current = undefined;
    resources.current.abort?.abort(); resources.current.node?.disconnect(); resources.current.stream?.getTracks().forEach((track) => track.stop());
    void resources.current.context?.close();
    if (player.current) { player.current.onplaying = null; player.current.onended = null; player.current.pause(); player.current.removeAttribute("src"); player.current.load(); }
    urls.current.forEach((url) => URL.revokeObjectURL(url)); urls.current.clear();
    resources.current = {}; setActive(false); setPending(0);
  }
  useEffect(() => () => {
    running.current = false; session.current++; resources.current.abort?.abort(); resources.current.node?.disconnect(); resources.current.stream?.getTracks().forEach((track) => track.stop()); void resources.current.context?.close(); player.current?.pause(); urls.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);
  function playNext(currentSession: number) {
    if (currentAudio.current || currentSession !== session.current || !player.current || !running.current) return;
    const next = audioQueue.current.shift(); if (!next) return;
    currentAudio.current = next; player.current.src = next.url;
    let measured = false;
    player.current.onplaying = () => {
      if (measured || currentSession !== session.current) return;
      measured = true; const elapsed = liveElapsed(next, performance.now()); setLatency(elapsed); updateMetrics(next.id, { audibleMs: elapsed });
    };
    player.current.onended = () => {
      if (currentSession !== session.current) return;
      URL.revokeObjectURL(next.url); urls.current.delete(next.url); currentAudio.current = undefined; playNext(currentSession);
    };
    void player.current.play().catch(() => { if (currentSession === session.current) setError("Automatisk uppspelning blockerades. Använd ljudspelarens playknapp."); });
  }
  async function processQueue(currentSession: number) {
    if (processing.current === currentSession) return; processing.current = currentSession;
    const abort = resources.current.abort!;
    const serverTimings = new Map<number, NonNullable<LiveBlockMetrics["server"]>>();
    try {
      while (queue.current.length && running.current && currentSession === session.current) {
        const item = queue.current.shift()!; setPending(queue.current.length + 1);
        updateMetrics(item.id, { queueMs: liveQueueDelay(item, performance.now()) });
        let original = "";
        const response = await fetch("/api/translation/live", { method: "POST", signal: abort.signal, body: liveRequestBody(liveOptions.current, contextText.current, item.blob) });
        if (!response.ok) { const body = await response.json(); throw new Error(body.error || `HTTP ${response.status}`); }
        if (!response.body) throw new Error("Servern saknar en läsbar liveström.");
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
        try {
          while (currentSession === session.current && running.current) {
            const { value, done } = await reader.read(); if (done) break;
            if (currentSession !== session.current || !running.current) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 12_000_000) throw new Error("Serverns liveblock är för stort för säker uppspelning.");
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const event = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
              if (event.type === "error") throw new Error(event.error);
              if (event.type === "timing") {
                const timing = liveTiming(event);
                if (timing) {
                  const stages = { ...serverTimings.get(item.id), [timing.stage]: { elapsedMs: timing.elapsedMs, durationMs: timing.durationMs } };
                  serverTimings.set(item.id, stages); updateMetrics(item.id, { server: stages });
                }
              }
              if (event.type === "transcript") { original = event.text; updateMetrics(item.id, { transcriptMs: liveElapsed(item, performance.now()) }); }
              if (event.type === "translation") {
                contextText.current = (contextText.current + "\n" + original).slice(-2000);
                setLines((items) => [...items.slice(-49), { original, translated: event.text }]); updateMetrics(item.id, { translationMs: liveElapsed(item, performance.now()) });
              }
              if (event.type === "audio") {
                if (audioQueue.current.length >= 2) throw new Error("Uppspelningen hinner inte med. Live stoppades för att undvika växande fördröjning.");
                const bytes = Uint8Array.from(atob(event.audio), (character) => character.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })); urls.current.add(url);
                updateMetrics(item.id, { audioReadyMs: liveElapsed(item, performance.now()) }); audioQueue.current.push({ ...item, url }); playNext(currentSession);
              }
            }
          }
        } finally { reader.releaseLock(); }
      }
    } catch (cause) { if (running.current && currentSession === session.current) { setError(cause instanceof Error ? cause.message : "Live misslyckades."); stop(); } }
    finally { if (processing.current === currentSession) processing.current = undefined; if (currentSession === session.current) setPending(0); }
  }
  async function start() {
    if (running.current) return;
    setError(""); setLines([]); setMetrics([]); setLatency(undefined); contextText.current = "";
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) { setError("Live kräver mikrofonåtkomst och AudioWorklet via HTTPS eller localhost."); return; }
    const currentSession = ++session.current; running.current = true;
    liveOptions.current = { ...options, targets: [options.targets[0]], diarize: false, preserveVoice: false, preserveBackground: false, mode: "replace" };
    resources.current.abort = new AbortController();
    try {
      // Unlock output from the initiating user gesture, including iOS.
      const output = player.current!; const unlockUrl = URL.createObjectURL(wavBlob(new Int16Array(160))); urls.current.add(unlockUrl); output.src = unlockUrl; await output.play();
      if (currentSession !== session.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
      if (!running.current || currentSession !== session.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      resources.current.stream = stream; const context = new AudioContext(); resources.current.context = context; await context.resume();
      await context.audioWorklet.addModule("/translation/pcm-worklet.js");
      if (!running.current || currentSession !== session.current) return;
      const node = new AudioWorkletNode(context, "translation-pcm"); resources.current.node = node;
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (!running.current || currentSession !== session.current) return;
        if (queue.current.length >= 2) { setError("AI-bearbetningen hinner inte med mikrofonen. Live stoppades. Välj en snabbare modell eller spela in en fil."); stop(); return; }
        const pcm = new Int16Array(event.data); let peak = 0; for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
        if (peak < 180) return;
        const capture = liveCapture(++blockId.current, pcm.length, 16000, performance.now());
        setMetrics((items) => [...items.slice(-11), { id: capture.id, captureMs: capture.captureMs }]);
        queue.current.push({ ...capture, blob: wavBlob(pcm) }); void processQueue(currentSession);
      };
      stream.getTracks().forEach((track) => track.addEventListener("ended", () => { if (currentSession === session.current) stop(); }, { once: true }));
      context.createMediaStreamSource(stream).connect(node); node.connect(context.destination); setActive(true);
    } catch (cause) { if (currentSession === session.current) { setError(cause instanceof Error ? cause.message : "Mikrofonen kunde inte öppnas."); stop(); } }
  }
  return <section className="ts-card ts-live">
    <div className="ts-card-title"><div><span className="ts-eyebrow">LIVE TRANSLATE · BLOCKLÄGE</span><h2>Din röst, ett nytt språk.</h2></div><Mic size={28} /></div>
    <p>Tal skickas i fyra sekunder långa block. Detta är reservläget för batchmodeller: färdig transkription, färdig översättning och färdigt AI-tal kommer i följd. Partiell ASR och strömmande talsyntes stöds inte av de anslutna gränssnitten.</p>
    <p>Live använder det första målspråket och vald standardröst. Ord vid blockgränser kan behöva upprepas. Hörlurar minskar rundgång.</p>
    <p>Tysta eller mycket svaga block skickas inte. Ändrade inställningar eller stopp avslutar väntande ljud. Vid anslutningsfel stoppas mikrofonen; starta igen när anslutningen fungerar.</p>
    <button className={`ts-button ${active ? "ts-danger" : "ts-primary"}`} disabled={!active && !enabled} onClick={() => active ? stop() : void start()}>{active ? <Square size={17} /> : <Mic size={17} />}{active ? "Stoppa Live Translate" : "Starta Live Translate"}</button>
    <div className="ts-live-status" role="status">{active ? `Mikrofon aktiv · ${pending} block bearbetas/väntar` : "Mikrofon av"} · {latency === undefined ? "Fördröjning mäts vid uppspelning" : `Senaste startfördröjning: ${(latency / 1000).toFixed(1)} s`}</div>
    <div className="ts-export-row"><label className="ts-check"><input type="checkbox" checked={bilingual} onChange={(event) => setBilingual(event.target.checked)} /><span>Visa original och översättning</span></label><label className="ts-check"><input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} /><span>Tysta översatt tal</span></label><label>Utvolym {Math.round(volume * 100)} %<input aria-label="Utvolym för live-tal" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></label></div>
    {error && <p className="ts-alert" role="alert">{error}</p>}
    <audio ref={player} controls aria-label="Översatt live-tal" onVolumeChange={(event) => { setVolume(event.currentTarget.volume); setMuted(event.currentTarget.muted); }} />
    {!!metrics.length && <details><summary>Uppmätt blockfördröjning</summary><p className="ts-muted">Text, ljud klart och första uppspelning mäts från början av det inspelade blocket, inklusive ljudblockets längd och kö. Första uppspelning är webbläsarens playing-händelse; fysisk högtalarfördröjning mäts inte. Partiellt transkript: saknas i blockläget.</p><div style={{ overflowX: "auto" }}><table aria-label="Livefördröjning per block"><thead><tr><th scope="col">Block</th><th scope="col">Inspelning</th><th scope="col">Kö</th><th scope="col">Färdigt transkript</th><th scope="col">Översatt text</th><th scope="col">Ljud klart</th><th scope="col">Första uppspelning</th></tr></thead><tbody>{metrics.map((item) => <tr key={item.id}><th scope="row">{item.id}</th><td>{seconds(item.captureMs)}</td><td>{seconds(item.queueMs)}</td><td>{seconds(item.transcriptMs)}</td><td>{seconds(item.translationMs)}</td><td>{seconds(item.audioReadyMs)}</td><td>{seconds(item.audibleMs)}</td></tr>)}</tbody></table></div>{metrics.filter((item) => item.server).map((item) => <p className="ts-muted" key={item.id}>Block {item.id}, servertid per steg: ASR {seconds(item.server?.["asr-final"]?.durationMs)}, översättning {seconds(item.server?.["translation-final"]?.durationMs)}, TTS och ljudberedning {seconds(item.server?.["tts-ready"]?.durationMs)}.</p>)}</details>}
    <div className="ts-live-lines" aria-live="polite">{lines.map((line, index) => <article key={index}>{bilingual && <p dir="auto">{line.original}</p>}<strong dir="auto">{line.translated}</strong></article>)}</div>
  </section>;
}
