"use client";
import { useEffect, useRef, useState } from "react";
import { glossarySchema, type GlossaryEntry, type StudioOptions } from "@/lib/translation/types";

const key = "cd-importer.terminology.v1";
export default function TranslationGlossary({ options, onChange }: { options: StudioOptions; onChange: (value: Partial<StudioOptions>) => void }) {
  const [source, setSource] = useState(""); const [translation, setTranslation] = useState(""); const [protect, setProtect] = useState(false);
  const [abbreviation, setAbbreviation] = useState(""); const [message, setMessage] = useState(""); const [loaded, setLoaded] = useState(false);
  const input = useRef<HTMLInputElement>(null); const entries = options.glossary || [];
  useEffect(() => {
    try { const saved = localStorage.getItem(key); if (saved) { const result = glossarySchema.safeParse(JSON.parse(saved)); if (result.success) onChange({ glossary: result.data }); else setMessage("Den sparade ordlistan kunde inte läsas."); } }
    catch { setMessage("Webbläsaren tillåter inte lokal lagring av ordlistan."); }
    setLoaded(true);
    // Load the reusable browser library once, independently of job options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (loaded) try { localStorage.setItem(key, JSON.stringify(entries)); } catch { setMessage("Ordlistan används i jobbet men kunde inte sparas i webbläsaren."); } }, [loaded, options.glossary]); // eslint-disable-line react-hooks/exhaustive-deps
  function replace(value: unknown) {
    const result = glossarySchema.safeParse(value);
    if (!result.success) { setMessage("Ogiltig ordlista. Högst 100 uttryck med källa och översättning eller ordskydd."); return false; }
    onChange({ glossary: result.data }); setMessage(`${result.data.length} uttryck sparade för nya jobb i den här webbläsaren.`); return true;
  }
  function add() {
    const entry: GlossaryEntry = { source, translation, protect, target: options.targets[0], ...(abbreviation ? { abbreviation } : {}) };
    if (replace([...entries.filter((e) => !(e.source === source && e.target === entry.target)), entry])) { setSource(""); setTranslation(""); setAbbreviation(""); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "cd-importer-glossary.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <details className="ts-consent"><summary>Ordlista & ämnesområde · {entries.length} uttryck</summary>
    <label>Ämnesområde<select value={options.domain || "general"} onChange={(e) => onChange({ domain: e.target.value as StudioOptions["domain"] })}>{[["general", "Allmänt samtal"], ["sports", "Sport"], ["medical", "Medicin"], ["technology", "Teknik"], ["business", "Affärer"], ["education", "Utbildning"]].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    <p className="ts-muted">Uttryck gäller nya jobb. Ordlistan sparas i den här webbläsaren och skickas med jobbet till vald översättare. Ämnesområdet ändrar aldrig vad som hörs i ljudet.</p>
    <label>Namn eller uttryck<input value={source} maxLength={160} onChange={(e) => setSource(e.target.value)} /></label>
    <label className="ts-check"><input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} /><span>Behåll uttrycket oförändrat</span></label>
    {!protect && <label>Föredragen översättning ({options.targets[0]})<input value={translation} maxLength={240} onChange={(e) => setTranslation(e.target.value)} /></label>}
    <label>Förkortningens betydelse, valfri<input value={abbreviation} maxLength={240} onChange={(e) => setAbbreviation(e.target.value)} /></label>
    <button type="button" className="ts-button" disabled={!source.trim() || !protect && !translation.trim() || entries.length >= 100} onClick={add}>Spara uttryck</button>
    <ul style={{ overflowWrap: "anywhere" }}>{entries.map((entry, n) => <li key={`${n}-${entry.source}`}>{entry.source} → {entry.protect ? "oförändrat" : entry.translation} ({entry.target}) <button type="button" className="ts-button" aria-label={`Ta bort ${entry.source}`} onClick={() => replace(entries.filter((_, i) => i !== n))}>Ta bort</button></li>)}</ul>
    <div className="ts-actions"><button type="button" className="ts-button" onClick={() => input.current?.click()}>Importera JSON</button><button type="button" className="ts-button" disabled={!entries.length} onClick={download}>Exportera JSON</button><button type="button" className="ts-button" disabled={!entries.length} onClick={() => replace([])}>Rensa ordlista</button></div>
    <input ref={input} type="file" hidden accept="application/json,.json" aria-label="Importera ordlista" onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; if (file.size > 128000) { setMessage("Ordlistan får vara högst 128 kB."); return; } try { replace(JSON.parse(await file.text())); } catch { setMessage("Filen innehåller inte giltig JSON."); } }} />
    {message && <p role="status">{message}</p>}
  </details>;
}
