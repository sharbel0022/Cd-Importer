import Link from "next/link";
import { capabilities } from "@/lib/translation/providers";
import "../translation.css";
export const dynamic = "force-dynamic";
export default async function TranslationSettings() {
  const caps = await capabilities();
  return <main className="ts-main"><div className="ts-content"><Link href="/translation">← Till studion</Link><h1>AI-konfiguration</h1>
    <section className="ts-card"><h2>Tjänster och modeller</h2><p>{caps.message}</p><dl><dt>Taligenkänning</dt><dd>{caps.asr}</dd><dt>Översättning</dt><dd>{Object.entries(caps.translationModels || { default: caps.translation }).map(([target, model]) => <div key={target}>{target}: {model}</div>)}</dd><dt>AI-tal</dt><dd>{caps.tts}</dd><dt>Bearbetning</dt><dd>{caps.cloud ? "Moln eller hybrid enligt serverns providerinställningar" : "Lokalt"}</dd><dt>Worker</dt><dd>{caps.worker ? "Aktiv" : "Behöver startas"}</dd></dl>
      <h3>Tillgängliga ASR-modeller</h3><ul>{caps.asrModels?.map((m) => <li key={m.id}>{m.label}{m.selected ? " · förvald" : " · segmentjämförelse"}</li>)}</ul>
      <h3>Röster</h3><ul>{caps.voices.map((v) => <li key={v}>{v} · {caps.voiceLanguages[v]?.join(", ") || "providerstöd"} {caps.voiceLocales?.[v]}</li>)}</ul>
    </section>
    <section className="ts-card"><h2>Resurser och licenser</h2><p>{caps.licenseMessage}</p><p>Lokal inferens använder datorns tid, minne och el. Ingen verifierad kostnad per minut eller aktuell API-prislista finns registrerad. Behandlingstiden sparas per jobb; den är inte en kostnadsmätare.</p><p>Modeller, molnnycklar och GPU väljs av serverns administratör. Tillgängliga röster väljs i studion och installerade ASR-modeller jämförs i redigeraren. Avancerade funktioner visas först när tjänsten rapporterar stöd.</p><p><Link href="/translation/guide">Installationsguide och miljöinställningar</Link></p></section>
    <section className="ts-card"><h2>Driftsläge</h2><p>Denna installation använder lokal jobblagring och en lokal worker. Fleranvändardrift, inbjudningar, betalningar och publik AI-backend är inte aktiverade.</p><p>Läppsynk är inte installerad eller verifierad. Tillgänglig diarization, kloning och separering: {caps.diarization ? "diarization" : "ingen diarization"}, {caps.cloning ? "kloning" : "ingen kloning"}, {caps.separation ? "separering" : "ingen separering"}.</p></section>
  </div></main>;
}
