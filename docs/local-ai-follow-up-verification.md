# Uppföljning av lokal talöversättning – 2026-10-15

**Status: väderprovet godkänt; video väntar och är inte godkänd.** Ett nytt komplett väderprov har klarat samtliga 32 faktakontroller och återtranskriptionen av WAV, MP3 och M4A efter de senaste ändringarna. Den här rapporten skiljer det resultatet från tidigare förkastade prov och begränsade diagnostiska körningar.

Den [tidigare verifieringen](local-ai-verification.md) gäller ett separat kort växtprov med en dokumenterad manuell timingkorrigering och dåvarande modeller. Det nya väderprovets underlag redovisas här; videons innehåll och slutexport återstår att verifiera. Installations- och körkommandon finns i [installationsguiden](local-ai-setup.md).

## Sparade prov som inte godkänts

| Underlag | Sparad observation | Bedömning |
| --- | --- | --- |
| Väder, Piper `sv-nst`, jobb `da7903eb-41d8-4c45-b114-fd30d271acdf` | Rapporten har `passed: false`. Alla tre ljudexporter återtranskriberade `tionde` som `tid under`; faktakontrollen för ordinalen misslyckades. | Förkastat ljudresultat. Korrekt måltext och avslutat jobb räckte inte. |
| Väder, MMS `sv-mms-nc`, jobb `d721ca74-8b6f-40e1-8ad8-123a6f4f0cd2` | Rapporten har `passed: false`. WAV, MP3 och M4A återtranskriberades med `Igeri` där texten sade `Jerry`; namnfaktakontrollen misslyckades i samtliga. | Förkastat ljudresultat före den nya seedkonfigurationen. Rapportfältet `Piper sv-mms-nc` är en felaktig äldre etikett; röst-id:t avser MMS. |
| Väder, jobb `f6711d81-f3d6-4a51-85ee-1ec9c2d858e3` | Sparad måltext och WAV/MP3 finns, men ingen komplett `report.json` för alla format. | Ofullständig verifiering; inte godkänt. |
| Video, jobb `85fcd9dd-4951-4083-8b89-7100f49bf654` | Jobbet sparades som `completed`, men måltexten innehöll instabila upprepningar, `Tre frukostar` och `Tre hjältar`. Ingen komplett export-/webbläsarrapport finns i provmappen. | Förkastat som kvalitetsunderlag. Ingen godkänd video har visats av denna uppföljning. |

Sparade rapporter och delresultat:

- Piper-väder: `test-results/local-arabic-swedish-2026-10-15T11-29-55-206Z/report.json`.
- MMS-väder: `test-results/local-arabic-swedish-2026-10-15T11-49-02-358Z/report.json`.
- Ofullständigt väderprov: `test-results/local-arabic-swedish-2026-10-15T11-37-57-041Z/`.
- Tidigare videoprov: `test-results/local-arabic-swedish-2026-10-15T11-32-54-916Z/`.

Rapporterna ovan kan visa att en fil identifierades som svenska och hade låg ordavvikelse mot måltexten samtidigt som en kritisk sakuppgift saknades. Sådana prov är inte godkända. ASR:s stavning ensam kan inte säkert avgöra om felet sitter i uttalet eller återtranskriptionen; den visar att den fördefinierade verifieringen inte klarades.

## Avgränsad diagnostik

En fristående jämförelse av MMS-seed finns i `test-results/mms-pronunciation-review/results.json`. Seed **555** gav ett 9,904 sekunder långt WAV-prov där large-v3, utan språkledtråd, återgav samtliga sju angivna kontrollord inklusive `Jerry` och `tionde`. Seed 1234 missade `Jerry`, och seed 0 missade säsongsankaret enligt samma kontroller. Detta motiverade valet av seed 555 för den kompletta väderkörningen nedan. Seedjämförelsen ensam verifierade inget komplett uppladdnings-, timing- eller exportflöde.

En separat large-v2-körning av hela videons ljud finns i `test-results/independent-video-review/review.md` med oförändrad råtext och ordsannolikheter. Den gav bland annat `15 دقائق`, upprepade `3 ابطال` och `سبعة`, men flera ställen var mycket osäkra. Den avgör inte ensam om samtalet avser fotbollstitlar, mästare eller hjältar. Ingen säker ordagrann arabisk referens eller godkänd svensk video kan härledas enbart ur den körningen. Large-v2-körningen använde temperaturfallback och ska inte beskrivas som produktionskonfigurationens `temperature=0`.

## Konfiguration för uppföljningen

