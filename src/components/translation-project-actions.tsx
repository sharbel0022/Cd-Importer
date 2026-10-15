"use client";
import { useState } from "react";
import { Copy, Save } from "lucide-react";
import { jsonRequest } from "@/lib/translation/client";
import type { Job } from "@/lib/translation/types";

export default function TranslationProjectActions({ job, disabled = false, onUpdated, onDuplicated }: { job: Job; disabled?: boolean; onUpdated: (job: Job) => void; onDuplicated: (job: Job) => void }) {
  const [name, setName] = useState(job.name); const [busy, setBusy] = useState<"rename" | "duplicate">(); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  async function submit(action: "rename" | "duplicate") {
    if (busy || disabled) return; setBusy(action); setError(""); setNotice("");
    try {
      const next = await jsonRequest<Job>(`/api/translation/jobs/${job.id}/project`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, revision: job.revision, ...(action === "rename" ? { name } : {}) }) });
      if (action === "duplicate") onDuplicated(next); else { setName(next.name); setNotice("Projektnamnet är sparat."); onUpdated(next); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Projektet kunde inte uppdateras."); }
    finally { setBusy(undefined); }
  }
  const canDuplicate = ["paused", "review", "failed", "completed"].includes(job.status) && !job.command;
  return <div className="ts-project-actions">
    <form className="ts-export-row" onSubmit={(event) => { event.preventDefault(); void submit("rename"); }}><label>Projektnamn<input maxLength={200} value={name} disabled={disabled || !!busy} onChange={(event) => setName(event.target.value)} /></label><button className="ts-button" disabled={disabled || !!busy || !name.trim() || name.trim() === job.name} type="submit"><Save size={15} />{busy === "rename" ? "Sparar namn…" : "Spara projektnamn"}</button><button className="ts-button" type="button" disabled={disabled || !!busy || !canDuplicate} onClick={() => void submit("duplicate")}><Copy size={15} />{busy === "duplicate" ? "Kopierar projekt…" : "Duplicera projekt"}</button></form>
    <p className="ts-muted">En kopia behåller originalmedia, transkript, rättningar och inställningar. Nya ljudfiler och exporter skapas först när du återupptar kopian. Pausa ett pågående projekt före kopiering.{disabled ? " Spara redigerarens utkast först." : ""}</p>
    {error && <p className="ts-alert" role="alert">{error}</p>}{notice && <p className="ts-muted" role="status">{notice}</p>}
  </div>;
}
