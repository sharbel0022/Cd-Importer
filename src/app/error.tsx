"use client";

import { RefreshCw } from "lucide-react";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="fallback-page">
      <div className="brand-logo">TON<span className="brand-dot" /></div>
      <h1>Något kom i otakt.</h1>
      <p>Sidan kunde inte visas. Försök igen så hjälper vi dig tillbaka till musiken.</p>
      <button className="button button-primary" onClick={reset}><RefreshCw size={18} /> Försök igen</button>
    </main>
  );
}
