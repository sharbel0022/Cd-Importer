"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { wavBlob } from "@/lib/translation/client";
import type { StudioOptions } from "@/lib/translation/types";

export default function TranslationLive({ options, enabled }: { options: StudioOptions; enabled: boolean }) {
  const [active, setActive] = useState(false); const [error, setError] = useState("");
  const [lines, setLines] = useState<{ original: string; translated: string }[]>([]);
  const [latency, setLatency] = useState<number>(); const [pending, setPending] = useState(0);
  const resources = useRef<{ stream?: MediaStream; context?: AudioContext; node?: AudioWorkletNode; abort?: AbortController }>({});
  const running = useRef(false); const queue = useRef<{ blob: Blob; captured: number }[]>([]);
  const processing = useRef(false); const contextText = useRef(""); const player = useRef<HTMLAudioElement | null>(null);
  const audioQueue = useRef<{ url: string; captured: number }[]>([]); const urls = useRef(new Set<string>());
  const liveOptions = useRef(options);
  function stop() {
    running.current = false; queue.current = []; audioQueue.current = [];
    resources.current.abort?.abort(); resources.current.node?.disconnect(); resources.current.stream?.getTracks().forEach((t) => t.stop());
    void resources.current.context?.close(); player.current?.pause();
    urls.current.forEach((url) => URL.revokeObjectURL(url)); urls.current.clear();
    resources.current = {}; setActive(false); setPending(0);
  }
  useEffect(() => () => {
    running.current = false; resources.current.abort?.abort(); resources.current.node?.disconnect(); resources.current.stream?.getTracks().forEach((t) => t.stop()); void resources.current.context?.close(); player.current?.pause(); urls.current.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  function playNext() {
    const next = audioQueue.current.shift(); if (!next || !player.current || !running.current) return;
    player.current.src = next.url;
    player.current.onplaying = () => setLatency(Math.round(performance.now() - next.captured + 4000));
    player.current.onended = () => { URL.revokeObjectURL(next.url); urls.current.delete(next.url); playNext(); };
    void player.current.play().catch(() => { setError("Automatisk uppspelning blockerades. Använd ljudspelarens playknapp."); });
  }
  async function processQueue() {
    if (processing.current) return; processing.current = true;
    try {
      while (queue.current.length && running.current) {
        const item = queue.current.shift()!; setPending(queue.current.length + 1);
        const abort = resources.current.abort!; let original = ""; let translated = "";
        const response = await fetch("/api/translation/live", { method: "POST", signal: abort.signal, headers: { "Content-Type": "audio/wav", "x-studio-options": encodeURIComponent(JSON.stringify(liveOptions.current)), "x-studio-context": encodeURIComponent(contextText.current.slice(-2000)) }, body: item.blob });
        if (!response.ok) { const body = await response.json(); throw new Error(body.error || `HTTP ${response.status}`); }
        const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const event = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
              if (event.type === "error") throw new Error(event.error);
              if (event.type === "transcript") original = event.text;
              if (event.type === "translation") { translated = event.text; contextText.current = (contextText.current + "\n" + original).slice(-2000); setLines((v) => [...v.slice(-49), { original, translated }]); }
              if (event.type === "audio") {
                if (audioQueue.current.length >= 2) throw new Error("Uppspelningen hinner inte med. Live stoppades för att undvika växande fördröjning.");
                const bytes = Uint8Array.from(atob(event.audio), (c) => c.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })); urls.current.add(url);
                audioQueue.current.push({ url, captured: item.captured }); if (!player.current?.src || player.current.ended || player.current.paused) playNext();
              }
            }
          }
        } finally { reader.releaseLock(); }
      }
    } catch (e) { if (running.current) { setError(e instanceof Error ? e.message : "Live misslyckades."); stop(); } }
    finally { processing.current = false; setPending(0); }
  }
  async function start() {
    if (running.current) return;
    setError(""); setLines([]); setLatency(undefined); contextText.current = "";
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) { setError("Live kräver mikrofonåtkomst och AudioWorklet via HTTPS eller localhost."); return; }
    running.current = true; liveOptions.current = { ...options, targets: [options.targets[0]], diarize: false, preserveVoice: false, preserveBackground: false, mode: "replace" };
    resources.current.abort = new AbortController();
    try {
      // Unlock output from the initiating user gesture, including iOS.
      const output = player.current!; output.src = URL.createObjectURL(wavBlob(new Int16Array(160))); urls.current.add(output.src); await output.play();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
      if (!running.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      resources.current.stream = stream; const ctx = new AudioContext(); resources.current.context = ctx; await ctx.resume();
      await ctx.audioWorklet.addModule("/translation/pcm-worklet.js");
      if (!running.current) return;
      const node = new AudioWorkletNode(ctx, "translation-pcm"); resources.current.node = node;
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (!running.current) return;
        if (queue.current.length >= 2) { setError("AI-bearbetningen hinner inte med mikrofonen. Live stoppades. Välj en snabbare modell eller spela in en fil."); stop(); return; }
        const pcm = new Int16Array(event.data); let peak = 0; for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
        if (peak < 180) return;
        queue.current.push({ blob: wavBlob(pcm), captured: performance.now() }); void processQueue();
      };
      stream.getTracks().forEach((t) => t.addEventListener("ended", stop, { once: true }));
      ctx.createMediaStreamSource(stream).connect(node); node.connect(ctx.destination); setActive(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Mikrofonen kunde inte öppnas."); stop(); }
  }
  return <section className="ts-card ts-live">
    <div className="ts-card-title"><div><span className="ts-eyebrow">LIVE TRANSLATE</span><h2>Din röst, ett nytt språk.</h2></div><Mic size={28} /></div>
    <p>Tal skickas i fyra sekunder långa block. Text visas så snart översättningen är klar, följt av AI-tal. Fördröjningen omfattar inspelningsblocket, kön och bearbetningen.</p>
    <p>Live använder det första målspråket och vald standardröst. Ord vid blockgränser kan behöva upprepas. Hörlurar minskar rundgång.</p>
    <p>Tysta eller mycket svaga block skickas inte. Ändrade inställningar eller stopp avslutar väntande ljud.</p>
    <button className={`ts-button ${active ? "ts-danger" : "ts-primary"}`} disabled={!active && !enabled} onClick={() => active ? stop() : void start()}>{active ? <Square size={17} /> : <Mic size={17} />}{active ? "Stoppa Live Translate" : "Starta Live Translate"}</button>
    <div className="ts-live-status" role="status">{active ? `Mikrofon aktiv · ${pending} block bearbetas/väntar` : "Mikrofon av"} · {latency === undefined ? "Fördröjning mäts vid uppspelning" : `Senaste startfördröjning: ${(latency / 1000).toFixed(1)} s`}</div>
    {error && <p className="ts-alert" role="alert">{error}</p>}
    <audio ref={player} controls aria-label="Översatt live-tal" />
    <div className="ts-live-lines" aria-live="polite">{lines.map((line, i) => <article key={i}><p dir="auto">{line.original}</p><strong dir="auto">{line.translated}</strong></article>)}</div>
  </section>;
}
