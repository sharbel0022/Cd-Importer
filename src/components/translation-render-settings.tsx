"use client";
import type { Capabilities, StudioOptions } from "@/lib/translation/types";
export const defaultMix = { speechGainDb: 0, backgroundGainDb: 0, originalGainDb: -16.5, fadeInSeconds: 0, fadeOutSeconds: 0, loudnessLufs: -16, normalize: true };
export const defaultSubtitles = { bilingual: false, speakerLabels: false, burnIn: false, font: "Arial" as const, fontSize: 24, color: "#FFFFFF", outline: 2, position: "bottom" as const };
export default function TranslationRenderSettings({ options, caps, onChange }: { options: StudioOptions; caps?: Capabilities; onChange: (value: Partial<StudioOptions>) => void }) {
  const mix = { ...defaultMix, ...options.mix }; const subtitles = { ...defaultSubtitles, ...options.subtitles };
  const updateMix = (value: Partial<typeof mix>) => onChange({ mix: { ...mix, ...value } });
  const updateSubtitles = (value: Partial<NonNullable<StudioOptions["subtitles"]>>) => onChange({ subtitles: { ...subtitles, ...value } });
  return <>
    <details className="ts-consent"><summary>Ljudmixer</summary><p className="ts-muted">Inställningarna används vid export av nya jobb. Förhandsgranska exporten före nedladdning.</p>
      <label>Översatt röst · {mix.speechGainDb} dB<input type="range" min="-18" max="12" step="1" disabled={options.mode === "subtitles"} value={mix.speechGainDb} onChange={(e) => updateMix({ speechGainDb: Number(e.target.value) })} /></label>
      {options.mode === "voiceover" && <label>Originalröst · {mix.originalGainDb} dB<input type="range" min="-60" max="0" step="1" value={mix.originalGainDb} onChange={(e) => updateMix({ originalGainDb: Number(e.target.value) })} /></label>}
      {options.preserveBackground && <label>Separerad bakgrund · {mix.backgroundGainDb} dB<input type="range" min="-36" max="12" step="1" value={mix.backgroundGainDb} onChange={(e) => updateMix({ backgroundGainDb: Number(e.target.value) })} /></label>}
      <label>Fade in (s)<input type="number" min="0" max="5" step="0.1" value={mix.fadeInSeconds} onChange={(e) => updateMix({ fadeInSeconds: Number(e.target.value) })} /></label>
      <label>Fade out (s)<input type="number" min="0" max="5" step="0.1" value={mix.fadeOutSeconds} onChange={(e) => updateMix({ fadeOutSeconds: Number(e.target.value) })} /></label>
      <label className="ts-check"><input type="checkbox" checked={mix.normalize} onChange={(e) => updateMix({ normalize: e.target.checked })} /><span>Normalisera ljudstyrkan och begränsa toppar</span></label>
      {mix.normalize && <label>Ljudstyrkemål · {mix.loudnessLufs} LUFS<input type="range" min="-24" max="-12" value={mix.loudnessLufs} onChange={(e) => updateMix({ loudnessLufs: Number(e.target.value) })} /></label>}
    </details>
    <details className="ts-consent"><summary>Undertexter & videorendering</summary>
      <label className="ts-check"><input type="checkbox" checked={subtitles.bilingual} onChange={(e) => updateSubtitles({ bilingual: e.target.checked })} /><span>Tvåspråkigt · källa och översättning</span></label>
      <label className="ts-check"><input type="checkbox" checked={subtitles.speakerLabels} onChange={(e) => updateSubtitles({ speakerLabels: e.target.checked })} /><span>Visa talar-ID i texten</span></label>
      <label className="ts-check"><input type="checkbox" disabled={!caps?.captionBurnIn} checked={subtitles.burnIn} onChange={(e) => updateSubtitles({ burnIn: e.target.checked })} /><span>Skapa separat MP4 med inbränd text<small>Gäller videofiler. Grundversion och SRT/VTT behålls.</small></span></label>
      {subtitles.burnIn && <><label>Typsnitt<select value={subtitles.font} onChange={(e) => updateSubtitles({ font: e.target.value as NonNullable<StudioOptions["subtitles"]>["font"] })}>{["Arial", "Tahoma", "Noto Sans", "DejaVu Sans"].map((font) => <option key={font}>{font}</option>)}</select></label><label>Textstorlek<input type="number" min="12" max="48" value={subtitles.fontSize} onChange={(e) => updateSubtitles({ fontSize: Number(e.target.value) })} /></label><label>Textfärg<input type="color" value={subtitles.color} onChange={(e) => updateSubtitles({ color: e.target.value })} /></label><label>Kontur<input type="number" min="0" max="4" step="0.5" value={subtitles.outline} onChange={(e) => updateSubtitles({ outline: Number(e.target.value) })} /></label><label>Placering<select value={subtitles.position} onChange={(e) => updateSubtitles({ position: e.target.value as "top" | "bottom" })}><option value="bottom">Nederkant</option><option value="top">Överkant</option></select></label><p className="ts-muted">Texten renderas med säkerhetsmarginal. Arabisk text använder Tahoma på Windows när det finns installerat, eftersom vissa Arial-ligaturer renderas fel av den här FFmpeg-versionen. Faktiskt typsnitt registreras i JSON-exporten. Kontrollera den färdiga videon.</p></>}
    </details>
  </>;
}
