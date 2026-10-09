# TON · Music Downloader / Cd-Importer

En svensk, responsiv musikapp med Next.js App Router, TypeScript, Tailwind CSS och Node.js. Sök verkliga ljudfiler från officiella musikkällor, lyssna när en stödd licens finns, hämta riktiga MP3-filer, konvertera egna ljudfiler och spela in mikrofon- eller datorljud.

## Använd via Sites

Site-adress: [TON på Sites](https://ton-cd-importer.asdasdsa213.chatgpt.site). Åtkomst styrs av delningsinställningarna i Sites. Ingen lokal Node-server behöver köras för att använda den publicerade versionen.

Sites-versionen använder samma svenska gränssnitt, officiella källor och licenspolicy. Den kör sökning, färsk rättighetskontroll och ljudhämtning i en Cloudflare Worker. FFmpeg WebAssembly körs i webbläsaren för inspelningar, egna filer och källformat som licensen tillåter att konvertera. Egna ljud laddas inte upp till Sites. FFmpeg hämtas från samma Site första gången du konverterar; räkna med omkring 31 MB extra hämtning och längre bearbetning på telefoner. Verktyget är enkeltrådat och kräver inte SharedArrayBuffer.

Sites-gränser: egna filer/inspelningar högst **25 MB**, externa ljudfiler högst **20 MB**, ZIP högst 10 spår och 100 MB totalt. Större filer kan bearbetas i Windows-versionen. Slutför en konvertering innan du startar en annan. Sparade inspelningar finns i webbläsarens IndexedDB för Site-adressen; inspelningar från localhost flyttas inte automatiskt till denna adress. Ladda ner filer du vill säkerhetskopiera.

Sites-bygget ligger i samma `Cd-Importer`-repository, med hostingidentitet i `.openai/hosting.json`. Den lokala Next.js-versionen använder fortfarande native FFmpeg. Sites har ett separat byggmål som återanvänder React-komponenterna och de gemensamma licens- och källmodulerna.

Testa Sites-versionen lokalt:

```powershell
npm.cmd ci
npm.cmd run build:sites
npm.cmd run dev:sites
# Öppna http://127.0.0.1:3003
```

I en annan PowerShell-terminal i projektmappen:

```powershell
$env:LIVE_TEST_ORIGIN = "http://127.0.0.1:3003"
npm.cmd run test:ui
npm.cmd run test:recording
npm.cmd run test:computer-recording
npm.cmd run test:sites
Remove-Item Env:LIVE_TEST_ORIGIN
```

`test:sites` verifierar WebAssembly-konvertering av FLAC, M4A, MP3 och OGG samt verklig Commons-nedladdning och ZIP med källa/licens. `test:computer-recording` använder syntetisk skärm/ljud och testar ljud utan video, sparad MP3, avbruten delning, saknat ljud och städning. Testet kommer aldrig åt datorns riktiga skärm eller mikrofon. `.openai/hosting.json` innehåller ingen nyckel eller Git-token. Publicering sker via Sites-verktygens verifierade källcommit och byggarkiv.

## Starta på Windows med PowerShell

Installera **Node.js 22.16 eller senare LTS**, Git och valfritt VS Code. FFmpeg för din plattform hämtas automatiskt av `ffmpeg-static` vid paketinstallationen. Ett separat FFmpeg kan användas via `FFMPEG_PATH`.

```powershell
git clone https://github.com/sharbel0022/Cd-Importer.git
Set-Location .\Cd-Importer
npm.cmd ci
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm.cmd run dev
```

Öppna [http://127.0.0.1:3000](http://127.0.0.1:3000). Om repositoryt redan är klonat, gå till dess mapp och kör de sista tre kommandona. `npm.cmd` fungerar även när PowerShell blockerar `npm.ps1`.

Bygg och kör produktionsversionen:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd start
```

Porten 3000 används som standard. Alternativ utvecklingsport:

```powershell
npm.cmd run dev -- --port 3001
```

Projektet körs på loopback som standard. För test på en telefon i **ditt betrodda lokala nätverk**:

```powershell
npm.cmd run dev -- --hostname 0.0.0.0
ipconfig
```

Öppna `http://<datorns lokala IPv4-adress>:3000` på samma Wi-Fi. Tillåt vid behov Node.js på privata nätverk i Windows-brandväggen. Det finns ingen användarinloggning: publicera inte denna lokala konverteringsserver direkt på internet.

**Mikrofon på telefon:** inspelning kräver HTTPS när telefonen ansluter till datorn. En vanlig HTTP-adress i det lokala nätverket fungerar för appens övriga funktioner men får inte mikrofonåtkomst. På datorn fungerar `http://127.0.0.1:3000` och `http://localhost:3000`. Läs mer om [webbläsarens krav för mikrofonåtkomst](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

## Använd appen

- **Sök musik:** skriv låt, artist eller båda. Välj Internet Archive, Wikimedia Commons eller båda. Filtret för tillåten MP3 visar endast filer som appen kan hämta enligt sin licenspolicy.
- **Lyssna:** öppna en licensierad låt i spelaren. Den har play/pause, tidslinje, tider, volym, föregående/nästa och automatisk fortsättning. Webbläsaren avgör vilka ursprungsformat den kan spela; MP3-konverteringen fungerar oberoende av detta.
- **Låtinformation:** visa format, längd om källan anger den, licens, erkännande, rättighetsvillkor och originalkälla. Saknat omslag får en neutral musikikon.
- **Nedladdningslista:** lägg till eller ta bort låtar, se vilka som är tillåtna och exportera högst 10 per ZIP. ZIP innehåller MP3-filer, `LICENSER.json` med källor/villkor och `FEL.json` med misslyckade filer. Appen visar också misslyckade filer separat.
- **Konvertera egna filer:** välj ljudfil, bekräfta att du har rätt att konvertera och välj 128, 192, 256 eller 320 kbps. M4A konverteras till riktig MP3. En befintlig MP3 kodas också om med vald kvalitet; filändelsen byts inte bara ut. WAV, FLAC, OGG, AAC och AIFF stöds också. Högre kvalitet återskapar inte information som saknas i originalet.
- **Spela in ljud:** välj **Mikrofon** för röst och bakgrundsljud eller **Datorljud** för ljud från en delad flik/skärm. Välj **Starta inspelning** och ge tillstånd. I datorläget väljer du en flik med **Dela flikens ljud**, eller hela skärmen med systemljud om alternativet finns. Chrome/Edge på Windows rekommenderas; ett vanligt programfönster kan sakna ljuddelning. Ingen video sparas och datorläget öppnar inte mikrofonen. Saknas ljuddelning visas ett fel. Mobilwebbläsare kan sakna datorläget; mikrofon och filkonvertering fungerar där med HTTPS. Läs [webbläsarens dokumentation om ljud- och skärmdelning](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).
- **Spara inspelningen:** välj **Stoppa inspelning**, lyssna, ange ett namn och välj 128, 192, 256 eller 320 kbps. Bekräfta dina rättigheter och välj **Spara som MP3**. FFmpeg skapar en riktig MP3 under **Sparade inspelningar** med uppspelning, **Ladda ner MP3** och radering. Alla mikrofon-/delningsspår stängs efter inspelning, fel eller stängd vy. Webbläsarens **Sluta dela** avslutar också inspelningen och behåller ljudet fram till avbrottet. Högst 10 minuter och uppladdningsgränsen gäller per inspelning. Öppna Site-adressen direkt om en inbäddad webbläsare blockerar skärmdelning.
- **CD-import:** exportera spåren från en CD du har rätt att kopiera med ditt vanliga CD-program, exempelvis som WAV, och konvertera filerna i appen. Webbläsaren kan inte läsa en fysisk ljud-CD eller `.cda`-genvägar direkt. Appen har ingen funktion som kringgår kopieringsskydd.
- **Originalkälla:** länken finns alltid i informationen och visas vid hämtningsproblem. Du kan där läsa villkor och använda källans egna alternativ.

Sökresultaten är verkliga. Det finns inga demospår, fördefinierade nedladdningslänkar eller kommersiella streamingkopplingar. Att en populär låt saknas är normalt: källorna är arkiv med öppet eller uttryckligen licensierat innehåll.

## Musikkällor och rättigheter

**Internet Archive** använder [officiell avancerad sökning](https://archive.org/advancedsearch.php) och [metadata-API](https://archive.org/developers/md-read.html). Album kan innehålla flera spår. Appen föredrar en befintlig MP3-variant per inspelning. Sökningen pagineras per arkivobjekt, inte per spår; högst 50 spår per objekt visas med en varning och länk till originalet när fler finns.

**Wikimedia Commons** använder [MediaWiki imageinfo](https://www.mediawiki.org/wiki/API:Imageinfo) med [CommonsMetadata](https://www.mediawiki.org/wiki/Extension:CommonsMetadata). Endast verkliga ljudfiler från `upload.wikimedia.org` med kontrollerbar licensinformation får hämtas. Kända officiella UTM-spårningsparametrar tas bort.

Båda dessa läs-API:er kräver **varken registrering eller API-nyckel** för denna användning. En identifierande User-Agent följer med serveranrop; anpassa `MUSIC_USER_AGENT` för din installation och följ [Wikimedias User-Agent-policy](https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy) och respektive leverantörs villkor.

Appens försiktiga licenspolicy:

- En exakt stödd Creative Commons-licens-URL krävs. CC BY, BY-SA, BY-NC, BY-NC-SA, BY-ND och BY-NC-ND i stödda generiska versioner 1.0–4.0, samt CC0 1.0 och Public Domain Mark 1.0 stöds.
- NC-villkor visas som icke-kommersiell användning. Erkännande och eventuell delning under samma licens måste behållas vid vidare användning.
- ND-filer får endast hämtas som redan befintliga MP3-filer. Appen konverterar inte dessa.
- Saknad, okänd eller ej stödd licens blockerar uppspelning och appens nedladdning. Tillgänglighet i ett arkiv räcker inte.
- Källans begränsningar, mörklagda objekt, privata/dolda filer och ytterligare Commons-begränsningar åsidosätter tillåtande licenser.
- Servern hämtar aktuella metadata igen vid varje uppspelning/nedladdning. Klientens lagrade uppgifter eller tillåtelseflaggor används aldrig som bevis.

Rättighetsuppgifter kommer från källan/uppladdaren och kan vara felaktiga. Appen kan kontrollera publicerade uppgifter men kan inte bevisa att uppladdaren äger rättigheterna. Läs originalkällans villkor inför vidare användning, särskilt för public domain i olika länder. Licenser som inte stöds kan vara giltiga; de kräver granskning på originalkällan. Det finns inget DRM-kringgående, ingen YouTube-rippning och ingen Spotify-nedladdning.

## Konfiguration

Kopiera `.env.example` till `.env.local`. Ingen hemlighet skickas till klienten.

| Variabel | Standard | Betydelse |
| --- | --- | --- |
| `MUSIC_USER_AGENT` | Namn + repositoryts kontakt-URL | Identifierar servern hos källorna |
| `FFMPEG_PATH` | Tom, använder `ffmpeg-static` | Alternativ absolut sökväg till `ffmpeg.exe` |
| `MAX_UPLOAD_MB` | 100 | Högst 100 MB per egen uppladdning |
| `MAX_REMOTE_MB` | 50 | Högst 100 MB, standard 50 MB per hämtad ljudfil |

ZIP begränsas till 100 MB ljud totalt och 10 filer. Konverteringsutdata begränsas till 100 MB. Högst två konverteringar körs samtidigt och FFmpeg stoppas efter två minuter. Tillfälliga in- och utdata skapas i operativsystemets tempmapp och raderas i `finally` efter bearbetning, även vid fel. Ett abrupt avslut av operativsystemet/processen kan lämna tempfiler med prefixet `music-downloader-`; de kan då tas bort när appen är stoppad.

Om automatisk FFmpeg-installation misslyckas, installera FFmpeg från en betrodd distributör, lägg dess `bin` i PATH och ange dess absoluta sökväg i `.env.local`:

```powershell
# Efter separat installation och en ny terminal:
(Get-Command ffmpeg).Source
# Skriv den visade absoluta sökvägen som FFMPEG_PATH i .env.local.
ffmpeg -version
```

Starta om appen efter ändringar i `.env.local`. Statusen i konverteringsvyn visar om FFmpeg kan startas. Vid pakethanterarproblem kan `npm.cmd ci` köras igen. `.npmrc` använder `legacy-peer-deps` för att undvika ett peer-resolverfel i npm 11.4; låsfilen innehåller den verifierade installationen.

## Säkerhet och begränsningar

- API:erna tar endast källidentifierare och exakta filnamn; användaren kan inte ange en hämt-URL.
- HTTPS till fasta officiella API:er, storleksgränser, timeout och tydliga svenska fel. Partialfel från en källa visas utan att dölja fungerande resultat.
- För ljud är värdarna explicit tillåtna. Varje omdirigering kontrolleras, DNS-adresser måste vara publika och anslutningen låses till den verifierade adressen. Privata/lokala IP-adresser, credentials, andra portar och osäkra sökvägar nekas.
- MP3-data verifieras med riktiga MPEG Layer III-ramar. Att byta filändelse räknas aldrig som konvertering. Icke-MP3 avkodas/kodas med FFmpeg när licensen tillåter.
- FFmpeg får ingen nätverksåtkomst, tvingas till ljudfilens demuxer och startas med argumentlista utan shell. Storleksgränser gäller den verkliga strömmade uppladdningen.
- Mutationer från en annan webbplats avvisas. Anropsgränser gäller per serverprocess: 30 sökningar, 120 ljudanrop, 20 hämtningar, 6 ZIP-exporter och 8 konverteringar per minut.
- Kön sparas bara i den aktuella webbläsaren. Uppladdade originalfiler och serverns temporära konverteringsfiler raderas efter bearbetning. Mikrofonljudet skickas till appens server först när du väljer att spara som MP3.
- Sparade MP3-inspelningar finns i webbläsarens IndexedDB på den aktuella adressen, högst 20 inspelningar och 100 MB totalt. De överlever omladdning men är ingen säkerhetskopia: privat läge, rensad webbplatsdata eller byte av webbläsare/adress kan göra dem otillgängliga. Ladda ner filer du vill behålla. Vid lagringsfel visas en direkt MP3-länk utan att filen påstås vara sparad.
- Ingen databas eller extern nyckeltjänst behövs. `.env`, beroenden, byggen, ljudfiler och tempmappar ignoreras av Git.

För en publik fleranvändartjänst behövs autentisering, separata användarkvoter, strömmande köhantering och distribuerade anropsgränser. Den här versionen är avsedd för lokal användning på Windows; Node.js och FFmpeg krävs för serverfunktionerna. En statisk export eller Edge-runtime kan inte köra konverteringen.

## Projektstruktur

```text
src/app/                 App Router, layout och svensk startsida
src/app/api/search/      Sökning med validerade parametrar
src/app/api/audio/       Licenskontrollerad ljudproxy med Range
src/app/api/download/    Verifierad MP3 eller riktig konvertering
src/app/api/batch/       ZIP, källor/licenser och separata fel
src/app/api/convert/     Begränsad uppladdning och FFmpeg
src/app/api/status/      FFmpeg-status och konfigurerade gränser
src/app/api/license/     Färsk licensinformation som separat JSON-fil
src/components/          Sökvy, låtkort, information och spelare
src/components/recorder.tsx Mikrofon/datorljud, förhandslyssning och inspelningslista
src/lib/recordings-store.ts Lokal MP3-lagring i IndexedDB
src/lib/recording-format.ts Formatval och inspelningsfel
src/lib/catalog.ts       Officiella källor och färsk metadata
src/lib/licenses.ts      Licensklassificering och restriktioner
src/lib/provider-http.ts Begränsad API-klient
src/lib/safe-download.ts HTTPS, redirect- och DNS-skydd
src/lib/media.ts          MP3-verifiering, filnamn och provenance
src/lib/ffmpeg.ts         Konvertering och tempstädning
src/lib/request.ts        Indata, kroppsstorlek och anropsgränser
tests/                   Licens-, käll-, fil- och säkerhetstester
scripts/live-check.ts    Verkligt API-/fil-/konverteringstest
scripts/ui-check.mjs     Webbläsartest och skärmbilder på flera skärmbredder
scripts/recording-check.mjs Inspelning, MP3 och lagring med simulerad mikrofon
```

## Verifiering

`npm.cmd test` kör deterministiska tester. Testfixturer används endast i tester, aldrig i appen. `npm.cmd run typecheck` och `npm.cmd run build` verifierar samtliga server- och klientdelar.

Med appen igång i en separat terminal kan verkliga API:er, MP3-avkodning, uppspelningens Range-anrop, konvertering och ZIP testas:

```powershell
npm.cmd run test:live
```

Testet behöver internet och FFmpeg och kan misslyckas när en musikkälla begränsar anrop eller tar bort en fil. Det hittar sina nedladdningsfiler via riktig sökning. Externa källfel ska alltid skiljas från godkända lokala kodtester.

Ett separat webbläsartest kontrollerar verklig sökning, uppspelning, nedladdning, konvertering, listans sparande och skärmbredder 1440, 768, 390 och 360 pixlar. Appen ska vara igång. Skärmbilder sparas i den ignorerade mappen `test-results`.

```powershell
npx.cmd playwright install chromium
npm.cmd run test:ui
```

Inspelningsflödet har ett separat test med Chromiums simulerade mikrofon; testet använder inte datorns fysiska mikrofon. Det spelar in, stoppar, konverterar med FFmpeg, avkodar MP3-filen, kontrollerar sparande efter omladdning och testar mikrofonfel på dator- och mobilbredd:

```powershell
# Appen ska vara igång på port 3000 i en annan terminal.
$env:LIVE_TEST_ORIGIN = "http://127.0.0.1:3000"
npm.cmd run test:recording
npm.cmd run test:computer-recording
Remove-Item Env:LIVE_TEST_ORIGIN
```

Beroenden och FFmpeg har egna licenser; se respektive paket och `node_modules/ffmpeg-static/LICENSE`. Nedladdad musiks licens följer inte automatiskt av projektets programkod.
