import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <main className="fallback-page">
      <div className="brand-logo">TON<span className="brand-dot" /></div>
      <h1>Här finns inget spår.</h1>
      <p>Sidan finns inte. Börja med en sökning för att hitta din musik.</p>
      <Link className="button button-primary" href="/"><ArrowLeft size={18} /> Till sökningen</Link>
    </main>
  );
}
