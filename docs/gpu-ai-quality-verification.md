# GPU och verklig AI-kvalitet – 2026-10-15

Utgångspunkt: senaste `origin/main`, `4704e33be542fec14bad0ea2e10c099d75705a28`. Detta steg prioriterar riktiga modellkörningar och felmätning. Det är inte ett godkännande av hela dubbningskedjans kvalitet.

## Tillgänglighet och återstående krav

| Del | Lokalt verifierat | Kvar / ofärdigt | Sites |
| --- | --- | --- | --- |
| CPU | Ursprunglig Python 3.13.15, Torch 2.14.1+cpu och CPU/int8-konfiguration bevarade. Verklig befintlig ASR→översättning→Piper→export-regression passerar. | Ingen generell kvalitetsgaranti. | Ingen native Python-inferens. |
| GPU-ASR | Separat Python 3.11.15, Torch 2.8.0+cu128, CTranslate2 4.8.3, faster-whisper 1.2.1, PyAV 16.1.0. Riktig RTX 5070-körning och HTTP `/transcribe`, med `device=cuda`, `compute_type=float16`. | Mänskligt facit för WhatsApp saknas. | Inte publicerat eller tillgängligt där. |
| Chatterbox | Separat Python 3.14.6, Torch/torchaudio 2.9.1+cu128, exakt låst V3-kod, verklig engelsk/svensk/arabisk syntes med standardröst. | Mänskligt lyssningsbetyg, arabisk kvalitet, röstlikhet, samtyckt röstbevarande och fullständig distributionsgranskning är ofärdiga. Utvärderingsverktyg; inte vald som produktions-TTS i studion. | Saknas. |
| Diarization | Modellåtkomst kontrollerad. | **BLOCKERAD:** community-1 gav HTTP 401; ingen tillgänglig token. Inga villkor accepterades. Inget riktigt tvåtalarresultat eller DER. | Saknas. |
| Demucs | Riktig htdemucs på GPU, kontrollmix och verkligt WhatsApp-ljud. Befintlig HTTP `/separate` lämnar en riktig FFmpeg-avkodad WAV. | Bevarande i naturliga ljudmiljöer kräver separata referensspår och mänsklig lyssning. Inte garanterad separering av musik/brus/effekter var för sig. | Saknas. |
| WhatsApp | Original, råtext och 14 ej godkända segment bevarade. Separata lyssningsklipp framtagna. | Användarens avskrift och uttryckliga godkännande inväntas. **Ingen ny fullständig engelsk MP3/MP4 genererad.** | Privat material har inte publicerats. |

