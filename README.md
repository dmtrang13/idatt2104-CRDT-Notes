# CRDT Notes

CRDT Notes is a small browser-based collaborative text editor that demonstrates conflict-free replication between clients. The project is split into a C++ CRDT core, a Node.js HTTP/WebSocket/PostgreSQL backend, and a browser frontend.

## Contributors 
- Raghd Said Mahmoud Madhun ([@Raghdm24](https://github.com/Raghdm24))
- Trang Minh Duong ([@dmtrang13](https://github.com/dmtrang13))

## Github Repository

[dmtrang13/idatt2104-CRDT-Notes](https://github.com/dmtrang13/idatt2104-CRDT-Notes.git)

## Table of Contents
- [Contributors](#contributors)
- [Table of Contents](#table-of-contents)
- [Project Structure](#project-structure)
- [Implemented Functionality](#implemented-functionality)
- [Dependencies](#dependencies)
- [Build And Test C++](#build-and-test-c)
  - [Windows With MSYS2 UCRT64](#windows-with-msys2-ucrt64)
  - [Linux](#linux)
  - [macOS](#macos)
  - [Direct Compile](#direct-compile)
- [Run locally](#run-locally)
- [Build The WASM Wrapper](#build-the-wasm-wrapper)
- [PostgreSQL](#postgresql)
- [Auth And Limits](#auth-and-limits)
- [Docker](#docker)
- [Testing](#testing)
- [Important Components](#important-components)
- [External Code](#external-code)
- [Future Improvements](#future-improvements)

## Project structure

```text
backend/
  server.js        # HTTP, WebSocket, validation, auth, PostgreSQL
  test/            # Node backend tests

cpp/
  crdt.hpp         # CRDT API
  crdt.cpp         # CRDT implementation
  crdt_wasm.cpp    # Emscripten wrapper for browser use
  crdt_tests.cpp   # built-in tests

database/
  schema.sql       # Database schema queries

frontend/
  views/           # login, home, and editor HTML pages
  stores/          # login, home, editor, and WebSocket browser scripts
  test/            # Node-based frontend tests
  styles.css       # shared styling
  crdt_wasm.*      # optional generated WASM artifacts
```

## Implemented Functionality

- Lamport clocks and stable operation IDs on the form `counter@replica`.
- Deterministic merge logic for LWW registers, add-wins sets, and RGA text.
- First-class insert and delete operations for RGA text.
- Browser editor with local pending-operation storage, reconnect, and missing-op sync.
- Login page, document home page, document creation, and invite-link sharing.
- Node backend using `ws` for WebSockets and `pg` for optional PostgreSQL persistence.
- Optional Emscripten/WASM wrapper for using the C++ RGA from the browser.
- Document separation with `document_id`.
- Hybrid auth: workspace token for all documents, per-document tokens for shared-note invites, and WebSocket origin allowlist.
- PostgreSQL operation table keyed by `(document_id, id)`.
- Dependency indexes and a snapshot table prepared for later compaction work.
- Docker Compose setup for the backend and PostgreSQL.
- GitHub Actions workflow for C++, backend/frontend Node tests, and Docker Compose validation.

This is still a proof-of-concept, not a production editor. The frontend diff is still O(n^2), snapshots are not yet used, and full production-grade auth/authorization is outside the current scope.

## Dependencies

- C++20 compiler.
- CMake 3.20 or newer.
- Ninja.
- Node.js 18 or newer.
- PostgreSQL, if operation persistence is enabled.
- Docker and Docker Compose, if running the containerized setup.
- A modern browser with WebSocket support.

## Build And Test C++

Run CMake from the `cpp` directory.

### Windows With MSYS2 UCRT64

```powershell
cd cpp
cmake --preset msys-ucrt
cmake --build --preset msys-ucrt
ctest --test-dir build-ucrt --output-on-failure
```

### Linux

```sh
cd cpp
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build-linux --output-on-failure
```

### macOS

```sh
cd cpp
cmake --preset macos-debug
cmake --build --preset macos-debug
ctest --test-dir build-macos --output-on-failure
```

### Direct Compile

```sh
cd cpp
g++ -std=c++20 -Wall -Wextra -Wpedantic crdt.cpp crdt_tests.cpp -o crdt_notes
```

## Run Locally

Install backend dependencies and start the server:

```sh
cd backend
npm ci
node server.js
```

Open:

```text
http://localhost:3000
```

The root page redirects to login or home:

```text
/ -> /login.html -> /home.html -> /editor.html?document_id=...
```

Use the workspace token (`AUTH_TOKEN`) to see all documents and create new ones. Use a document token to open only the shared document attached to that token. Share buttons on the home page copy invite links on the form:

```text
http://localhost:3000/login.html?token=...
```

Open two browser tabs for the same document from the home page to see operations converge. If the WebSocket server is not on port `3001`, pass `ws_port` on the editor URL:

```text
http://localhost:3000/editor.html?document_id=notes-1&ws_port=3001
```

`ws_port=same` is useful only when HTTP and WebSocket traffic are served through the same host and port, such as behind a reverse proxy.

## Build The WASM Wrapper

The browser can optionally use the C++ RGA implementation through Emscripten. Install and activate Emscripten first, then run:

```sh
cd backend
npm run build:wasm
```

This generates ignored build artifacts:

```text
frontend/crdt_wasm.js
frontend/crdt_wasm.wasm
```

The editor loads `/crdt_wasm.js` before `editor.js`. If the WASM files are missing, the browser falls back to the JavaScript RGA implementation. If they exist, `editor.js` applies operations to the WASM `WasmDocument` for text rendering and columnar encoding while still using JavaScript for UI, diffing, WebSocket sync, and visible-ID lookup.

## PostgreSQL

Without `DATABASE_URL`, the backend keeps operations in memory. To persist operations:

```sh
cd backend
psql "$DATABASE_URL" -f ../database/schema.sql
DATABASE_URL="postgres://user:password@localhost:5432/crdt_notes" node server.js
```

The database stores operations with `document_id`, operation type, references, payload, and insertion time. `created_at` is database arrival time, not CRDT causal time; the CRDT logic must still treat operations as an unordered set.

## Auth And Limits

The backend can run open for local demos. For protected mode, set either `AUTH_TOKEN` or `DOCUMENT_TOKENS`.

```sh
AUTH_TOKEN="shared-secret" node server.js
```

Requests should send the token with `Authorization: Bearer ...` or a `crdt_token` cookie. The browser login page sets the `crdt_token` cookie through `POST /session`.

`AUTH_TOKEN` is the workspace token. It can open every document, create new documents, and copy invite links for documents that have document tokens configured.

`DOCUMENT_TOKENS` are per-note invite tokens. A user logged in with a document token sees only the document(s) that token can open and cannot create new documents. Share links use `/login.html?token=...` so recipients do not need to paste the token manually.

URL tokens for direct WebSocket auth are disabled by default because they can leak through browser history, logs, screenshots, and referrers. They can be enabled for local demos with:

```sh
ALLOW_URL_TOKENS=true
```

Per-document tokens:

```sh
DOCUMENT_TOKENS='{"notes-1":"secret-a","notes-2":"secret-b"}' node server.js
```

Allowed WebSocket origins:

```sh
ALLOWED_ORIGINS="http://localhost:3000,http://127.0.0.1:3000" node server.js
```

Useful environment variables are documented in `.env.example`.

## Docker

Copy the example environment file and adjust it locally:

```sh
cp .env.example .env
```

Start the backend and PostgreSQL:

```sh
docker compose up --build
```

Services:

- PostgreSQL on `localhost:5432`.
- HTTP editor on `http://localhost:3000`.
- WebSocket server on `ws://localhost:3001`.

Reset the database volume:

```sh
docker compose down -v
docker compose up --build
```

## Testing

Backend and frontend tests:

```sh
cd backend
npm test
```

Only backend tests:

```sh
cd backend
npm run test:backend
```

Only frontend tests:

```sh
cd backend
npm run test:frontend
```

JavaScript syntax checks:

```sh
cd backend
npm run check
cd ..
node --check frontend/stores/home.js
node --check frontend/stores/login.js
node --check frontend/stores/editor.js
node --check frontend/stores/websocket.js
```

C++ tests after building:

```sh
cd cpp
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build-linux --output-on-failure
```

On Windows with the existing UCRT build directory:

```powershell
cd cpp
cmake --build build-ucrt
ctest --test-dir build-ucrt --output-on-failure
```

Use `build-macos` for the macOS preset.

Docker Compose validation:

```sh
docker compose config
```

## Important Components

The C++ core in `cpp/crdt.hpp` and `cpp/crdt.cpp` contains:

- `LamportClock`, which creates monotone operation IDs.
- `LwwRegister<T>`, where the newest operation wins.
- `AwSet<T>`, an add-wins observed-remove set.
- `RgaText`, a replicated growable array for text with inserts, deletes, and tombstones.
- `Replica`, which combines the CRDT structures into one document replica.

The frontend has its own JavaScript RGA model for the browser demo. `frontend/stores/editor.js` owns UI state and rendering, while `frontend/stores/websocket.js` owns connection, reconnect, send, and sync behavior. `frontend/stores/login.js` and `frontend/stores/home.js` handle session login, invite links, document listing, and document creation.

The backend in `backend/server.js` serves frontend files from `frontend/views` and `frontend/stores`, validates HTTP/WebSocket auth, validates WebSocket messages, persists operations, performs missing-op sync, and uses PostgreSQL `LISTEN/NOTIFY` so multiple server processes can observe new operations.

`cpp/crdt_wasm.cpp` exposes `WasmDocument` with `insertAfter`, `erase`, `eraseWith`, `text`, and `columns` for Emscripten builds.

## External Code

The implementation uses standard CRDT ideas: Lamport timestamps, last-writer-wins registers, observed-remove/add-wins sets, and RGA sequences. The WebSocket server uses the `ws` package rather than a hand-written frame parser.

No external CRDT library is used.

## Future Improvement

- Replace the O(n^2) frontend LCS diff with incremental edit handling.
- Finish moving frontend RGA storage and visible-order lookup into WASM.
- Write and use snapshots to avoid full replay forever.
- Add tombstone garbage collection once replicas have acknowledged operations.
- Add richer tests for restart replay, duplicate DB conflicts, reconnect, invalid operations, and multi-server notification behavior.
