# Installerad lokal AI

Denna dator har en isolerad Pythonmiljö i `local-ai/.venv`, lokalt hämtade Whisper-/Piper-modeller och Ollama `gemma3:12b` som vald översättningsmodell. `.env.local` väljer enbart lokala providers och innehåller en privat gateway-token. Nyckeln visas inte i klienten och filen ignoreras av Git.

## Starta igen

Kör från projektmappen i tre terminaler:

```powershell
npm.cmd run studio:gateway
```

```powershell
npm.cmd run studio:worker
```

```powershell
npm.cmd start -- --port 3011
# Eller npm.cmd run dev för utveckling på port 3000.
```

Öppna `http://127.0.0.1:3011/translation`. Ollama måste också vara igång. Gateway, worker och webbsida ska visa lokal konfiguration. Ingen OpenAI-nyckel behövs. Ingen röstkloning används; de installerade Piper-rösterna är standardröster.

## Modeller och maskin

- Engelska: English (US) är standard i studion. Installerade Piper-röster är `en-us-lessac`, `en-us-ryan`, `en-gb-alba` och `en-gb-alan`, med modellens verkliga US/UK-accent och valbar manlig/kvinnlig röst. Se [aktuella tester och röstlicenser](english-translation-verification.md).
- ASR: `Systran/faster-whisper-large-v3`, CPU int8. Medium-modellen finns kvar som ett lättare alternativ.
- Svensk översättning och lokal bildkontext: `gemma3:12b` i Ollama, GPU där Ollama placerar modellen. Anropet använder 8 192 tokens kontext och låg temperatur. Qwen 3.5 9B och Whisper large-v2 finns kvar som alternativ.
- Engelska mål använder nu den installerade `translategemma:12b` genom `OLLAMA_ENGLISH_MODEL`. Svenska och andra mål behåller `gemma3:12b`. Bildkontext använder fortfarande Gemma. Utelämnas override-värdet används huvudmodellen för alla mål; en konfigurerad men saknad engelsk modell ger ett tydligt fel.
- Svensk TTS: Piper `sv_SE-nst-medium`, tränad av KBLab på NST-material. Lisa finns också kvar som alternativ.
- Arabisk TTS: Piper `ar_JO-kareem-medium`, bland annat för det dokumenterade syntetiska kontrollprovet.
- Valbar svensk TTS: `facebook/mms-tts-swe`, röst-id `sv-mms-nc`, endast för icke-kommersiell användning enligt modellens CC-BY-NC-4.0. Piper är standardvalet; MMS måste väljas uttryckligen.
- Testad basmiljö: Windows, Python 3.13.15, i7-14700K, 32 GB RAM och RTX 5070 med 12 GB VRAM.

Whisper kör på CPU för att fungera utan separat installation av CUDA/cuDNN och lämna GPU-utrymme till Ollama. Detta är filbearbetning; här finns ingen garanti om att Live Translate hinner med kontinuerligt tal.

Modellrepositoriernas exakta revisioner och filernas SHA-256 finns i `local-ai/models/manifest.json`. Pythonpaketens installerade versioner finns i `local-ai/requirements.windows.lock.txt`. Modellvikter och virtuella miljön checkas inte in i Git.

## Återskapa installationen

```powershell
python -m venv local-ai/.venv
local-ai/.venv/Scripts/python.exe -m pip install --extra-index-url https://download.pytorch.org/whl/cpu -r local-ai/requirements.windows.lock.txt
local-ai/.venv/Scripts/python.exe -m pip check
local-ai/.venv/Scripts/python.exe local-ai/setup_models.py
ollama pull gemma3:12b
ollama pull translategemma:12b
npm.cmd run studio:configure-local
```

För samma engelska modellval: lägg `OLLAMA_ENGLISH_MODEL=translategemma:12b` i `.env.local`. Starta om gateway, worker och webbserver efter ändringen. Konfigurationskommandot behåller detta extra värde.

Konfigurationskommandot bevarar befintlig gateway-token och övriga miljövariabler. Det väljer CPU int8, lokal översättning/TTS och lokala modellvägar. Ändringar kräver omstart av de tre processerna.

Den fullständiga Windowslåsfilen innehåller också paketen för valbar MMS. CPU-indexet behövs för den låsta versionen `torch==2.14.1+cpu`; paketversionen är uttryckligen en CPU-byggnad. För en mindre installation med bara Whisper/Piper kan i stället `local-ai/requirements.txt` användas. Den filen anger versionsintervall och återskapar därför inte exakt den låsta miljön.

