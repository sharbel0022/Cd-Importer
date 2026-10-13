# CD Importer Studio

Öppna `/studio/index.html` via **CD Importer Studio** i menyn efter `npm run dev`. Sidan levereras från `public/studio` i både Next.js och det befintliga Sites-bygget. Ingen ny serverintegration eller separat driftsättning behövs.

Den nya sidan är en webbprototyp, inte den fullständiga AI-produkten. Den befintliga musikappen fungerar fortsatt som tidigare.

## Fungerar nu

- Import och uppspelning av ljud samt videoförhandsvisning när webbläsaren stöder kodeken.
- Ljudvåg, urval, klippning, trimning, ångra/gör om, jämförelse med originalet.
- Volym, hastighet, enkel brusgrind, tonhöjd och WAV-export. Tonhöjd påverkar även längden.
- Lokal autokorrelationsanalys för enkla monofoniska melodier, inte en tränad AI-modell. Toner och rytm måste kontrolleras manuellt.
- Notredigering, tempo, taktart, transponering och syntetisk notuppspelning; MIDI, MusicXML och PDF via utskrift.
- Manuella undertexter med tidsstämplar och talarbeteckningar; SRT-import och export.
- Projektfiler med inbäddade original- och bearbetade ljud, noter och textsegment.

## Återstående

AI-transkribering, översättning, talaridentifiering, dubbning, polyfonisk notanalys och sångseparation kräver serverintegration. AI-panelen visar att tjänsten inte är ansluten och skickar inga mediefiler.

CD-läsning behöver en native integration. Videorendering, sammanfogning av spår och oberoende tidssträckning behöver en mediemotor. Studion exporterar WAV; befintliga appens MP3-konvertering kan användas separat. Videoklippning är blockerad med en förklaring.

Originalfiler skrivs inte över. Importgränsen är 120 MB och projektfilsgränsen 180 MB. Allt avkodas i arbetsminnet; strömning och jobbhantering för långa filer återstår. Projektfiler innehåller videons ljud men inte videobilden. Spara via projekthämtning innan du stänger. Typsnitt hämtas från Google Fonts.

## Verifiering

`node scripts/studio-check.cjs` verifierar ljudklippning, trimning, bevarat original, ångra/gör om, WAV-format, MIDI-format, MusicXML och SRT-tider i en isolerad miljö. Kontrollen ersätter inte browser- och ljudtestning.
