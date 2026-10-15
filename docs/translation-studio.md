# AI Translation Studio

The 2026-10-15 extension is documented in [Ultimate Studio progress](ultimate-studio-progress.md), with the [baseline gap analysis](ultimate-studio-gap-analysis.md), [model evaluation](ultimate-studio-model-evaluation.md) and [hosted deployment boundary](ultimate-studio-hosted-architecture.md). Translation now offers Faithful, Natural, Professional and Literal modes, reusable browser glossaries, installed-model segment ASR comparisons, recoverable editor drafts and project copies. Optional mixer settings and bilingual/styled burned captions produce real exports; each new artifact has a revision/SHA256 manifest. This remains a local single-user edition; lip sync, verified voice cloning and hosted multi-user operation are not completed.

## Status och verifiering

Engelska (US) är nu standard. Aktuell implementation och verkliga testresultat finns i [Faithful translation verification](faithful-translation-verification.md). Äldre resultat finns i [English-priority verification](english-translation-verification.md). Tidigare svenska prov nedan är historiska; de är inget godkännande av nya modeller eller WhatsApp-videon.

Studion är en riktig implementation av ingestion, provideranrop, tidsatta segment, talgenerering, synkronisering och export. Den körs i **lokala Next.js-versionen**, på `/translation`. Befintlig musikhantering, CD-konvertering, inspelning och notredigering finns kvar. Inventeringen före kodändring finns i [translation-architecture.md](translation-architecture.md).

**Lokala basmodeller har nu installerats och testats med verkliga anrop.** Ett mänskligt arabiskt talprov gav verifierad svensk WAV/MP3/M4A efter en dokumenterad timingkorrigering. Se [resultat och begränsningar](local-ai-verification.md) samt [den lokala installationen](local-ai-setup.md). Detta är en kontroll av korta prov, inte en generell kvalitetsgaranti. Deterministiska AI-fixturer används fortfarande enbart i enhets-/UI-tester; produktionsappen har ingen sådan fallback.

## Starta på Windows

Använd Node.js 22.16 eller senare enligt projektets grundkrav. FFmpeg installeras redan via `ffmpeg-static`.

```powershell
npm.cmd ci
Copy-Item .env.example .env.local # endast om filen inte redan finns
# Redigera .env.local och ange OPENAI_API_KEY eller lokala providers.
npm.cmd run dev
```

I en andra terminal, i samma projektmapp:

```powershell
npm.cmd run studio:worker
```

Öppna `http://127.0.0.1:3000/translation`, eller välj **AI Translation Studio** i appens meny. Båda processerna måste startas om efter ändrad konfiguration. För produktion: `npm.cmd run build`, därefter `npm.cmd start`, plus workern i en separat terminal. Projektet använder Next.js dokumenterade `--webpack` för att undvika ett reproducerbart Turbopack-underprocessfel på denna Windows-installation.

1. Välj automatisk detektion eller källspråk samt ett till tre målspråk.
2. Välj Faithful Translation (standard) eller Natural Translation, AI-röst, ljudläge och eventuell talaridentifiering. Inget läge får rätta talarens fakta.
3. Bekräfta dina rättigheter och, i molnläge, att ljud/text skickas till OpenAI.
4. Dra in en fil, välj fil eller spela in mikrofonen. Starta översättningen.
5. Följ statusen. Jobbet fortsätter när webbläsaren stängs, så länge workern körs.
6. Granska och godkänn osäkra källsegment separat. Tillförlitliga segment bearbetas under tiden; komplett dubbning kräver att alla källsegment är granskade. Lyssna på originalsegment, osäkra ord och genererade segment. Rå ASR och ändringshistorik visas separat. Pausa innan redigering. Ändra originaltext, översättning, start/sluttid, talar-ID och röstmappning. **Spara**, sedan **Återuppta**, genererar uppdaterade exporter.
7. Växla original/AI-tal vid samma tidsposition. Granska särskilt osäkra segment. Hämta exporter du vill behålla.

## Providers och faktiska språkgränser

