# Verifiering med installerade lokala modeller – 2026-10-15

## Resultat

Ett mänskligt arabiskt talprov på **10,70 sekunder** har körts genom den verkliga webbappens uppladdning, persistenta kö, worker, ASR, översättning, svensk TTS, synkronisering och export. Inga AI-svar var mockade. WAV, MP3 och M4A hämtades genom appens export-API och transkriberades sedan på nytt utan språkledtråd.

Alla tre exporter identifierades som **svenska**. Återtranskriptionen matchade den slutliga svenska översättningen ord för ord efter normalisering av skiljetecken och skiftläge (**0 % WER i just detta prov**). WAV hade samma totallängd som originalet, 10,70 s. MP3 var 10,73 s med formatets kodningspadding; M4A var 10,70 s.

Det arabiska källtranskriptet matchade datasetets referens efter samma normalisering, inklusive borttagning av arabiska vokaltecken (**0 % WER i provet**).

## Modeller som faktiskt kördes

| Steg | Lokal implementation |
| --- | --- |
| ASR och återtranskription | faster-whisper 1.2.1, `Systran/faster-whisper-large-v3`, CPU int8 |
| Översättning | Ollama `qwen3.5:9b`, lokalt GGUF, GPU, 8 192 tokens kontext, `think=false` |
| Svensk röst | Piper 1.8.0, `sv_SE-nst-medium` |
| Media | Befintlig native FFmpeg, riktig WAV/MP3/M4A-kodning |

Whisper-revision: `edaa852ec7e145841d8ffdb056a99866b5f0a478`. Piper-revision: `c10ece1aade47bb51c153c893d14e5bf8e5b7117`. Filernas SHA-256 och alla hämtade modelldata finns i `local-ai/models/manifest.json`. Exakta Pythonpaket är låsta i `local-ai/requirements.windows.lock.txt`.

## Källa, text och redaktionell korrigering

Källa: [Google FLEURS](https://huggingface.co/datasets/google/fleurs), `ar_eg/test`, rad 3, id 1942, CC-BY-4.0. Det är en mänsklig inspelning. Den svenska översättningen och syntetiska rösten är bearbetningar av provet. Ursprungsreferens och attribution finns även i `local-ai/fixtures/fleurs-ar-eg-test-3.provenance.json`.

Referens:

> نصنع بيوتنا وملابسنا من النباتات . معظم الطعام الذي نتناوله من النباتات كذلك. بدون النباتات، لا يمكن للحيوانات البقاء.

Verifierad svensk text i ljudet:

> Våra hus och kläder görs av växter. De flesta av de livsmedel vi äter kommer också från växter. Utan växter kan djur inte överleva.

**En manuell textkorrigering behövdes för timing.** Modellen skrev först ”Vi bygger våra hus och gör våra kläder av växter.” Den genererade rösten var för lång med 160 ms även vid högsta tillåtna tempo. Appen stoppade ljudexporten för granskning. Jag ändrade målsegmentet till ”Våra hus och kläder görs av växter.” via appens redigerings-API och återupptog samma jobb. Betydelse, källtranskript och tidsfönster behölls. Detta var alltså ett verkligt arbetsflöde med granskning, inte ett helt oövervakat godkänt resultat.

Slutlig största beräknade överskridning var 5 ms i ett annat segment, inom toleransen. Total bearbetningstid enligt jobbets ackumulerade steg var cirka 37 s, exklusive granskningstiden. Detta är ingen allmän prestandabenchmark.

## Filer och reproduktion

Jobb: `90edbec2-5a7c-42ff-8d2e-483d9d54182d`.

Rapport, original, svenska exporter och separata återtranskript finns i:

`test-results/local-arabic-swedish-2026-10-15T10-37-39-549Z/`

WAV SHA-256: `9b97ab27b3c6fe416c607ae54a184f7b8bd628e8914310080fe12c311ae89b79`.

MP3 SHA-256: `19a69cd3b729a47efae95ce3a0bdd8407d8df07133c5554d4bec2d18f3ee95f8`.

M4A SHA-256: `ff60ae8834efa197e9116be73dc71236e515c0fb22fde122a9b7e55488c9cf78`.

Startkommandon och nyinstallation finns i [local-ai-setup.md](local-ai-setup.md). `npm.cmd run test:translation:local` testar ett helt nytt syntetiskt arabiskt kontrollprov med riktiga modeller. För en egen inspelning används `STUDIO_TEST_MEDIA` och valfritt `STUDIO_TEST_REFERENCE_TXT`. Ett redan redigerat jobb kan verifieras igen genom att även ange `STUDIO_TEST_JOB_ID`; testet kontrollerar då att originalfilen matchar jobbets media. `STUDIO_TEST_CORRECTIONS` kan peka på en JSON-fil med dokumenterade ändringar.

## Upptäckta begränsningar

- Ett tidigare syntetiskt prov med Whisper medium, Qwen 3.5 4B och Lisa-rösten gav svensk export men 12,9 % WER vid återtranskription. Det motiverade kontroll med mänskligt tal och större modeller.
- Ett mänskligt väderprov, FLEURS rad 0/id 1993, avslöjade ett ordningstalsfel i ASR och felaktig stormterminologi i översättningen. Även den större konfigurationen behövde innehållsgranskning där. Dessa jobb är markerade för granskning och deras ljudexport visas inte som färdig i appen.
- Återtranskription jämför ljudet med den svenska texten. Den bevisar inte att den svenska textens betydelse är korrekt mot arabiskan. Därför kontrollerades de tre sakpåståendena och negationen separat i det godkända växtprovet.
- Noll ordavvikelse i ett kort prov säger inget om generell dialekttäckning, felfri översättning eller röstens perceptuella kvalitet. Långa filer, flera talare och Live med dessa modeller har inte kvalitetsvaliderats här.
- Inga moln-API:er användes för mediebearbetningen. Modell- och provhämtningar använde internet. GPU/CPU-, el- och lagringskostnader finns fortfarande.