### Valbar MMS-röst

Installera de exakt angivna tilläggen och hämta MMS-vikterna:

```powershell
local-ai/.venv/Scripts/python.exe -m pip install --extra-index-url https://download.pytorch.org/whl/cpu -r local-ai/requirements-mms.txt
local-ai/.venv/Scripts/python.exe -m pip check
local-ai/.venv/Scripts/python.exe local-ai/setup_models.py --with-mms
npm.cmd run studio:configure-local
```

Tilläggsfilen låser Torch CPU till `2.14.1+cpu`, Transformers till `4.57.6` och de modellrelaterade paket som används i den installerade miljön. Den ersätter inte basinstallationen. `setup_models.py --with-mms` hämtar även Whisper- och Piper-vikter och skriver ett nytt modellmanifest; spara därför manifestet tillsammans med varje verifieringsrapport om modellrevisionerna ska kunna jämföras senare.

`STUDIO_MMS_ENABLED=true` och `MMS_MODEL` till den lokala modellmappen aktiverar alternativet. Konfigurationskommandot sätter dessa värden; rösten annonseras först när modellens `config.json` finns lokalt. Välj sedan `MMS svenska · endast icke-kommersiellt` i appen eller ange `STUDIO_TEST_VOICE=sv-mms-nc` vid ett test. `STUDIO_MMS_ENABLED=false` stänger av alternativet. MMS läser lokala safetensors-vikter och kör på CPU med fyra Torch-trådar.

MMS använder `MMS_SEED` med standardvärdet **555**, som sätts på nytt inför varje syntes. Den aktuella `.env.local` använder också 555. Spara det aktiva värdet med verifieringsrapporten om det ändras. Det gör omkörningen jämförbar i samma miljö; det är ingen garanti för korrekt uttal, samma vågform på andra plattformar eller godkänd video. Seedjämförelsen och ännu väntande slutverifiering beskrivs i [uppföljningsrapporten](local-ai-follow-up-verification.md).

Hämtning av modeller och öppna talprov använder internet. Själva transkriptionen, översättningen och röstgenereringen sker på loopback. `HF_HUB_OFFLINE=1` och lokala modellvägar gör att Whisper inte behöver hämta vikter under bearbetningen.

## Riktigt test av exporterad röst

```powershell
npm.cmd run test:translation:local
```

Standardtestet genererar neuralt arabiskt tal med en känd referenstext och väljer nu engelska som mål. Alla providers är riktiga. Sätt `STUDIO_TEST_TARGET=sv` för det tidigare svenska provet. För en egen rättighetsklarerad inspelning:

```powershell
$env:STUDIO_TEST_MEDIA = "C:/samples/arabic.wav"
$env:STUDIO_TEST_REFERENCE_TXT = "C:/samples/arabic-reference.txt"
npm.cmd run test:translation:local
```

Testet laddar upp genom webbappens API, inväntar den separata workern och hämtar WAV, MP3 och M4A genom export-API:t. Video ger även en MP4 vars faktiska ljudspår återtranskriberas. Varje hämtad fil transkriberas igen utan språkledtråd. Svenska, ordavvikelse, längd, filstorlek och SHA-256 sparas i en rapport under `test-results/local-arabic-swedish-*`.

Detta kontrollerar hur väl det nedladdade ljudet återges som den svenska texten. Återtranskribering ensam bevisar inte korrekt betydelse mot originalet. `STUDIO_TEST_EXPECTATIONS=tests/fixtures/translation-weather.meaning.json` kontrollerar därför kritiska fakta både i vädertexten och i varje återtranskriberad export. Facitfilen används endast av testet och skickas aldrig till AI-tjänsterna. Ange `STUDIO_TEST_BROWSER_UPLOAD=true` för verklig uppladdning genom webbläsaren och kontroll av uppspelning av exporterad MP4 i gränssnittet. Ett avslutat jobb eller en spelbar MP4 räcker inte för att godkänna innehållet; samtliga kritiska faktakontroller och granskningen mot källan behöver också vara klara.

Videobearbetning läser två lågupplösta bildrutor lokalt med Gemma 3 för ämnesord. Källjud och bilder skickas inte till molntjänster. Samtalets hela transkript används som sammanhang; synliga föremål får inte användas för att hitta på repliker eller antal. `STUDIO_VIDEO_CONTEXT=false` stänger av bildstödet. Även med bildstöd kan snabbt, överlappande eller otydligt tal behöva innehållsgranskas.