| Steg | Molnprovider | Lokal provider |
| --- | --- | --- |
| ASR | OpenAI `whisper-1`, ord- och segmenttider, automatisk språkdetektion | faster-whisper, VAD, ordtider, CPU int8 eller CUDA |
| Kontextöversättning | OpenAI Chat Completions, `STUDIO_TRANSLATION_MODEL`, standard `gpt-4.1-mini` | Ollama, standard `qwen2.5:7b`, JSON-output |
| TTS | OpenAI `gpt-4o-mini-tts`, ändringsbar med `STUDIO_TTS_MODEL` | Installerade Piper-röster; valbar XTTS med röstprov |
| Talare | Separat helfilsanrop till `gpt-4o-transcribe-diarize` | Valbar pyannote-modell |
| Bakgrund | Ingen molnseparering implementerad | Valbar Demucs `htdemucs` |

Modellalias kan ändras eller avvecklas och kontot måste ha modellåtkomst. Konfigurationsstatus är ingen garanti för åtkomst eller nedladdade modellvikter; detta verifieras av riktiga anrop. Felaktig nyckel, saknad modell och nätverksfel visas som fel. Ingen modellnyckel ligger i klienten.

Gränssnittets explicita TTS-lista följer OpenAI:s dokumenterade språklista: svenska, engelska, arabiska, tyska, franska, spanska, italienska, portugisiska, nederländska, danska, norska, finska, polska, ukrainska, ryska, turkiska, persiska, hebreiska, hindi, urdu, kinesiska, japanska, koreanska, grekiska, tjeckiska, rumänska, ungerska, indonesiska, vietnamesiska, thailändska, swahili, afrikaans, armeniska, azerbajdzjanska, belarusiska, bosniska, bulgariska, katalanska, kroatiska, estniska, galiciska, isländska, kannada, kazakiska, lettiska, litauiska, makedonska, malajiska, marathi, maori, nepalesiska, serbiska, slovakiska, slovenska, tagalog, tamil och walesiska. Språkstöd betyder inte likvärdig kvalitet. Rösterna är främst optimerade för engelska. Arabiska dialekter saknar separata garanterade kvalitetsnivåer.

Piper begränsas till språk och röster som operatören verkligen installerat. Lokal automatisk röstmappning väljer en installerad röst för respektive målspråk. Översättningsmodellens kvalitet för alla dessa språk måste bedömas separat; studion hävdar inte att en lokal textmodell är bra på varje språk.

