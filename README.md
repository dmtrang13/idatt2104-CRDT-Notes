# CRDT Notes
CRDT Notes er en liten nettleserbasert teksteditor for konfliktfri replikering mellom flere noder. Løsningen består av en C++20 proof of concept for CRDT-kjernen og en enkel HTML/JavaScript-editor med HTTP/WebSocket-server. Nettleserklientene kan gjøre lokale endringer uavhengig av hverandre og konvergerer automatisk via serverens operasjonslogg.

## GitHub-repository

[dmtrang13/idatt2104-CRDT-Notes](https://github.com/dmtrang13/idatt2104-CRDT-Notes.git)

## Introduksjon

Målet er å vise hvordan enkle Conflict-free Replicated Data Types kan implementeres uten eksterne CRDT-biblioteker.

C++-delen modellerer et delt dokument med:

- `LwwRegister<T>` for last-writer-wins-felter.
- `AwSet<T>` for add-wins observed-remove set.
- `RgaText` for tekstsekvenser der hvert tegn har operasjons-ID, referanse til forrige element og tombstone ved sletting.

Webeditoren bruker samme RGA-idé i JavaScript. Serveren lagrer en append-only operasjonslogg og sender hele loggen til klientene ved tilkobling, etter nye operasjoner og ved periodiske sync-forespørsler.

## Innhold

 [Implementert funksjonalitet](#implementert-funksjonalitet)
- [Avhengigheter](#avhengigheter)
- [Installasjon](#installasjon)
- [Bruk](#bruk)
- [Testing](#testing)
- [Viktige komponenter](#viktige-komponenter)
- [Ekstern informasjon og kode](#ekstern-informasjon-og-kode)
- [Fremtidig arbeid](#fremtidig-arbeid)

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

-- En C++20-kompatibel kompilator:
  - Windows: MSYS2 UCRT64 med GCC.
  - Linux: GCC 10+ eller Clang 12+.
  - macOS: Apple Clang 13+ eller nyere Clang installert via Homebrew.
- CMake 3.20 eller nyere.
- Ninja, brukt av CMake-presetene.
- Node.js 18 eller nyere.
- En moderne nettleser med WebSocket-støtte.

Serveren bruker bare innebygde Node-moduler: `fs`, `path`, `net` og `crypto`.

## Installasjon

Klon eller åpne prosjektmappen og gå til repoet:

```powershell
cd ../idatt2104-CRDT-Notes
```

### Windows med MSYS2 UCRT64

Anbefalt oppsett på denne maskinen er MSYS2 UCRT64-preseten:

```powershell
cmake --preset msys-ucrt
cmake --build --preset msys-ucrt
ctest --test-dir build-ucrt --output-on-failure
```

Preseten bygger i `build-ucrt` og setter `C:\msys64\ucrt64\bin` først i `PATH`. Det unngår DLL-konflikter hvis andre verktøykjeder, for eksempel STM32CubeCLT, ligger tidligere i `PATH`.

### Linux

Installer typiske avhengigheter på Debian/Ubuntu:

```sh
sudo apt update
sudo apt install build-essential cmake ninja-build nodejs npm
```

Bygg og test med Linux-preseten:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build-linux --output-on-failure
```

Hvis distribusjonen din har en gammel Node.js-versjon i pakkebrønnen, installer Node.js 18+ via NodeSource, `nvm`, eller distribusjonens nyere pakkekilde.

### macOS

Installer avhengigheter med Homebrew:

```sh
brew install cmake ninja node
```

Bygg og test med macOS-preseten:

```sh
cmake --preset macos-debug
cmake --build --preset macos-debug
ctest --test-dir build-macos --output-on-failure
```

Apple Clang følger normalt med Xcode Command Line Tools. Installer dem hvis `clang++` mangler:

```sh
xcode-select --install
```

### Direkte kompilering

Direkte kompilering uten CMake fungerer også:

```powershell
g++ -std=c++20 -Wall -Wextra -Wpedantic crdt.cpp -o crdt_notes
```

På macOS kan kommandoen være:

```sh
clang++ -std=c++20 -Wall -Wextra -Wpedantic crdt.cpp -o crdt_notes
```

`msys-ucrt` er verifisert på denne Windows-maskinen. `linux-debug` og `macos-debug` er lagt inn som portable CMake/Ninja-presets for tilsvarende miljøer.

## Bruk

Start webeditoren:

```sh
node server.js
```

Åpne deretter to eller flere faner på:

```text
http://localhost:3000
```

Skriv i en fane og se at de andre fanene mottar CRDT-operasjonene over WebSocket. Sidepanelet viser RGA-operasjonene i kolonneformat.

Den kompilerte C++-delen er ikke en egen editor. Den kan kjøres for å vise kort bruksinfo:

Windows/MSYS2:

```powershell
./build-ucrt/crdt_notes.exe
```

Linux:

```sh
./build-linux/crdt_notes
```

macOS:

```sh
./build-macos/crdt_notes
```

## Testing

Sjekk JavaScript-serveren for syntaksfeil:

```sh
node --check server.js
```

Kjør C++-testene for riktig buildmappe:

```powershell
ctest --test-dir build-ucrt --output-on-failure
```

```sh
ctest --test-dir build-linux --output-on-failure
ctest --test-dir build-macos --output-on-failure
```

Testene bruker `assert` fra standardbiblioteket og feiler dersom CRDT-ene ikke konvergerer.

## Viktige komponenter

C++-kjernen ligger i `crdt.cpp` og består hovedsakelig av:

- `crdt::LamportClock`
- `crdt::LwwRegister<T>`
- `crdt::AwSet<T>`
- `crdt::RgaText`
- `crdt::Replica`

Webeditoren har en liten JavaScript-implementasjon av `RgaText` direkte i `editor.html`, og WebSocket-serveren ligger i `server.js`.

## Ekstern informasjon og kode

Implementasjonen bygger på allment kjente CRDT-prinsipper: Lamport timestamps, last-writer-wins register, observed-remove/add-wins set og RGA-sekvenser. WebSocket-handshake og frame-parsing er skrevet med Node sine standardmoduler etter samme prinsipp som øving 6 i dette prosjektet.

Det brukes ingen eksterne CRDT-biblioteker eller tredjeparts kode i implementasjonen.

## Fremtidig arbeid

- Dele C++-CRDT-kjernen med webserveren, for eksempel via et API eller WebAssembly.
- Persistens av operasjonsloggen til fil eller database. Nå forsvinner webtilstanden når serveren stoppes.
- Bedre Unicode-håndtering. C++-delen bruker fortsatt `char`.
- Komprimering eller garbage collection av tombstones i AWSet og RGA.
- Mer testdekning, inkludert tilfeldige operasjonsrekkefølger og flere replikater.
- Separere bibliotek, demo og tester i egne filer dersom løsningen vokser.