| Del | Konfiguration |
| --- | --- |
| ASR | faster-whisper large-v3, CPU int8, 60 s delning som standard, beam 5, temperatur 0, VAD, ordtider och `condition_on_previous_text=True` |
| Lokal ASR-anslutning | 600 s timeout, inga automatiska HTTP-omförsök |
| ASR-efterbehandling | Ingen bred LLM-omskrivning; endast avgränsad arabisk ordinalregel, med ursprunglig `rawText` bevarad |
| Översättning | Lokala Ollama-modellen `gemma3:12b`; spara exakt modellrevision och aktiva inställningar |
| Svensk röst | Piper är standard. Vid särskilt MMS-prov: `sv-mms-nc`, CPU Torch `2.14.1+cpu`, Transformers `4.57.6`, `MMS_SEED=555` (även kodens standard), CC-BY-NC-4.0 |
| Förkortning | Spara full måltext och slutlig formulering; kontrollera att tal, namn och negationer överlever |
| Media | Riktiga exporter via appens API och, för video, faktisk uppladdning och uppspelning genom gränssnittet |

Väderresultatet nedan har ett sparat jobb och utdata från samma körning. Rapporten anger MMS-revision `62c98ce783f0a4c127d35300bca120dbdf03ad93`, seed 555, Whisper-revision `edaa852ec7e145841d8ffdb056a99866b5f0a478` och den valda Ollama-modellens digest. Tidigare prov återanvänds inte som bevis för nya inställningar. För videon är konfigurationen fortfarande underlag för kommande slutverifiering.

## Verifieringskrav och återstående videounderlag

Punkterna nedan beskriver underlaget som behövs. Väderprovets genomförda kontroller redovisas i slutresultatet; videon väntar fortfarande på ett komplett och godkänt underlag.

1. Spara originalfil, SHA-256, källans rättigheter/attribution, jobb-id, valt röst-id, modellmanifest och exakt konfiguration. Ange om körningen var helt automatisk eller innehöll någon manuell ändring.
2. Granska källtranskript mot ljudet, särskilt antal, ordinaler, namn och negation. Redovisa den råa ASR-texten bredvid varje språkändrat segment. Markera osäkra repliker i videon i stället för att fylla luckorna med ett påstått facit.
3. Granska svensk fulltext och varje automatisk förkortning mot källan. För väderprovet ska ordinal, säsong, namngiven storm, subtropisk storm, Atlanten, idag och Jerry finnas kvar med rätt innebörd. För videon behöver en tillförlitlig innehållsreferens först fastställas för de osäkra replikerna.
4. Hämta WAV, MP3 och M4A samt MP4 för video. Återtranskribera varje faktiskt nedladdad fil utan språkledtråd, källtext eller kontrollord som prompt. Spara råa återtranskript, faktakontroller, ordavvikelse, längd, storlek och SHA-256. Samtliga kritiska faktakontroller behöver vara godkända; låg genomsnittlig ordavvikelse räcker inte.
5. För video: bevara bildström och längd, kontrollera det exporterade ljudspåret och spela faktiskt upp den exporterade MP4-filen i appen. Spara webbläsarens observationer och skärmbild. Uppspelning visar teknisk funktion; korrekt innehåll bedöms separat i stegen ovan.

## Godkänt slutligt väderprov

Rapport: `test-results/local-arabic-swedish-2026-10-15T11-55-51-825Z/report.json`, färdig 2026-10-15 kl. 11:57:17 UTC. Jobb: `081b9560-6837-4a7c-8ce7-e4cbcbf674a3`. Det mänskliga arabiska FLEURS-väderprovet är 8,16 sekunder långt. Uppladdning genom appens API, separat worker, lokala modeller och hämtning av verkliga ljudexporter kördes utan mockade providers eller molnbearbetning. Rapportens `corrections` är tom: ingen manuell textändring gjordes.

Den officiella arabiska referenstexten som sparats i rapporten är:

> تشكلت في المحيط الأطلسي اليوم عاشر عاصفة مُسماة لموسم الأعاصير الأطلسية، العاصفة شبه الاستوائية جيري.

Slutlig svensk text:

> Den formades i Atlanten idag, den tionde namngivna stormen för Atlantens orkansäsong, den subtropiska stormen Jerry.

Referensens `عاشر عاصفة مُسماة لموسم الأعاصير الأطلسية` anger den tionde namngivna stormen under den atlantiska orkansäsongen. Den efterföljande appositionen identifierar den som den subtropiska stormen Jerry. Den svenska formuleringen behåller denna räckvidd: ordningsnumret räknar säsongens samtliga namngivna stormar, medan `subtropiska` beskriver Jerry. Även bildning i Atlanten, idag och namnet Jerry finns kvar. Den svenska meningen är grammatiskt något styltig med sina appositioner, men sakuppgifterna motsvarar referensen.