Officiella kontrakt: [OpenAI ASR](https://developers.openai.com/api/docs/guides/speech-to-text), [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [Piper](https://github.com/OHF-Voice/piper1-gpl). Modeller, röstfiler och respektive bibliotek har egna licensvillkor.

## Lokal AI utan molnanrop

Den valbara FastAPI-gatewayen finns i `local-ai/server.py`. Python 3.11/3.12 rekommenderas för kompatibilitet med valbara torch-moduler. Den körs enbart på loopback som standard. Blandade providers är möjliga, exempelvis lokal ASR och molnöversättning/TTS. Molnsamtycke krävs om någon vald provider använder molnet.

```powershell
python -m venv local-ai/.venv
local-ai/.venv/Scripts/python.exe -m pip install -r local-ai/requirements.txt
```

Installera en Ollama-modell och Piper-röstfiler separat. Ange exakta modell- och röstsökvägar; `.onnx` och dess `.onnx.json` måste båda finnas. Gatewayen läser processens miljövariabler, **inte** Next.js `.env.local` automatiskt:

```powershell
$env:WHISPER_MODEL = "small"
$env:WHISPER_DEVICE = "cpu"
$env:WHISPER_COMPUTE_TYPE = "int8"
$env:OLLAMA_URL = "http://127.0.0.1:11434"
$env:OLLAMA_MODEL = "qwen2.5:7b"
$env:STUDIO_PIPER_VOICES_JSON = '[{"id":"sv-lisa","language":"sv","model":"C:/models/sv_SE-lisa-medium.onnx"},{"id":"en-lessac","language":"en","model":"C:/models/en_US-lessac-medium.onnx"}]'
# Valfritt: samma STUDIO_LOCAL_TOKEN i gateway, webbserver och worker.
local-ai/.venv/Scripts/python.exe -m uvicorn server:app --app-dir local-ai --host 127.0.0.1 --port 8765
```

I `.env.local`: sätt `STUDIO_ASR_PROVIDER=local`, `STUDIO_TRANSLATION_PROVIDER=local`, `STUDIO_TTS_PROVIDER=local` och `STUDIO_LOCAL_URL=http://127.0.0.1:8765`. Starta även Ollama. Modellhämtningar kan använda nätet första gången. För full offlinekörning måste alla vikter och röster redan finnas lokalt.

CPU fungerar, men stora modeller kan vara för långsamma för Live Translate. GPU är valfritt: faster-whisper använder CTranslate2 och behöver dess kompatibla CUDA/cuDNN-versioner. Sätt `WHISPER_DEVICE=cuda` eller `auto` och lämplig `WHISPER_COMPUTE_TYPE`. Om CUDA-initieringen misslyckas försöker ASR-adaptern CPU int8 och skriver en tydlig rad i gatewayens logg. Ingen generell VRAM-garanti ges; modellstorlek och valbara separation/diarization/XTTS-modeller avgör behovet. GPU-fel senare under inferens visas som modellfel och kan kräva omstart med CPU.

## Röstkloning och talare

Molnadaptern använder standardröster och klonar inte röster. Valbar lokal XTTS-v2 använder ett rent originalprov på 3–12 sekunder per talar-ID. Installera kompatibel `coqui-tts`/PyTorch separat och granska modellens licens innan du sätter `STUDIO_XTTS_ENABLED=true` i gatewayens miljö. Inställningen kräver uttryckligt samtycke för samtliga personer. Röstproven lagras med jobbets övriga filer och omfattas av rensningen.

XTTS-v2:s lista i adaptern är engelska, spanska, franska, tyska, italienska, portugisiska, polska, turkiska, ryska, nederländska, tjeckiska, arabiska, kinesiska, japanska, ungerska, koreanska och hindi. **Svenska stöds inte för kloning.** Gatewayen och servern avvisar kombinationer som inte stöds. Likhet, känslor och identiska pauser kan inte garanteras. Den valbara XTTS-installationen har inte körts här.

Valbar pyannote kräver installerat `pyannote.audio`, `PYANNOTE_MODEL` och eventuell Hugging Face-behörighet/token. Talarturer tas över hela inspelningen, inte genom att jämställa oberoende chunk-ID:n. Ord delas vid talarbyten när ordtider finns. Överlapp och osäkerhet markeras. Utan diarization visas `unknown`; appen hittar inte på olika personer.

## Synkronisering, mixning och export

Långa källor transkriberas i diskbaserade block, normalt omkring 60 sekunder (konfigurerbart 10–120 sekunder). Workern söker en närliggande tyst gräns; en ofrånkomlig gräns i tal markeras för granskning. Orimliga mellanrum i ordtider markeras även när ordsannolikheterna är höga. Whisper skapar segment och ordtider; dessa är modellskattningar och måste granskas när de flaggas. En översättning per ID valideras. Talare och tidsfönster kommer från serverns sparade segment.

TTS-ljudet avkodas och mäts. Tyst eller ogiltigt WAV-ljud avvisas. Ingen automatisk textförkortning körs. Tillgängliga pauser används fram till nästa segments start eller filens slut, med FFmpeg `atempo` inom **0,85–1,20×**. Den verkliga samplelängden kontrolleras innan tal skrivs till tidslinjen. Tal som inte ryms utan överlappning eller avklippning ger granskning och saknar godkända slutexporter. Hela texten och genererade segment finns kvar för granskning. Alla färdiga mediefiler kontrolleras för storlek, ljudström, längd, avkodning och hörbart tal. Kompatibel H.264 kopieras; andra videokodekar/pixelformat kodas till H.264 yuv420p med AAC för HTML5-uppspelning.

Godkända segment placeras på absoluta 24 kHz-samplepositioner i ett diskbaserat floatspår. Pauser mellan segment lämnas kvar och fel ackumuleras inte genom concat. Hela mixen mäts före global loudness-normalisering mot −16 LUFS och limitering. Sampleklockan återställs och utdata får exakt originallängd före 48 kHz WAV, MP3 och M4A. Detta är ingen MOS-mätning av naturlighet.

- **Ersätt tal:** det nya talspåret ersätter hela originalljudet om separation inte är vald. Appen säger uttryckligen att musik/effekter då försvinner.
- **Voice-over:** originalljudet spelas på 15 procent under AI-talet.
- **Original + undertexter:** ingen TTS körs; originalljudets innehåll behålls och separata SRT/VTT-filer skapas. MP4 innehåller dessutom ett valbart undertextspår. Läget fungerar när ASR/översättning finns även om TTS saknas.
- **Demucs:** valbart `demucs` måste installeras och `STUDIO_DEMUCS_ENABLED=true` sättas i gatewayen och i `.env.local`. Separation är en uppskattning, med möjliga talrester och artefakter. Ingen kvalitetsgaranti visas. Molnproviders kan kombineras med lokal separering.

Exporter: MP3, WAV, M4A, MP4 för videokällor, SRT, VTT, TXT med original/översättning samt JSON med segment, ord, talare, varningar och mätvärden. MP4 kopierar videobitströmmen och kodar det valda ljudet som AAC. Om videokodeken inte går att lägga i MP4 blir jobbet ett tydligt fel; upplösningen sänks inte som dold fallback. Bildfrekvens och upplösning bevaras vid lyckad stream copy. Ingen läppsynk, videoklippning eller inbränning av undertexter implementeras. MKV/MOV-källor kan fungera i FFmpeg även när webbläsaren inte kan förhandsvisa originalet.

## Live Translate

Live använder AudioWorklet, monofoniskt 16 kHz PCM och självständiga WAV-block på **fyra sekunder**. Varje block skickas till `/api/translation/live`. Servern strömmar transkription, översättning och slutligen TTS-ljud som NDJSON. Tidigare text används som begränsad kontext. Detta är inkrementell blockbearbetning, **inte en tokenströmmande ASR-modell eller exakt simultantolkning**. Ett lokalt API kan ersättas med en äkta streamingadapter senare.

UI mäter tid från blockets början till faktisk uppspelningsstart, inklusive fångst, kö, nät och bearbetning. Kön begränsas; när AI eller uppspelning inte hinner med stoppas Live med förklaring. Tysta eller mycket svaga block under amplitudgränsen skickas inte, vilket även framgår i gränssnittet. Stopp avbryter väntande block/ljud och ett ofärdigt sista inspelningsblock sparas inte. Ändrade inställningar avslutar en aktiv Live-session. Live använder en standardröst och det första målspråket; kloning, separation och diarization hör till filjobben.

Mikrofon kräver localhost eller HTTPS. Mobil/iOS kan begränsa autoplay, minne och bakgrundskörning. Manuella ljudkontroller finns om automatisk uppspelning blockeras. Hörlurar rekommenderas för att undvika rundgång. Tester använder simulerad mikrofon och kommer inte åt fysisk mikrofon.

## Jobb, säkerhet och drift

`.translation-data` är en lokal beständig jobbkatalog utan SQL-databas. JSON sparas atomiskt med korta lås och retry för Windows-fildelning. En separat worker håller ett processlås och bearbetar en fil i taget. Slutförda ASR-block, översättningsbatcher och TTS-filer återanvänds efter paus. Efter worker-krasch markeras aktiva jobb pausade vid omstart; användaren återupptar uttryckligen. API-anrop med tillfälligt nätfel, HTTP 429 eller 5xx får högst två retries. Kostnader kan därför uppstå även för omtagna anrop.

Paus/avbryt kontrolleras var 400 ms och avbryter Node-FFmpeg samt nätanrop. Ett fjärranrop kan redan ha kostat pengar. Pythonmodellens CPU/GPU-arbete kan fortsätta tills det pågående modellsteget lämnar tillbaka kontrollen trots att HTTP-anropet har avbrutits. Ingen resultatfil från ett avbrutet steg publiceras som färdig.

Standardgränser: 500 MB uppladdning (konfigurerbar upp till 1 GB), en timme media (upp till två timmar), tre målspråk, 6 000 segment, åtta väntande/aktiva jobb, 5 GB arbetsyta, 24 timmars retention för inaktiva jobb. Workern rensar ungefär en gång i timmen när den inte bearbetar ett jobb. Övergivna uppladdningar rensas efter en timme. Utrymmet kontrolleras före uppladdning och med en konservativ uppskattning före ny mediebearbetning. Avbrutna/pausade jobb behåller kontrollpunkter tills radering/retention; det behövs för återupptagning. Radering tar också bort original, röstprov och exporter. Arbeta på en disk med tillräcklig ledig plats; appkvoten ersätter inte operativsystemets diskkvot.

Filer strömmas till serverdisk. FFmpeg läser disk, med fast tillåten demuxer, begränsad längd, argumentlista utan shell och förbjuden nätåtkomst. Klienten får aldrig välja serverfilväg eller provider-URL. Jobb-ID är UUID, exporttyper måste finnas i färdigmanifestet, och privat Range-leverans stöds. Samma ursprung krävs för webbläsarmutationer, och anrops-/kögränser gäller. Klientbekräftelser krävs för rättigheter, moln och kloning. Lokal gateway har valbar Bearer-token och ingen browser-CORS.

**Det finns ingen användarinloggning eller jobbägarskap.** Bind webbserver/gateway till loopback. Före publik drift behövs autentisering, ägarskap, distribuerad kö/kvot och separat medielagring. Sites/Cloudflare Worker-bygget kan inte köra denna native worker; dess meny visar lokalserverkravet. Ingen AI-tjänst har publicerats till den befintliga Siten.

## Tester och kvalitetsmätning

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
node scripts/studio-check.cjs
npm.cmd run test:translation:ui # startar egen isolerad produktionsserver/worker
```

Enhets- och integrationstester täcker arabiska→svenska, arabisk video→engelskt MP4, svenskt mikrofonblock→engelskt tal, talare/röstmappning, separerad bakgrund, absoluta samplepositioner efter en timme, för lång översättning och manuell korrigering, ogiltiga filer, saknade credentials, felaktig API-nyckel, tyst TTS, paus/avbryt, providerkontrakt och retry. **AI-svaren är explicit mockade i dessa tester; FFmpeg, diskjobb, faktisk ljudkodning och exportkontroller är riktiga.** Webbläsartestet använder en isolerad testgateway, riktig server/worker och simulerad mikrofon. Det kontrollerar filhämtning, redigering, växling på samma tidsposition, Live-utdata och 1440/768/390/360-bredder.

För test med verkliga modeller, egna rättighetsklarerade talfiler och konfigurerade credentials:

```powershell
$env:STUDIO_TEST_MEDIA = "C:/samples/arabic.wav"
$env:STUDIO_TEST_TARGET = "sv"
# Valfritt: exakt referenstranskript för ASR-WER.
$env:STUDIO_TEST_REFERENCE_TXT = "C:/samples/arabic-reference.txt"
npm.cmd run test:translation:live
```

Upprepa med arabiskt videomaterial och mål `en`, samt svensk inspelning och mål `en`. Sätt `STUDIO_TEST_DIARIZE=true` för två talare. Rapport och exporter sparas isolerat under `test-results/translation-real-*`, aldrig över befintliga jobb. Testet gör även ASR på exporterad AI-röst och kontrollerar ordöverensstämmelse med översättningstexten. Det är en teknisk rundturkontroll, inte ett bevis på semantisk översättningskvalitet.

| Mått | Implementation | Vad som inte kan påstås utan riktiga talfixturer |
| --- | --- | --- |
| ASR-kvalitet | WER mot valfritt manuellt referenstranskript | Provresultat finns i den lokala verifieringsrapporten; whitespace-WER lämpar sig inte lika väl för alla språk |
| Översättningskvalitet | Redigerbar text och extern mänsklig referensgranskning | Inget uppfunnet semantiskt kvalitetstal |
| Ljudkvalitet | Avkodning, hörbar RMS, limiter, ASR-rundtur i verkligt test | Ingen MOS/naturlighetsmätning utan lyssningspanel |
| Synkronisering | Genererad längd, originalfönster, tempo och överskridande per segment; total exportlängd valideras inom 80 ms | Ingen garanti om perfekt läppsynk |
| Bearbetningstid | Totalt och per steg i jobbets JSON | CPU/GPU-/språkspecifika tider måste mätas lokalt |
| Streaming latency | Faktisk fångststart→uppspelningsstart i webbläsaren | Testgatewayens tid säger inget om modellernas verkliga hastighet |

## Kostnader och återstående begränsningar

OpenAI kräver ett API-konto med debitering; ChatGPT-abonnemang är ingen konfiguration av denna apps API-nyckel. ASR, separat diarization, översättning och TTS debiteras enligt aktuella modeller och användning. Flera målspråk och omgenerering ökar förbrukningen. Kontrollera [aktuell API-prissättning](https://developers.openai.com/api/docs/pricing). Inga fasta kostnadsestimat visas utan underlag. Lokala modeller har hårdvaru-, el-, disk- och eventuella licenskostnader.

Återstående praktiska begränsningar: molnproviders och de valbara pyannote/Demucs/XTTS-funktionerna har inte verifierats med verkliga modeller här; den lokala ASR/Ollama/Piper-kedjan har testats med korta talprov. Ingen perfekt översättning, diarization, bakgrundsseparering, känsloöverföring eller röstlikhet garanteras. Live är blockbaserad, chunkgränser kan behöva rättas, och läppsynk samt multiuser-/Sites-worker-stöd saknas. Se den lokala verifieringsrapporten för både godkända prov och upptäckta kvalitetsfel.