## Kompatibilitetsfixar

PyAV 19 tog bort `av.open(metadata_errors=...)`, som faster-whisper 1.2.1 använder. Projektet låser därför PyAV till 16.x och den faktiskt testade Windowsmiljön till 16.1.0. Installationen kontrolleras också med `pip check`.

Gatewayen begär JSON-output. `think=false` används för Qwen 3-modeller; parametern utelämnas för Gemma. Förkortning kontrolleras mot ursprunglig källtext, full översättning och faktisk uppmätt tallängd, med högst tre försök. Yttre TTS-tystnad trimmas och upp till 750 ms efterföljande paus kan användas. Föredraget tempo är ×0,85–1,20. Om trogen förkortning inte ryms får en långsam röst ökas till högst ×1,40, bara när slutlig täthet är högst 180 ord/minut. Detta är produktens gränsvärden, ingen garanti för perceptuell kvalitet. Fakta får inte strykas för att få plats.

Pipers medföljande svenska eSpeak har gett fel uttal av `tionde`. `local-ai/speech_text.py` använder därför ett explicit fonemblock, `[[tˈiːʊndə]]`, endast i syntesindata. Den tidigare föreslagna omskrivningen `10:e` har inte räckt för godkänt slutljud och används inte som aktuell lösning. En liten uttalsordlista behandlar Jerry/Terry/Larry/Barry/Harry; Jerry har dessutom ett eget fonemblock. Text- och undertext-exporten behåller riktiga stavningar. Detta gäller Piper-grenen; MMS får måltexten utan dessa Piper-omskrivningar. Aktuell uttalskvalitet måste kontrolleras i det faktiska exporterade ljudet.

ASR delas normalt i **60-sekundersdelar** (`STUDIO_ASR_CHUNK_SECONDS`, begränsat till 10–120 s i pipelinen). Whisper använder `beam_size=5`, `temperature=0`, `vad_filter=True`, `word_timestamps=True` och **`condition_on_previous_text=True`** inom varje del. Föregående text inom Whisper-avkodningen behålls alltså; de korta oberoende delarna i tidigare försök gav upprepningar i överlappande tal. Det lokala transkriptionsanropet har 600 sekunders timeout och inga automatiska HTTP-omförsök. Det är avgränsningar i konfigurationen, ingen garanti mot hallucinationer.

Den breda LLM-korrigeringen av ASR är borttagen. Endast en avgränsad arabisk ordinalregel återstår: ett räkneord 3–10 före en obestämd feminin singular kan få ordinalform när samma bestämda singular förekommer i efterföljande apposition. Regeln ska lämna faktiska pluralantal, siffror, negationer och meningar utan denna konstruktion orörda. Ändrade segment behåller den akustiska råtexten i gatewayens `raw_text`, som sparas som `rawText` i jobb/JSON-export, och markeras som språkändrade. Detta är en språklig slutsats med sparad råtext, ingen ny akustisk avkodning. Bildkontext styr inte den akustiska avkodningen; den används i textstegen.

## Källor och licenser

[faster-whisper](https://github.com/SYSTRAN/faster-whisper), [Whisper-vikter](https://huggingface.co/Systran/faster-whisper-large-v3), [Gemma 3](https://ollama.com/library/gemma3:12b), [Piper](https://github.com/OHF-Voice/piper1-gpl) och [Piper-röster](https://huggingface.co/rhasspy/piper-voices). Rösternas lokala `MODEL_CARD` följer med hämtningen och beskriver respektive träningsmaterial; NST-materialet anges där som CC0. Bibliotek och modeller har egna licensvillkor.

Den valbara [MMS-modellen för svenska](https://huggingface.co/facebook/mms-tts-swe) har CC-BY-NC-4.0 och ska väljas endast för icke-kommersiell användning med tillhörande attribution. Modellens villkor skiljer sig från Piper-rösternas. Lokal körning ändrar inte licensvillkoren.

De mänskliga arabiska kontrollproven kommer från [Google FLEURS](https://huggingface.co/datasets/google/fleurs), `ar_eg/test`, raderna 0 (id 1993) och 3 (id 1942), CC-BY-4.0. Svensk översättning och syntetisk röst är bearbetningar av respektive prov. Ursprungsreferens och attribution sparas i `local-ai/fixtures/*.provenance.json`.
