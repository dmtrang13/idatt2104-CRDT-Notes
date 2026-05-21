# CRDT Notes

CRDT Notes is a small browser-based collaborative text editor that demonstrates conflict-free replication between clients. The project is split into a C++ CRDT core, a Node.js HTTP/WebSocket/PostgreSQL backend, and a browser frontend.

## Repository

[dmtrang13/idatt2104-CRDT-Notes](https://github.com/dmtrang13/idatt2104-CRDT-Notes.git)

## Layout

```text
frontend/
  editor.html      # browser shell
  editor.js        # UI and local editor state
  websocket.js     # WebSocket connection, reconnect, sync messages
  styles.css       # editor styling

backend/
  server.js        # HTTP, WebSocket, validation, auth, PostgreSQL
  crdt_bridge.cpp  # placeholder for future C++/WASM/native bridge

cpp/
  crdt.hpp         # CRDT API
  crdt.cpp         # CRDT implementation
  crdt_tests.cpp   # built-in tests
```

## Implemented Functionality

- Lamport clocks and stable operation IDs on the form `counter@replica`.
- Deterministic merge logic for LWW registers, add-wins sets, and RGA text.
- First-class insert and delete operations for RGA text.
- Browser editor with local pending-operation storage, reconnect, and missing-op sync.
- Node backend using `ws` for WebSockets and `pg` for optional PostgreSQL persistence.
- Document separation with `document_id`.
- Optional auth token, per-document tokens, and WebSocket origin allowlist.
- PostgreSQL operation table keyed by `(document_id, id)`.
- Dependency indexes and a snapshot table prepared for later compaction work.
- Docker Compose setup for the backend and PostgreSQL.
- GitHub Actions workflow for C++, Node syntax checking, and Docker Compose validation.

This is still a proof-of-concept, not a production editor. The frontend diff is still O(n^2), C++ text storage is byte-oriented with `char`, snapshots are not yet used, and full production-grade auth/authorization is outside the current scope.

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
npm install
node server.js
```

Open:

```text
http://localhost:3000
```

Open two tabs with the same `document_id` to see operations converge:

```text
http://localhost:3000/?document_id=notes-1
```

If the WebSocket server is not on port `3001`, pass `ws_port`:

```text
http://localhost:3000/?document_id=notes-1&ws_port=3001
```

`ws_port=same` is useful only when HTTP and WebSocket traffic are served through the same host and port, such as behind a reverse proxy.

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

Requests should send the token with `Authorization: Bearer ...` or a `crdt_token` cookie. URL tokens are disabled by default because they can leak through browser history, logs, screenshots, and referrers. They can be enabled for local demos with:

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

JavaScript syntax check:

```sh
cd backend
npm run check
```

C++ tests:

```sh
cd cpp
ctest --test-dir build-ucrt --output-on-failure
```

Use `build-linux` or `build-macos` for the matching preset on those platforms.

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

The frontend has its own JavaScript RGA model for the browser demo. `frontend/editor.js` owns UI state and rendering, while `frontend/websocket.js` owns connection, reconnect, send, and sync behavior.

The backend in `backend/server.js` serves frontend files, validates WebSocket messages, persists operations, performs missing-op sync, and uses PostgreSQL `LISTEN/NOTIFY` so multiple server processes can observe new operations.

`backend/crdt_bridge.cpp` is a placeholder boundary for later connecting the Node backend to the C++ CRDT core through a native addon, child process, or WebAssembly.

## External Code

The implementation uses standard CRDT ideas: Lamport timestamps, last-writer-wins registers, observed-remove/add-wins sets, and RGA sequences. The WebSocket server uses the `ws` package rather than a hand-written frame parser.

No external CRDT library is used.

## Future Work

- Connect the backend directly to the C++ CRDT core through `backend/crdt_bridge.cpp`.
- Replace the O(n^2) frontend LCS diff with incremental edit handling.
- Decide and implement a consistent Unicode policy across C++ and JavaScript.
- Write and use snapshots to avoid full replay forever.
- Add tombstone garbage collection once replicas have acknowledged operations.
- Add richer tests for restart replay, duplicate DB conflicts, two documents, reconnect, invalid operations, and multi-server notification behavior.