Sites kontrollerades via `get_site`: aktiv version 6, senast uppdaterad `2026-10-15T13:51:56.362676+00:00`, [TON · Music Downloader](https://ton-cd-importer.asdasdsa213.chatgpt.site). Ingen publicering gjordes. En Git-push till main uppdaterar inte Sites. Befintlig musik-, CD-, inspelnings- och notimplementation är orörd.

## Miljöer och GPU-bevis

- `.venv` är kvar som CPU-miljö. SHA-256 för dess `pyvenv.cfg` och `torch/version.py` jämfördes före/efter utan förändring; CPU-kravfilen och `.env.local` skrevs inte om.
- `.venv-gpu` och `.venv-chatterbox` är separata, Git-ignorerade miljöer. Båda klarade `uv pip check` med normala, uppfyllda beroenden; inga Torch-versionsundantag användes.
- RTX 5070: 12 227 MiB rapporterat minne, drivrutin 617.42. Driveruppgiften CUDA 13.4 ersätter inte paketens faktiska CUDA-runtime 12.8.
- Riktig CUDA-matrisberäkning lyckades. Torch 2.8 innehåller `sm_120` och rapporterar compute capability 12.0. Detta kompletteras av faktisk CTranslate2-inferens; enbart GPU-discovery räknades inte som verifiering.
- `gpu_runtime.py` gör Torch-bibliotekens Windows-DLL:er åtkomliga endast i aktuell process och dess barn. Ingen system-PATH, drivrutin eller befintlig CPU-installation ändrades.
- GPU-gatewayen använder port 8766 och `WHISPER_REQUIRE_GPU=true`. CUDA-fel får inte ge en framgång märkt som GPU genom tyst CPU-fallback. Ursprunglig gateway och port 8765 är kvar.

## ASR: kvalitet, tid och minne

Primär jämförelse: fyra mänskliga FLEURS-prov, identiska lokala modellvikter, samma produktionsavkodare, automatisk språkidentifiering, inga text-/ordförrådsledtrådar. Tre körningar per modell/prov, modellinläsning separat, median av alla tre. CPU är befintlig miljö/int8; GPU är separat miljö/float16. Kvantisering skiljer sig alltså: en WER-skillnad tillskrivs inte enbart hårdvaran.

WER = ord-Levenshtein / referensord, med NFKC, gemener, borttagna kombinerande tecken och ordtokenisering. Ingen utjämning av arabiska bokstäver eller omskrivning av räkneord. Referenserna är datasetets publicerade avskrifter; rått WhatsApp-tal har inget mänskligt facit och får därför **WER = ej tillgängligt**.

<!-- ASR_IDLE_TABLE -->
| Modell | Prov / längd | CPU median | GPU median | WER CPU / GPU |
| --- | --- | ---: | ---: | ---: |
| medium | Arabiska test 0 / 8,16 s | 7,271 s | 0,622 s | 20 / 20 % |
| medium | Arabiska test 3 / 10,70 s | 7,587 s | 0,701 s | 0 / 0 % |
| medium | Engelska / 6,54 s | 6,263 s | 0,346 s | 0 / 0 % |
| medium | Svenska / 10,86 s | 6,891 s | 0,526 s | 9,52 / 0 % |
| large-v3 | Arabiska test 0 / 8,16 s | 13,416 s | 0,849 s | 13,33 / 13,33 % |
| large-v3 | Arabiska test 3 / 10,70 s | 27,970 s | 0,966 s | 0 / 0 % |
| large-v3 | Engelska / 6,54 s | 23,766 s | 0,494 s | 0 / 0 % |
| large-v3 | Svenska / 10,86 s | 15,956 s | 0,751 s | 0 / 0 % |

Den slutliga sekventiella körningen gjordes efter avslutade modellregressioner och frigjord Ollama-modell. Vanliga Windows-/skrivbordsprocesser fanns kvar; värddatorn var inte dedikerad eller CPU-klocklåst. CPU-tider varierar tydligt även mellan de två körserierna. Resultaten är mätta observationer på fyra prov med totalt 69 referensord, inte en allmän hastighets- eller dialektgaranti. Alla tre repetitioner gav samma WER för respektive rad. Modellhash, ljudhash och faster-whisper/CTranslate2/PyAV-versioner matchade mellan miljöerna.

Slutligt samplat totalminne på kortet: medium högst 4 037 MiB (lägsta observerat 1 834 MiB), large-v3 högst 6 017 MiB (lägsta 1 803 MiB). Mätningen omfattar hela kortet. Evidens: `test-results/gpu-quality/cpu-idle.json` och `cuda-idle.json`; laddningstid, samtliga repetitioner och råsegment finns där.
<!-- /ASR_IDLE_TABLE -->

Den första, samtidiga undersökningskörningen finns i `test-results/gpu-quality/{cpu,cuda}.json`. Alla tre körningar hade samma WER inom respektive modell/prov. På de fyra referenserna var medium CPU/GPU 20/20 %, 0/0 %, 0/0 %, 9,52/0 %. Large-v3: 13,33/13,33 %, 0/0 %, 0/0 %, 0/0 %. För WhatsApp uppmättes median 29,52/3,08 s (medium) respektive 135,68/4,03 s (large-v3). **De långa CPU-tiderna togs medan andra tester och installationer pågick och används inte som en ren hastighetsvinst.** Ingen korrekthet sluts från modellernas enighet eller sannolikheter.

I den första GPU-körningen var samplat maximalt totalminne 5 096 MiB för medium och 7 332 MiB för large-v3. `nvidia-smi` mäter hela kortet under WDDM, inklusive skrivbord och andra processer. Detta är inte exklusivt modellminne eller ett exakt allokeringsmaximum. Modell- och ljud-SHA-256, biblioteksversioner, avkodarinställningar, varje segment och samplingsserie finns i rapporterna.

Det sista kalla HTTP-testet av GPU-ASR tog 4,139 s inklusive modellinläsning och nätverksgränsen lokalt (`gateway.json`). En efterföljande varm körning tog 0,963 s. Ett tidigare kallt försök under konkurrerande modellbelastning tog 66,789 s; det är inte varm inferenstid. Befintlig Demucs-HTTP-adapter tog 10,198 s första gången och 4,487 s vid slutkontroll på kontrollmixen, med 3 175 244 byte giltig WAV. Slutkontrollens faktiska separeringsfil och tider finns i `test-results/gpu-quality/gateway-separation.json`; ett senare rent ASR-test skriver inte över den rapporten.

## Chatterbox: faktisk syntes och underkända prov

Kod: upstream commit `5de7a54aa4e5e2baadb0182dde554908b48b85c2`; PerTh `ff1c8ac55a976971245cdd53c18d6131ca00d993`. Modell: `ResembleAI/chatterbox`, revision `5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18`, `t3_mtl23ls_v3.safetensors`. Kod, exakta paket och modellfiler har separat proveniens. PyPI-paketet med samma versionsnummer 0.1.7 saknar V3-parametern och underkändes först. Den exakta upstream-koden installerades sedan i den separata miljön.

Standardröstens inbyggda conditioning användes. Ingen privat eller FLEURS-talares röst klonades. Seed 42, exaggeration 0,5, temperature 0,8, CFG 0,5 om annat inte anges. Modellinläsning 7,370 s. Inga måltexter skickades till verifierings-ASR.

| Prov | Syntestid | Ljudlängd | Automatisk återtranskribering / beslut |
| --- | ---: | ---: | --- |
| Engelska, CFG 0,5 | 20,907 s | 6,48 s | 4,55 % rå WER (1/22): `tenth` återges av Whisper som `10th`. Både MP3 och MP4 har samma avvikelse. Mänsklig naturlighet ännu ej bedömd. |
| Svenska, CFG 0,5 | 3,152 s | 5,00 s | 85,71 % WER, felaktigt detekterat som engelska. **Underkänt standardprov.** Separat ledtrådstest med svenska gav fortfarande 21,43 % WER; det ersätter inte auto-resultatet. |
| Svenska, CFG 0 | 20,543 s | 6,56 s | Ny faktisk ljudfil, automatiskt svenska, 0 % WER (0/14). Lovande inställningsförbättring; inget mänskligt kvalitetsbetyg. |
| Arabiska, CFG 0,5 | 4,499 s | 7,44 s | 33,33 % WER (5/15). Kräver lyssning, inklusive ord/ordinal och namn. **Ej kvalitetsgodkänt.** |
| Arabiska, CFG 0 | 4,850 s | 7,72 s | 33,33 % WER kvarstår. Ingen konstgjord förbättring eller automatisk rättning. |

Engelskan är första genereringen i processen och inkluderar uppvärmning. Senare språk är varma; deras tider är inte en jämförelse av språkens inneboende prestanda. Standardkörningens Torch-toppar: 3 285,48 MiB allokerat; hela kortet som mest 5 614 MiB samplat. Torch-mätningen omfattar inte andra processer eller all CUDA-overhead. CFG=0-körningen hade 3 288,44 MiB allokerat.

WER här mäter hur en separat ASR-körning återger syntesen, inte en mänsklig bedömning, oberoende modellpanel eller semantisk översättningspoäng. Stockrösten kan ge språk-/accentöverföring. CFG=0 prövades efter upstreams uttryckliga råd; misslyckade standardprov behålls i dokumentationen.

**Röstkvalitet ofärdig:** mänskligt lyssningstest har begärts på `http://127.0.0.1:8769`. Antal insamlade lyssnarsvar 0, naturlighet/tydlighet/MOS = ej tillgängligt. Ett enskilt senare användarbetyg ska rapporteras som ett användarbetyg, inte en lyssningspanel. Röstlikhet = ej tillgängligt eftersom kloning inte testats.

## MP3/MP4 och synkronisering

Det engelska röstprovet renderades mot **det tidigare referensgodkända offentliga FLEURS-provet**, inte WhatsApp. Videon har enfärgad bild, inga ansikten. Texten bevarar stormnamn, hav, tidpunkt, ordinal och säsong; översättningen är ett deklarerat testmanus. Det är inte en ny automatisk översättningskvalitetsmätning.

Ingen förkortning, klippning av tal eller tempohöjning användes. 6,48 s syntes får 1,68 s slutpaus i källans 8,16 s fönster. Faktisk avkodning med FFmpeg gav:

| Export | Avkodad längd | Längdskillnad mot källfönster | Energi över −45 dBFS |
| --- | ---: | ---: | --- |
| WAV | 8,160 s | 0 ms | 0,02–6,17 s |
| MP3 192 kbps | 8,160 s | 0 ms | 0,02–6,17 s |
| MP4 / AAC 192 kbps | 8,170667 s | +10,667 ms | 0,02–6,17 s |

Samtliga filer avkodades, hade hörbar energi och verkliga filhashar. Separat automatisk ASR av varje export ger engelska och 4,55 % rå WER enligt ovan. Ett riktigt Chromium-test verifierade dessutom MP3/MP4-uppspelning, uppmätt ljudenergi, sökning till 5 s, 640×360 video, oförändrade filbytes och inga sidfel. Den första enkla Python-testservern saknade Range och sökningen underkändes; `serve-ai-review.mjs` rättade detta på de privata lyssningssidorna. Ny kontroll verifierar 206/416, bytes och nekad filtraversering. Evidens: `test-results/ai-listening/browser-report.json`.

Energifönster är inte ord-/fonemjustering. Detta mäter containertiming i ett enda segment; det bevisar varken läppsynk eller synkroniserad naturlig konversation. Headless-webbläsarens PCM-mätning är inte en fysisk mänsklig lyssning. Mänskligt lyssningsgodkännande och WhatsApp-export är fortsatt öppna krav.

Filer: `test-results/ai-listening/en-dub.{wav,mp3,mp4}`, `render-report.json`; råa synteser och mätningar i `test-results/chatterbox-v3/`. Inga ljudfiler eller privata råavskrifter läggs i Git.

## Separering: musik och effekter mäts separat

Demucs 4.0.1, htdemucs, CUDA, 44 100 Hz stereo, shifts=0, overlap=0,25. Kontrollmixen är 18 s med **riktigt mänskligt FLEURS-tal samt genererad harmonisk musik och transienta effekter**. Det är ett kontrollerat diagnostikprov, inte en naturligt inspelad filmmix eller ett generellt SDR-benchmark. Separata kända komponenter gör att vinster kan skattas med gemensam minsta-kvadrat-anpassning.

| Mätning | Resultat |
| --- | ---: |
| Musikens komponentförstärkning i bakgrunden | −0,417 dB |
| Effekternas komponentförstärkning | −0,657 dB |
| Talläckagets komponentförstärkning | −21,410 dB |
| Bakgrundens RMS-fel mot facit | 0,00405 i float PCM |
| Längdfel | 0 sampel / 0 ms |
| Behandling, första mixen | 16,479 s för 18 s |
| WhatsApp, efter uppvärmning | 0,959 s för 49,689 s |
| Torch allokerat maximum / samplat hela kortet | 550,54 / 2 884 MiB |

Diagnostikgränserna ±3 dB för musik/effekter och högst −20 dB talläckage klarades för kontrollmixen. Det motsvarar inte en mänsklig kvalitetsgräns. Ett skalärt förstärkningsmått kan dölja lokala artefakter; verklig lyssning återstår. WhatsApp fick verkliga vocals/background-filer och oförändrat sampelantal, men saknar isolerat bakgrundsfacit: ingen bevarandepoäng eller påstående om vilka ljud som faktiskt finns där.

Evidens: `test-results/demucs-evaluation/report.json`, de separerade verkliga WAV-filerna och API-testets `test-results/gpu-quality/gateway-separation.json`. Modellvikten hämtades från Demucs officiella manifest med dess hashkontroll. Tiderna inkluderar olika uppvärmningslägen och är inte jämförbara som två innehållsbenchmarks.

## Licenser och modellåtkomst

- [Chatterbox-kod](https://github.com/resemble-ai/chatterbox/blob/5de7a54aa4e5e2baadb0182dde554908b48b85c2/LICENSE) och [exakta modellrevisionens kort](https://huggingface.co/ResembleAI/chatterbox/blob/5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18/README.md) anger MIT. Det gör modellen till en kommersiell kandidat, inte ett färdigt kvalitets-/distributionsgodkännande.
- Installerade centrala beroenden: Torch BSD-3, torchaudio BSD, S3Tokenizer Apache-2, transformers/diffusers/safetensors/Gradio Apache-2, librosa ISC, PerTh och spacy-pkuseg MIT, **pykakasi GPL-3.0-or-later**. GPL förbjuder inte kommersiell användning men distribution får inte beskrivas som en helt MIT-licensierad stack. CUDA/cuDNN och libsndfile har också egna villkor.
- Fullständig distributionsnotice och villkorsgranskning av alla extra tokenizer-/modellresurser, inklusive det automatiskt hämtade kinesiska pkuseg-paketet, är **ofärdig**. Ingen bred kommersiell produktionsapproval skrevs i appens licenspolicy. Bibliotekens metadata sparades i `test-results/chatterbox-license-inventory.json`; metadata är inte ett komplett juridiskt rättighetsbevis. Cacher styrs till projektet i utvärderingsverktyget.
- [Demucs](https://github.com/facebookresearch/demucs/blob/main/LICENSE) anger MIT. htdemucs är en musiksepareringsmodell; kodlicensen gör inte godtyckligt källjud tillåtet eller all bakgrundsbevaring korrekt.
- [community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) anger CC-BY-4.0 men kräver konto, villkorsacceptans och åtkomsttoken. Faktisk åtkomstkontroll gav 401 utan token. `test-results/diarization-access.json` innehåller revision och blockeringsstatus. Tvåtalartest/DER är inte utfört.
- XTTS/CPML och MMS/CC-BY-NC uppgraderades inte till kommersiella alternativ. Samtyckt kloning saknar röstprov efter användarens val av standardröst.

## WhatsApp: manuellt stopp, inga gissade ord

Jobb `2356e578-9bb3-4438-a33c-b42791e2ea44`, original-SHA-256 `3519ce4ac91233ee1dfce0d2399fe430eec5cf933a5cfefbbccd3794119337cb`. Den privata granskningskopian ligger i `test-results/ultimate-jobs`.

14 väntande segment: s1 0–2,18; s2 2,94–5,28; s3 6–8,30; s4 8,90–13,46; s5 13,46–16,04; s6 16,04–18,60; s8 22,22–25,51; s9 25,51–29,67; s10 29,67–32,47; s11 32,47–36,67; s12 36,67–40,33; s13 40,33–45,63; s14 45,63–47,49; s15 48,35–49,63. s7 var redan separat granskat.

`prepare_review.py` skapade 14 riktiga WAV-klipp med upp till 0,35 s sammanhang och en privat HTML-sida. Modellförslag är dolda tills granskaren väljer att visa dem. `review.json` har tom mänsklig avskrift och `approved=false` för alla väntande segment. Jobbet ändrades inte. Användaren har valt att själv lyssna och lämna rättningar. Efter avskrift krävs uttryckligt godkännande; först därefter kan just detta jobb ge engelsk MP3/MP4 och verifieras mot godkänt innehåll och timing.

## Regressioner

412 JavaScript/TypeScript-tester passerade. 32 Python-tester passerade, inklusive att strikt CUDA inte kan falla tillbaka till CPU och att WER inte accepterar ett tomt facit. Typkontroll, lint och Next-produktionsbygge passerade. En första sandboxkörning stoppades före tester av EPERM; den räknas inte som ett testpass.

Alla befintliga fristående regressioner kördes: `test:live`, `test:ui`, `test:recording`, `test:computer-recording`, `test:audio-level`, `test:audio-edit`, `test:translation:ui`, `test:translation:fidelity` (20 verkliga modellprov), `test:translation:live`, `test:translation:local` samt `studio-check.cjs` för bland annat MIDI/MusicXML/noter. De två verkliga pipeline-testerna använde ett offentligt mänskligt engelskt FLEURS-prov i egna jobbkataloger, utan källrättningar; WAV/MP3/M4A återtranskriberades med 0 % WER. Det är regression av fungerande kedja, inte ett godkännande av arabiskt WhatsApp-tal eller Chatterbox.

Sites byggdes och testades endast lokalt på separat port: `test:sites` och befintliga UI-/inspelnings-/nivå-/redigeringsregressioner passerade. De bekräftar att befintliga funktioner fortfarande fungerar, inte att GPU-inferens finns på Sites. Loggar: `test-results/gpu-{browser,sites}-regression.json`, `gpu-work-*`, `gpu-sites-regression-*`.

## Återskapa och kör på Windows

Kör från repositoryts rot. Använd separata miljöer; installera inte dessa låsfiler i `.venv`. UV måste finnas. Modell- och paketnedladdning kräver internet och flera GB diskutrymme. Låsfilerna gäller Windows och respektive Python-version.

```powershell
uv python install 3.11.15 3.14.6 --install-dir .tmp/python --cache-dir .tmp/uv-cache
uv venv --python .tmp/python/cpython-3.11.15-windows-x86_64-none/python.exe local-ai/.venv-gpu
uv venv --python .tmp/python/cpython-3.14.6-windows-x86_64-none/python.exe local-ai/.venv-chatterbox
uv pip install --python local-ai/.venv-gpu/Scripts/python.exe --cache-dir .tmp/uv-cache --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cu128 -r local-ai/requirements.gpu.windows.lock.txt
uv pip install --python local-ai/.venv-chatterbox/Scripts/python.exe --cache-dir .tmp/uv-cache --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cu128 -r local-ai/requirements.chatterbox.windows.lock.txt
uv pip check --python local-ai/.venv-gpu/Scripts/python.exe --cache-dir .tmp/uv-cache
uv pip check --python local-ai/.venv-chatterbox/Scripts/python.exe --cache-dir .tmp/uv-cache
```

Den verifierade GPU-miljön använder den redan befintliga Conda-tolkens Python 3.11.15 som bas. Kommandona ovan visar en separat UV-bastolk för ny installation; sökvägen för den hämtade tolken kan skilja mellan UV-versioner. Chatterbox-tolk 3.14.6 installerades faktiskt via UV i `.tmp/python`.

```powershell
Copy-Item local-ai/gpu.env.example .env.gpu.local # endast om filen inte redan finns
npm.cmd run studio:gateway:gpu
# I en annan terminal:
npm.cmd run test:translation:gpu
# Efter att kontrollmixen skapats av evaluate_separation.py:
npm.cmd run test:translation:gpu -- --separation
```

`studio:gateway` fortsätter använda CPU. För att låta en separat lokal app/worker använda GPU-gatewayen, sätt `STUDIO_LOCAL_URL=http://127.0.0.1:8766` i just deras processmiljö. Samma privata gateway-token från `.env.local` behövs fortfarande. Inga tjänster binds till en publik adress.

Privata lyssningssidor kan startas separat med `node scripts/serve-ai-review.mjs` (port 8769, offentligt referensprov) och `node scripts/serve-ai-review.mjs --whatsapp` (port 8768, privata granskningsklipp). De servar endast respektive resultatmapp på loopback och stöder byte-range-sökning. Verifiera referensprovets verkliga webbläsaruppspelning med `node scripts/check-ai-listening.mjs`.

```powershell
$env:PYTHONUTF8='1'
local-ai/.venv-chatterbox/Scripts/python.exe local-ai/setup_chatterbox.py
local-ai/.venv-chatterbox/Scripts/python.exe local-ai/evaluate_chatterbox.py --output test-results/chatterbox-v3
local-ai/.venv-chatterbox/Scripts/python.exe local-ai/evaluate_chatterbox.py --languages sv ar --cfg-weight 0 --output test-results/chatterbox-v3-cfg0
local-ai/.venv-gpu/Scripts/python.exe local-ai/evaluate_separation.py --output test-results/demucs-evaluation --media test-results/ultimate-jobs/2356e578-9bb3-4438-a33c-b42791e2ea44/normalized.wav
```

`setup_chatterbox.py` laddar som standard den exakt verifierade revisionen, kontrollerar offentligt MIT-märkt checkpoint och sparar revision/hashar. ASR-jämförelserna kräver även installerade Whisper-vikter och FLEURS-fixturer; se [lokal installation](local-ai-setup.md). En ny referenslös inspelning ska aldrig få ett konstruerat WER-facit. Bedöm röstkvalitet med faktisk lyssning och låt osäkert tal förbli osäkert.