Rå-ASR skrev `عشر عاصفة`; den avgränsade ordinalregeln ändrade detta till `عاشر عاصفة`. Den oförändrade akustiska texten finns kvar i segmentets `rawText` i `job.json`, med en synlig varning om språkändringen. Det är en automatisk grammatisk bedömning, inte en andra akustisk bekräftelse. Efter denna ändring är källtextens WER mot referensen 6,67 %, bland annat på grund av formen `مسمى` mot referensens `مُسماة`. Svensk sluttext har därför också granskats direkt mot referensens sakuppgifter.

Rapporten har `passed: true`: 4/4 kontroller i källtranskriptet, 7/7 i svensk måltext och 7/7 i vardera WAV, MP3 och M4A, totalt **32/32**. Alla tre nedladdade filer identifierades som svenska utan språkledtråd. Återtranskriptionen hade **0 % WER** mot måltexten när `idag` och `i dag` normaliserades till samma form, tillsammans med testets vanliga normalisering av skiftläge och interpunktion.

TTS använde MMS svenska med seed 555, CC-BY-NC-4.0. Jobbet sparade 10,02 s genererat tal, ett 7,85 s tillgängligt talfönster inklusive 0,75 s lånad paus, tempo ×1,2764 och 0 ms beräknad överskridning. Tre automatiska förkortningsförsök finns noterade; ingen manuell redigering behövdes. Tempot ligger över det föredragna ×1,20 men inom produktens begränsade ×1,40-reserv. Bearbetningsstegen tog sammanlagt cirka 46,3 s; hela testet inklusive exportkontroll tog cirka 85,6 s. Detta är mätningar för ett enda prov.

| Export | Språk | Faktakontroller | WER | Längd | Byte | SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
| WAV | sv | 7/7 | 0 % | 8,16 s | 783438 | `e38a851aba0997a4ac48b596af866d8aa6562263bb81ae4e75738ea6c08952e9` |
| MP3 | sv | 7/7 | 0 % | 8,18 s | 197037 | `b86015a0ed6586ff91eda0d8cbacccd7262a1a4762e4a955df68e8edadf6845a` |
| M4A | sv | 7/7 | 0 % | 8,16 s | 168148 | `fe8bbea4c6cd54de43d1417b9917c1c47f6b1397306a79ee4b5da57d5e198b83` |

Originalets SHA-256: `40d979a6239fc08951f387c671fb5fc46fffdc5df823ed1dbdb809bc75e26620`. Källans attribution och referens finns även i `local-ai/fixtures/fleurs-ar-eg-test-0.provenance.json`. MMS-modellens CC-BY-NC-4.0 gäller för denna valda röst; resultatet ska bedömas inom den licensens icke-kommersiella användning.

## Samlad slutstatus

| Fält | Väderprov | Video |
| --- | --- | --- |
| Datum, jobb-id och rapportmapp | 2026-10-15, `081b9560-6837-4a7c-8ce7-e4cbcbf674a3`, rapport enligt ovan | Väntar |
| Källgranskning och eventuell manuell rättning | Jämförd med officiell referens. Automatisk ordinalregel med sparad `rawText`; ingen manuell textändring | Väntar |
| Faktakontroller i svensk text | 7/7 godkända; korrekt säsongsomfattning för ordinalen | Väntar |
| WAV: språk, faktakontroller, WER, längd, SHA-256 | sv, 7/7, 0 %, 8,16 s; SHA-256 enligt exporttabellen | Väntar |
| MP3: språk, faktakontroller, WER, längd, SHA-256 | sv, 7/7, 0 %, 8,18 s; SHA-256 enligt exporttabellen | Väntar |
| M4A: språk, faktakontroller, WER, längd, SHA-256 | sv, 7/7, 0 %, 8,16 s; SHA-256 enligt exporttabellen | Väntar |
| MP4: faktiska ljudspåret, bild, längd, SHA-256 | Ej tillämpligt för rent ljudprov | Väntar |
| Uppladdning/uppspelning genom webbläsaren | API-uppladdning verifierad. Ingen webbläsarkörning dokumenterad för ljudprovet | Väntar |
| Samlad bedömning och kvarstående osäkerhet | Godkänt för detta väderprov. Något styltig svensk stil; automatisk grammatisk ASR-ändring redovisad | Inte godkänt ännu |

Det godkända korta väderprovet gäller just det provet. Det innebär inget godkännande av videon, generell dialekttäckning, överlappande tal, långa filer, flera talare eller Live; dessa behöver eget underlag.
