# CRDT Notes

CRDT Notes er en liten nettleserbasert teksteditor for konfliktfri replikering mellom flere noder. Løsningen består av en C++20 proof of concept for CRDT-kjernen og en enkel HTML/JavaScript-editor med HTTP/WebSocket-server. Nettleserklientene kan gjøre lokale endringer uavhengig av hverandre og konvergerer automatisk via serverens operasjonslogg.

Siste CI/CD-kjøring: ikke konfigurert.

## Introduksjon

Målet er å vise hvordan flere enkle Conflict-free Replicated Data Types kan implementeres uten eksterne CRDT-biblioteker. C++-delen modellerer en delt teksteditor med tittel, tags og tekstinnhold:

- `LwwRegister<T>` bruker Lamport-tid og deterministisk tie-break på replikat-ID for sist-skriver-vinner-felter.
- `AwSet<T>` er et add-wins observed-remove set der samtidige `add`-operasjoner vinner over en `remove` som ikke har observert dem.
- `RgaText` er en enkel Replicated Growable Array for tekst, der tegn lagres med operasjons-ID og referanse til forrige element.

Web-delen bruker samme hovedidé for tekstfeltet: hvert tegn er et RGA-element med operasjons-ID, referanse til forrige element og tombstone ved sletting. Serveren lagrer en append-only operasjonslogg og sender hele loggen til klientene ved tilkobling, etter hver ny operasjon og ved periodiske sync-forespørsler.

## Implementert funksjonalitet

- Lamport-klokke og stabile operasjons-ID-er på formen `counter@replica`.
- Deterministisk merge for LWW-register, AWSet og RGA-tekst.
- Nettleserbasert teksteditor i `editor.html`.
- Enkel HTTP-server og WebSocket-server i `server.js`, inspirert av `oeving6.js` i emnet IDATT2104 Nettverksprogrammering.
- WebSocket-synkronisering av RGA-operasjoner mellom flere nettleserfaner.
- Server-side operasjonslogg som holder klientene synket på `localhost`.
- Kolonnevis visning av RGA-operasjoner i webgrensesnittet: `op_id`, `ref_id`, `char` og `removed`.
- Innebygde tester som sjekker konvergens for alle CRDT-typene.
- Kolonnevis eksport av RGA-operasjoner fra C++-kjernen: `op_id`, `ref_id`, `char` og `removed`.

## Fremtidig arbeid

- Dele C++-CRDT-kjernen med webserveren, for eksempel via et eget API eller WebAssembly.
- Bedre konfliktbevaring for store tekstendringer i nettleseren. Nå oversettes `textarea`-diff til tegnoperasjoner.
- Persistens av operasjonsloggen til fil eller database. Nå forsvinner webtilstanden når serveren stoppes.
- Bedre håndtering av Unicode. Nå er `RgaText` tegnbasert med `char`.
- Komprimering/garbage collection av tombstones i `AwSet` og `RgaText`.
- Mer komplett testdekning, inkludert tilfeldige operasjonsrekkefølger og flere replikater.
- Separere bibliotek, demo og tester i egne filer dersom løsningen vokser.

## Eksterne Avhengigheter

- C++20 standardbibliotek: brukes til datastrukturer, sortering, assertions og I/O.
- CMake 3.20 eller nyere: brukes til bygging.
- Node.js: brukes til den enkle HTTP/WebSocket-serveren. Serveren bruker bare innebygde Node-moduler: `fs`, `path`, `net` og `crypto`.
- Nettleser med WebSocket-støtte: brukes til `editor.html`.

Det brukes ingen eksterne CRDT-biblioteker eller tredjeparts kode i implementasjonen.

## Installasjon

Krav:

- MSYS2 UCRT64 med en C++20-kompatibel GCC-kompilator.
- CMake 3.20 eller nyere.
- Node.js 18 eller nyere for webeditoren.

Bygg med CMake-preseten for MSYS2 UCRT64:

```powershell
cd nettverks\CRDT
cmake --preset msys-ucrt
cmake --build --preset msys-ucrt
ctest --test-dir build-ucrt --output-on-failure
```

Preset-en setter `C:\msys64\ucrt64\bin` først i `PATH`. Det er viktig hvis andre verktøykjeder, for eksempel STM32CubeCLT, ligger tidligere i `PATH` og har egne `libstdc++`, `libgcc` eller `libwinpthread` DLL-er.

Alternativt kan filen kompileres direkte med en C++20-kompilator:

```powershell
g++ -std=c++20 -Wall -Wextra -Wpedantic crdt.cpp -o crdt_notes
```

## Bruk

Start webeditoren:

```powershell
cd nettverks\CRDT
node server.js
```

Åpne deretter to eller flere faner på:

```text
http://localhost:3000
```

Skriv i tekstfeltet i en fane og se at de andre fanene mottar CRDT-operasjonene over WebSocket. Sidepanelet viser RGA-operasjonene i kolonneformat.

Den kompilerte C++-delen er ikke en egen editor lenger. Den kan kjøres for å vise hvor webserveren startes:

```powershell
.\build-ucrt\crdt_notes.exe
```

## Tester

Sjekk JavaScript-serveren for syntaksfeil:

```powershell
node --check server.js
```

Kjør de innebygde testene:

```powershell
ctest --test-dir build-ucrt --output-on-failure
```

Testene bruker `assert` fra standardbiblioteket og avslutter med feilkode dersom en CRDT ikke konvergerer.

## API-Dokumentasjon

Det finnes foreløpig ingen generert API-dokumentasjon. De viktigste klassene ligger i `crdt.cpp`:

- `crdt::LamportClock`
- `crdt::LwwRegister<T>`
- `crdt::AwSet<T>`
- `crdt::RgaText`
- `crdt::Replica`

Webeditoren har en liten JavaScript-implementasjon av `RgaText` direkte i `editor.html`, og WebSocket-serveren ligger i `server.js`.

## Bruk Av Ekstern Informasjon/Kode

Implementasjonen bygger på allment kjente CRDT-prinsipper: Lamport timestamps, last-writer-wins register, observed-remove/add-wins set og RGA-sekvenser. WebSocket-handshake og frame-parsing er skrevet med Node sine standardmoduler etter samme prinsipp som øving 6 i dette prosjektet. Ingen ekstern kildekode eller eksterne CRDT-biblioteker er kopiert inn i prosjektet.
