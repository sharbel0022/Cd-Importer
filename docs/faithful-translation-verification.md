# Faithful Translation och förhandsvisning – 2026-10-15

Den här rapporten ersätter tidigare beskrivningar av automatisk ASR-grammatikrättning och timingförkortning. Studion kör riktiga lokala modeller, FFmpeg och en separat worker. Ingen Sites-version har publicerats med anspråk på fungerande AI-dubbning.

## Beteende

- **Faithful Translation** är standard. **Natural Translation** ändrar formuleringar utan att ändra innehåll. Talarens felaktiga fakta, namn, antal, negationer, meningsbärande tempus, motsägelser och självrättelser ska bevaras.
- ASR använder akustisk avkodning, språkidentifiering, VAD och ordtider. Automatisk arabisk ordinalrättning är borttagen. Inga LLM-ord eller bildbaserade fotbollstermer förs in i transkriptet. En misstänkt kardinal/ordinalform markeras för lyssning och skrivs aldrig om automatiskt.
- Möjlig kodväxling markeras utifrån arabiska/latinsk skrift; namn och låneord gör signalen osäker. Decoderpoäng är inga kalibrerade sannolikheter för korrekt innehåll. Repetitionsloopar, osäkra ord och orimliga ordtider går till granskning.
- Rå ASR, redigerad källa och tidsatt ändringshistorik sparas separat. Osäkra källsegment kan spelas, rättas och godkännas individuellt. Tillförlitliga segment bearbetas medan övriga väntar. Komplett export kräver att alla osäkra källsegment är granskade.
- Ändrad källa ogiltigförklarar dess översättningar och tal. Ändrad måltext ogiltigförklarar ljudet. Tidigare kompletta exporter spärras omedelbart; gamla versionslänkar returnerar HTTP 409. Valda segment kan regenereras medan övrigt tal återanvänds.
- Ingen text skrivs om för att passa tiden. Tillgängliga pauser används först och tempot hålls inom 0,85–1,20×. Faktiskt sampleöverskridande ger granskning, aldrig avklippning.
- Slutspelaren använder exakt den exporterade MP3/MP4-filen. Nedladdningar ligger efter spelaren. WAV, MP3, M4A och MP4 kontrolleras för storlek, ljudström, längd, avkodning och hörbart ljud. Originalet behålls byte för byte; jämförelsespelaren får en separat kompatibel kopia när det behövs. MP4 använder H.264/yuv420p och AAC.

## Automatiserade kontroller

Slutloggar finns i ignorerade `test-results/faithful-{lint,typecheck,tests,python,build,ui}.log`.

- 330 JavaScript/TypeScript-tester och 23 Python-tester.
- Lint, separat typecheck och produktionsbygge.
- 25 kontroller i Chromium-flödet: Faithful/Natural, US/UK, röstval, riktig uppladdning, worker-status, segmentgranskning, råtext/historik, individuell regenerering, samma MP3-bytes i förhandsvisning/nedladdning, spärrad gammal version, synkron växling, Live, undertexter utan TTS och mobilbredder. AI-svaren är uttryckliga testfixturer i detta browserflöde; server, worker, FFmpeg och mediefiler är riktiga.
- MKV med FFV1-video testas: den uppladdade filen är oförändrad och jämförelsekopian innehåller H.264/AAC med korrekt MIME och Range-stöd.
- Åtta separata kontroller mot den installerade TranslateGemma-modellen, fyra i varje läge: Barcelona vinner **fem**, en person har **tre ben**, en framtida **negation**, och uttrycklig självrättning **”tre, nej, jag menar fyra”**. Alla passerade. Den första självrättningsfixturen var tvetydig på arabiska (kunde betyda ”tre, inte fyra”); den ersattes med uttrycklig självrättning. Båda resultaten behålls i testloggarna.

Kör dessa verkliga textprober igen med `npm.cmd run test:translation:fidelity`. De mäter textmodellen, inte uttal eller ASR.

## Verkliga mänskliga inspelningar

Källorna är lokalt sparade Google FLEURS-inspelningar. Publicerad referenstext och attribution ligger i `local-ai/fixtures/*.provenance.json`. Alla anrop använde installerade lokala modeller: faster-whisper large-v3 / CPU int8; TranslateGemma 12B för engelska, Gemma 3 12B för svenska; Piper-röster. Inga mockade AI-svar användes i dessa körningar.

| Källa → mål | Resultat | Referenskontroller | Diagnostisk TTS-ASR WER |
| --- | --- | --- | --- |
| Svenska → engelska, 10,86 s | WAV, MP3, M4A | 34/34 | 0 % |
| Engelska → svenska, 6,54 s | WAV, MP3, M4A | 19/19 | 13,3 % |
| Arabiska → engelska, 8,16 s, MP4 med mänskligt ljud | MP4, WAV, MP3, M4A | 39/39 **efter uttrycklig källrättning** | 4,8 % |

Verifierade filer och fullständiga rapporter:

- `test-results/local-translation-en-2026-10-15T14-11-19-118Z/en-export.{wav,mp3,m4a}`.
- `test-results/local-translation-sv-2026-10-15T14-20-29-850Z/sv-export.{wav,mp3,m4a}`.
- `test-results/local-translation-en-2026-10-15T14-31-16-444Z/en-export.{mp4,wav,mp3,m4a}`.

Den arabiska MP4-filen har en syntetisk färgbild och **mänskligt inspelat FLEURS-ljud**. Chromium verifierade verklig uppspelning, 640×360, 8,16 s och inga sidfel. Detta är ett medieflödestest, ingen läppsynkmätning.

