# Inventering före implementation, 2026-10-15

Repositoryt var rent. Next.js 16.4 App Router, React 19.3, TypeScript och Tailwind används lokalt. API-rutter i Node sköter musiksökning, licenskontroll, nedladdning och konvertering. `ffmpeg-static` finns redan; `FFMPEG_PATH` kan ersätta binären. Konverteraren använder argumentlistor utan shell, begränsade uppladdningar och temporära filer. Inspelningar sparas i IndexedDB. Ingen databas, AI-leverantör eller AI-nyckel är konfigurerad av projektet.

`public/studio` är en fristående lokal prototyp med ljudredigering, noter, MIDI/MusicXML och manuella undertexter. Dess AI-panel är inte ansluten. `sites/` är ett separat Vite/Cloudflare-byggmål med FFmpeg WASM; en Worker kan inte köra native FFmpeg eller lokala Pythonmodeller. Musik, CD-konvertering, inspelning, licensregler och notprototypen ska bevaras.

## Vald utbyggnad

- `/translation`: egen responsiv klient, separat från befintliga editorer.
- `/api/translation`: strömmad uppladdning, jobbkontroll, status, resultat med Range och liveutdata via NDJSON.
- `src/lib/translation`: validering, persistenta atomiska jobb, providergränssnitt, mediemotor och pipeline.
- `npm run studio:worker`: separat Node-process, en aktiv bearbetning, beständiga kontrollpunkter, paus/återuppta/avbryt. Webserverns livscykel styr inte jobben.
- OpenAI-adapter för Whisper, kontextuell textöversättning och TTS. Separat valbar lokal Python-gateway för faster-whisper, Ollama, Piper och pyannote/Demucs när installerade.
- Lokala jobb sparas i `.translation-data`, ignoreras av Git, med ålders- och utrymmesgränser. Detta är en lokal enanvändarserver; publik drift kräver autentisering och ägarskap per jobb.

Native studion ingår i Next.js-versionen. Sites-versionen får information om att AI-studion kräver lokalservern, utan att skicka filer till en saknad backend.
