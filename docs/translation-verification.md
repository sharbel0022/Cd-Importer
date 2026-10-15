# Slutrapport – AI Translation Studio, 2026-10-15

**Uppdatering efter lokal installation:** Whisper large-v3, Qwen 3.5 9B och svensk Piper NST är nu installerade och testade. Ett mänskligt arabiskt prov gav korrekt verifierad svensk röst efter en dokumenterad timingkorrigering. Detaljer, faktiska mätvärden och upptäckta innehållsfel finns i [local-ai-verification.md](local-ai-verification.md). Avsnitten nedan beskriver den ursprungliga implementationens verifiering före modellinstallationen.

## Utgångsläge

Next.js/React-appen hade verklig musiksökning och licenskontroll, FFmpeg-konvertering, mikrofon-/datorinspelning och IndexedDB. Den separata studioprototypen hade lokal ljud- och notredigering men ingen AI-backend. Ingen API-nyckel, lokal AI-gateway eller modell var konfigurerad. Se [inventeringen](translation-architecture.md).

## Implementerat

Egen `/translation`-sektion med uppladdning och mikrofon, språk/stil/röst/ljudläge, diskbaserade jobb, separat worker, paus/återuppta/avbryt, kontrollpunkter, begränsade retries och retention. Riktiga provideradaptrar för ASR, översättning och TTS; valbar helfilsdiarization, XTTS och Demucs. Absolut segmentplacering med begränsad pitchbevarande tidssträckning, manuell granskning vid för långa segment, RMS-/längdkontroll och limiter. Redigerbara original/översättningar/talare/tider, jämförelse på samma position, Range-uppspelning och exporter. Ingen produktionskod använder testgatewayen eller fixtursvar.

## Modeller och språk

Standardmoln: `whisper-1`, `gpt-4.1-mini`, `gpt-4o-mini-tts`; valbar `gpt-4o-transcribe-diarize`. Text- och TTS-modeller kan konfigureras. Lokal gateway: faster-whisper, Ollama, installerade Piper-röster och valbara pyannote/Demucs/XTTS. Språklistan inkluderar svenska, engelska och arabiska samt ytterligare dokumenterade TTS-språk. Lokala röster och kloning begränsas av gatewayens verkliga manifest. Ingen likvärdig kvalitet eller dialekttäckning garanteras.

## Kloning och Live

Kloningsadaptern finns för valbar lokal XTTS med samtycke och rena röstprov; den har **inte runtimeverifierats med installerade vikter**. Svenska stöds inte av XTTS-adaptern. Molnadaptern använder standardröster.

Live-flödet har verifierats tekniskt från simulerad mikrofon via AudioWorklet och riktiga API-rutter till NDJSON-text och uppspelning. Det använder fyrasekundersblock, inte tokenströmmande ASR. Testgatewayen gav cirka **6,0–6,5 sekunder** från blockets början till uppspelningsstart. Detta är testvärden med artificiella svar, ingen modellbenchmark.

## Körda kontroller

| Kontroll | Resultat |
| --- | --- |
| `npm.cmd test` | **234 tester, 13 filer, godkända**; cirka 29 s i slutkörningen |
| `npm.cmd run lint` | Godkänt för studions TS/TSX, API, bibliotek och workerskript |
| `npm.cmd run typecheck` | Godkänt |
| `npm.cmd run build` | Godkänt med Next.js Webpack; Turbopack gav ett reproducerbart processfel på denna Windows-installation |
| `npm.cmd run build:sites` | Godkänt; befintlig Site återanvänder fortsatt musikappen |
| `node scripts/studio-check.cjs` | Godkänt: ljudredigering, original, undo/redo, WAV, MIDI, MusicXML och SRT |
| Befintligt `test:recording`, lokal produktionsserver | Godkänt på 1440/390 px: mikrofonfixtur, riktig MP3, lagring, nedladdning, nekad/sen behörighet och städning |
| `test:translation:ui` | Godkänt på 1440/768/390/360 px: riktig uppladdning, worker, paus/återuppta, FFmpeg, hämtning, jämförelseposition, redigering, Live och mikrofonfixtur |
| Python `py_compile local-ai/server.py` | Godkänd syntax; valbara AI-bibliotek är inte installerade/runtimeverifierade |
| `test:translation:live` | **SKIP**, ingen verklig talfixtur eller providerkonfiguration; inga AI-anrop gjordes |

Automatiserade AI-svar är mockade i testerna; mediebearbetningen är riktig. WAV- och MP4-tester avkodar exporten och kontrollerar att den nya ljudfixturen finns där, med en annan frekvens än originalet. Ett test placerar tal exakt vid 3 599 sekunder i ett timslångt diskspår och kontrollerar sampleposition och tystnaden före placeringen. Fullständig timslång AI-bearbetning har inte körts. Test med för lång översättning blockerar ljudexport och verifierar rättning/omgenerering. Bakgrundstestet kontrollerar faktisk stereomix och varning om separeringsartefakter.

Transkriptions-WER, semantisk översättningskvalitet och perceptuell ljudkvalitet har **inte mätts med verkliga modeller**. Testverktyg finns för referens-WER, ASR-rundtur av exporterad röst, bearbetningstider och synkronisering. Ingen MOS eller kvalitetsprocent har hittats på.

## Start och kostnader

Konfigurera `.env.local` med egna credentials eller lokala providers. Kör `npm.cmd run dev` samt `npm.cmd run studio:worker` i varsin terminal. Öppna `/translation`. Detaljer, språklista, GPU/CPU, lokala modellkrav och testkommandon finns i [installations- och användarguiden](translation-studio.md).

OpenAI-anrop har användningsbaserad API-kostnad, separat från att denna kod finns i repositoryt. Flera mål, diarization, retries och omgenerering ökar användningen. Exakta belopp lämnas till aktuella modellpriser. Lokala modeller kräver disk, RAM/VRAM och eventuella modelllicenser. Inga betalda tjänster har aktiverats här.

## Kvar att verifiera eller bygga

- Installera/konfigurera verkliga providers och kvalitetsgranska arabiska dialekter→svenska/engelska med rättighetsklarerade talfiler.
- Verifiera valbar Python-diarization, Demucs och XTTS med faktiska modeller och aktuell hårdvara.
- Bedöma naturlighet, känsloöverföring, röstlikhet och bakgrundsartefakter genom lyssning.
- Live är blockbaserad och kan dela ord vid blockgränser. Ett äkta ASR-streamingprotokoll ingår inte.
- Läppsynk, inbrända undertexter, publik fleranvändardrift och drift av native AI-worker på Sites ingår inte.

Den levererade koden är en tekniskt verifierad översättningspipeline med fungerande integrationer att konfigurera. Den ska inte beskrivas som ett redan kvalitetsvaliderat professionellt dubbningssystem utan dessa verkliga modelltester.