Slutlig browserkontroll på produktionsbygget finns i `test-results/final-faithful-browser/report.json`: tre verkliga talfiler (engelsk MP3, svensk MP3 och engelsk MP4) spelades upp med sökning/volym och Range. Varje faktiskt browsernedladdad fil jämfördes byte för byte med spelarens URL. Originaljämförelsen behöll tidspositionen. WhatsApp-segmentet stoppade vid sin gräns och kunde spelas igen; 14 källsegment väntade fortfarande och ingen komplett dubbning var tillgänglig.

Den första arabiska körningen underkändes: ASR gav `عشر` där den publicerade referensen har `عاشر`. Den nya kvalitetskontrollen flaggade samma verkliga ljud utan att ändra ordet. Benchmarkens källa rättades därefter uttryckligen via redigerings- och godkännande-API:t mot dess publicerade transkript, inklusive den feligenkända böjningen. Råtext och historik finns kvar. `test-results/faithful-reference-corrections.json` och `faithful-arabic-asr.json` dokumenterar detta. Det är **ingen obevakad ASR-framgång** och inget tillstånd att faktakorrigera andra talare.

Engelska→svenska-testet avslöjade även `miles`→`mil`, vilket ändrar enheten. En källa/mål-kontroll och instruktion bevarar nu `engelska mil`; testets för breda enhetsregex skärptes. Diagnostisk ASR hör fortfarande `mil bort` som `milbord` i det svenska TTS-ljudet. Återtranskribering är ett hjälpmedel och inget ofelbart facit; WER-gränsen är ingen garanti för naturlighet eller korrekt uttal. Ingen generell accent-, dialekt-, MOS- eller läppsynkvalitet påstås.

## WhatsApp: verklig granskning återstår

Jobb `2356e578-9bb3-4438-a33c-b42791e2ea44`, 49,67 s. Originalet finns kvar i den tidigare jobbmappen och en hashverifierad kopia ligger i `test-results/faithful-jobs/<id>/original.mp4`. Privat media, råtranskript och modellvikter ingår inte i Git.

Medium och large-v3 jämfördes separat, utan textprompt eller språkledtråd. Rårapporter finns i `test-results/asr-comparison-20261015T140447Z/report.json`. Den sparade primära akustiska transkriptionen behölls; modellavvikelser fördes in som granskningsorsaker och alternativa råtexter, aldrig ersättningsord. Hjälpskriptet verifierar att jämförelsen gäller jobbets exakta normaliserade ljudfil:

```powershell
$env:STUDIO_DATA_DIR = "test-results/faithful-jobs"
node --import tsx scripts/review-asr-comparison.ts 2356e578-9bb3-4438-a33c-b42791e2ea44 test-results/asr-comparison-20261015T140447Z/report.json
```

14 av 15 segment kräver manuell lyssning:

| Segment | Sekunder |
| --- | --- |
| s1 | 0,00–2,18 |
| s2 | 2,94–5,28 |
| s3 | 6,00–8,30 |
| s4 | 8,90–13,46 |
| s5 | 13,46–16,04 |
| s6 | 16,04–18,60 |
| s8 | 22,22–25,51 |
| s9 | 25,51–29,67 |
| s10 | 29,67–32,47 |
| s11 | 32,47–36,67 |
| s12 | 36,67–40,33 |
| s13 | 40,33–45,63 |
| s14 | 45,63–47,49 |
| s15 | 48,35–49,63 |

Endast s7 hade tillräckligt samstämmig ASR för att gå vidare. Jobbet har status **review**, och ingen komplett WhatsApp-MP4/MP3 är godkänd. Använd segmentspelarna och modellalternativen för att rätta/godkänna källan. Den här rapporten väljer inte gissade namn, fotbollsuttryck eller antal åt användaren.

## Lokal start och publik drift

Starta om äldre server-, gateway- och workerprocesser efter kodändringar. I tre PowerShell-terminaler i projektmappen:

```powershell
npm.cmd run studio:gateway
```

```powershell
npm.cmd run studio:worker
```

```powershell
npm.cmd run build
npm.cmd start
```

Öppna `http://127.0.0.1:3000/translation`. Behåll den befintliga privata `.env.local`; vid ny installation behövs modeller/röster enligt [lokal installation](local-ai-setup.md). Webbserver och worker måste ha samma `STUDIO_DATA_DIR` och providerkonfiguration. Alla tre processerna måste nå samma gateway.

Den här verifieringen använder separat datamapp `test-results/faithful-jobs`, ny gatewayport **8876** (`STUDIO_GATEWAY_PORT=8876`) och webbport **3014**, så tidigare lokala processer inte behöver avbrytas. För att öppna dessa granskningsjobb vid omstart: ange `STUDIO_DATA_DIR=test-results/faithful-jobs` och `STUDIO_LOCAL_URL=http://127.0.0.1:8876` för webbserver/worker samt `STUDIO_GATEWAY_PORT=8876` för gatewayen. Hämta filer som ska behållas; vanlig retention är 24 timmar.

Publik drift kräver en tillgänglig backend med FFmpeg, AI-modeller/providers, separat worker/kö, beständig medielagring, HTTPS, autentisering, jobbägarskap/åtkomstkontroll, användarkvoter, anropsgränser och skyddade hemligheter. Lokal loopback kan inte nås från en publik Sites-sida. Ingen sådan produktionsbackend har satts upp eller publicerats här.

Implementationskontrakt: [faster-whispers primära kod för språkdetektion och ordtider](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py), [TranslateGemma i Ollama](https://ollama.com/library/translategemma). Rapportens språkresultat gäller de ovan redovisade filerna och ersätter inte granskning av nytt material.
