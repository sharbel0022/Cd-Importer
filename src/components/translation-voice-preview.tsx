"use client";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Play } from "lucide-react";
import type { StudioOptions } from "@/lib/translation/types";

const samples: Record<string, string> = { en: "Hello. This is a preview of your translated voice. Names and numbers should remain clear.", sv: "Hej. Det här är ett röstprov för din översättning. Namn och siffror ska höras tydligt.", ar: "مرحبًا. هذه معاينة للصوت المترجم. يجب أن تكون الأسماء والأرقام واضحة." };

export default function TranslationVoicePreview({ options, enabled }: { options: StudioOptions; enabled: boolean }) {
  const language = options.targets[0];
  const [text, setText] = useState(samples[language] || ""); const [url, setUrl] = useState(""); const [voice, setVoice] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (url) return () => URL.revokeObjectURL(url); }, [url]);
  async function preview() {
    setBusy(true); setError(""); setUrl("");
    const abort = new AbortController(); request.current = abort;
    try {
      const response = await fetch("/api/translation/preview", { method: "POST", signal: abort.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, options: { ...options, targets: [language], diarize: false, preserveBackground: false } }) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || "Röstprovet kunde inte skapas."); }
      setVoice(response.headers.get("X-Studio-Voice") || "");
      setUrl(URL.createObjectURL(await response.blob()));
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Röstprovet kunde inte skapas."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  return <div className="ts-voice-preview"><label>Text för röstprov<textarea dir="auto" value={text} maxLength={400} onChange={(e) => setText(e.target.value)} placeholder="Skriv en kort text på målspråket" /></label><button className="ts-button" disabled={!enabled || !text.trim() || busy || options.preserveVoice || options.mode === "subtitles"} onClick={() => void preview()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{busy ? "Skapar röstprov…" : "Förhandslyssna på AI-röst"}</button>{url && <><audio src={url} controls aria-label="AI-röstprov" />{voice && <p className="ts-muted">Röst i provet: {voice}</p>}</>}{error && <p className="ts-alert" role="alert">{error}</p>}<p className="ts-muted">Röstprov använder vald röst och taltempo för första målspråket. Bekräfta rättigheter och eventuell molnbearbetning först.</p></div>;
}
