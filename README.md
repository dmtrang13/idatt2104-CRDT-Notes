# CRDT Notes

CRDT Notes er en liten nettleserbasert teksteditor for konfliktfri replikering mellom flere noder. Løsningen består av en C++20 proof of concept for CRDT-kjernen og en enkel HTML/JavaScript-editor med HTTP/WebSocket-server. Nettleserklientene kan gjøre lokale endringer uavhengig av hverandre og konvergerer automatisk via serverens operasjonslogg.

Siste CI/CD-kjøring: ikke konfigurert.

## Introduksjon

Målet er å vise hvordan enkle Conflict-free Replicated Data Types kan implementeres uten eksterne CRDT-biblioteker.

C++-delen modellerer et delt dokument med:

- `LwwRegister<T>` for last-writer-wins-felter.
- `AwSet<T>` for add-wins observed-remove set.
- `RgaText` for tekstsekvenser der hvert tegn har operasjons-ID, referanse til forrige element og tombstone ved sletting.

Webeditoren bruker samme RGA-idé i JavaScript. Serveren lagrer en append-only operasjonslogg og sender hele loggen til klientene ved tilkobling, etter nye operasjoner og ved periodiske sync-forespørsler.

## Innhold

- [Implementert funksjonalitet](#implementert-funksjonalitet)
- [Avhengigheter](#avhengigheter)
- [Installasjon](#installasjon)
- [Bruk](#bruk)
- [Testing](#testing)
- [API-dokumentasjon](#api-dokumentasjon)
- [Fremtidig arbeid](#fremtidig-arbeid)
- [Ekstern informasjon og kode](#ekstern-informasjon-og-kode)

## Implementert funksjonalitet

- Lamport-klokke og stabile operasjons-ID-er på formen `counter@replica`.
- Deterministisk merge for LWW-register, AWSet og RGA-tekst.
- Nettleserbasert teksteditor i `editor.html`.
- Enkel HTTP-server og WebSocket-server i `server.js`, inspirert av `oeving6.js` i IDATT2104.
- Automatisk WebSocket-synkronisering av RGA-operasjoner mellom flere faner.
- Server-side operasjonslogg som holder klientene synket på `localhost`.
- LCS-basert tekst-diff i webeditoren, slik at cut/paste og flytting av tekst bevarer forventet rekkefølge.
- Kolonnevis visning av RGA-operasjoner i webgrensesnittet: `op_id`, `ref_id`, `char` og `removed`.
- Innebygde C++-tester for konvergens.

## Avhengigheter

- MSYS2 UCRT64 med GCC som støtter C++20.
- CMake 3.20 eller nyere.
- Ninja, brukt av CMake-preseten.
- Node.js 18 eller nyere.
- En moderne nettleser med WebSocket-støtte.

Serveren bruker bare innebygde Node-moduler: `fs`, `path`, `net` og `crypto`.

## Installasjon

Anbefalt oppsett på denne maskinen er MSYS2 UCRT64-preseten:

```powershell
cd nettverks\CRDT\idatt2104-CRDT
cmake --preset msys-ucrt
cmake --build --preset msys-ucrt
ctest --test-dir build-ucrt --output-on-failure
```

Preseten bygger i `build-ucrt` og setter `C:\msys64\ucrt64\bin` først i `PATH`. Det unngår DLL-konflikter hvis andre verktøykjeder, for eksempel STM32CubeCLT, ligger tidligere i `PATH`.

Direkte kompilering uten CMake:

```powershell
g++ -std=c++20 -Wall -Wextra -Wpedantic crdt.cpp -o crdt_notes
```

`CMakePresets.json` inneholder også presets for andre miljøer, men `msys-ucrt` er den anbefalte og verifiserte flyten for dette prosjektet.

## Bruk

Start webeditoren:

```powershell
cd nettverks\CRDT\idatt2104-CRDT
node server.js
```

Åpne deretter to eller flere faner på:

```text
http://localhost:3000
```

Skriv i en fane og se at de andre fanene mottar CRDT-operasjonene over WebSocket. Sidepanelet viser RGA-operasjonene i kolonneformat.

Den kompilerte C++-delen er ikke en egen editor. Den kan kjøres for å vise kort bruksinfo:

```powershell
.\build-ucrt\crdt_notes.exe
```

## Testing

Sjekk JavaScript-serveren for syntaksfeil:

```powershell
node --check server.js
```

Kjør C++-testene:

```powershell
ctest --test-dir build-ucrt --output-on-failure
```

Testene bruker `assert` fra standardbiblioteket og feiler dersom CRDT-ene ikke konvergerer.

## API-dokumentasjon

Det finnes foreløpig ingen generert API-dokumentasjon. De viktigste klassene ligger i `crdt.cpp`:

- `crdt::LamportClock`
- `crdt::LwwRegister<T>`
- `crdt::AwSet<T>`
- `crdt::RgaText`
- `crdt::Replica`

Webeditoren har en liten JavaScript-implementasjon av `RgaText` direkte i `editor.html`, og WebSocket-serveren ligger i `server.js`.

## Fremtidig arbeid

- Dele C++-CRDT-kjernen med webserveren, for eksempel via et API eller WebAssembly.
- Persistens av operasjonsloggen til fil eller database. Nå forsvinner webtilstanden når serveren stoppes.
- Bedre Unicode-håndtering. C++-delen bruker fortsatt `char`.
- Komprimering eller garbage collection av tombstones i AWSet og RGA.
- Mer testdekning, inkludert tilfeldige operasjonsrekkefølger og flere replikater.
- Separere bibliotek, demo og tester i egne filer dersom løsningen vokser.

## Ekstern informasjon og kode

Implementasjonen bygger på allment kjente CRDT-prinsipper: Lamport timestamps, last-writer-wins register, observed-remove/add-wins set og RGA-sekvenser. WebSocket-handshake og frame-parsing er skrevet med Node sine standardmoduler etter samme prinsipp som øving 6 i dette prosjektet.

Det brukes ingen eksterne CRDT-biblioteker eller kopiert tredjepartskode.
