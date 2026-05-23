const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocket, WebSocketServer } = require("ws");

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const WS_PORT = Number(process.env.WS_PORT || 3001);
const HOST = process.env.HOST;
const DEFAULT_DOCUMENT_ID = "default";
const MAX_MESSAGE_BYTES = Number(process.env.MAX_MESSAGE_BYTES || 256 * 1024);
const MAX_OP_VALUE_CHARS = Number(process.env.MAX_OP_VALUE_CHARS || 1);
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const ALLOW_URL_TOKENS = process.env.ALLOW_URL_TOKENS === "true";
const REQUIRE_AUTH =
  process.env.REQUIRE_AUTH === "true" || process.env.NODE_ENV === "production";
const SERVER_INSTANCE_ID = crypto.randomUUID();

const clients = new Set();
const documents = new Map();
let pgClient = null;

function isValidDocumentId(documentId) {
  return (
    typeof documentId === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(documentId)
  );
}

function parseDocumentTokens(raw) {
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw);
    return new Map(
      Object.entries(parsed).filter(
        ([documentId, token]) =>
          isValidDocumentId(documentId) && typeof token === "string" && token
      )
    );
  } catch {
    return new Map(
      raw
        .split(",")
        .map((entry) => entry.split("="))
        .filter(
          ([documentId, token]) =>
            isValidDocumentId(documentId) && typeof token === "string" && token
        )
    );
  }
}

function parseAllowedOrigins(raw) {
  if (!raw) return null;
  return new Set(
    raw
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

const DOCUMENT_TOKENS = parseDocumentTokens(process.env.DOCUMENT_TOKENS);
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

function operationsFor(documentId) {
  if (!documents.has(documentId)) {
    documents.set(documentId, new Map());
  }
  return documents.get(documentId);
}

function parseRequestUrl(requestUrl) {
  try {
    return new URL(requestUrl || "/", "http://localhost");
  } catch {
    return null;
  }
}

function documentIdFromUrl(url) {
  const documentId =
    url.searchParams.get("document_id") ||
    url.searchParams.get("doc") ||
    DEFAULT_DOCUMENT_ID;
  return isValidDocumentId(documentId) ? documentId : null;
}

function tokenForDocument(documentId) {
  return DOCUMENT_TOKENS.get(documentId) || AUTH_TOKEN || null;
}

function isKnownToken(token) {
  return (
    !!token &&
    ((AUTH_TOKEN && timingSafeEqualString(token, AUTH_TOKEN)) ||
      Array.from(DOCUMENT_TOKENS.values()).some((documentToken) =>
        timingSafeEqualString(token, documentToken)
      ))
  );
}

function tokenFromHeaders(headers) {
  const authorization = headers.authorization || "";
  const bearerPrefix = "Bearer ";
  const cookies = parseCookies(headers.cookie);

  if (authorization.startsWith(bearerPrefix)) {
    return authorization.slice(bearerPrefix.length);
  }
  if (cookies.crdt_token) return cookies.crdt_token;
  return "";
}

function hasAuthenticatedSession(headers) {
  if (!REQUIRE_AUTH && !AUTH_TOKEN && DOCUMENT_TOKENS.size === 0) return true;
  return isKnownToken(tokenFromHeaders(headers));
}

function allDocumentIds() {
  const knownDocumentIds = new Set([
    DEFAULT_DOCUMENT_ID,
    ...DOCUMENT_TOKENS.keys(),
    ...documents.keys(),
  ]);
  return Array.from(knownDocumentIds).sort();
}

function hasWorkspaceAccess(headers) {
  if (!REQUIRE_AUTH && !AUTH_TOKEN && DOCUMENT_TOKENS.size === 0) return true;
  const token = tokenFromHeaders(headers);
  return !!AUTH_TOKEN && timingSafeEqualString(token, AUTH_TOKEN);
}

function visibleDocumentIds(headers) {
  if (hasWorkspaceAccess(headers)) return allDocumentIds();
  return allDocumentIds().filter((documentId) =>
    canAccessDocument(documentId, headers)
  );
}

function canCreateDocuments(headers) {
  return hasWorkspaceAccess(headers);
}

function canAccessDocument(documentId, headers) {
  return authorizeRequest(documentId, headers, new URL("/", "http://localhost"));
}

function tokenCanAccessDocument(documentId, token) {
  const requiredToken = tokenForDocument(documentId);
  if (!requiredToken) return true;
  return (
    (AUTH_TOKEN && timingSafeEqualString(token, AUTH_TOKEN)) ||
    timingSafeEqualString(token, requiredToken)
  );
}

function shareTokenForDocument(documentId, headers) {
  const documentToken = DOCUMENT_TOKENS.get(documentId);
  if (!documentToken || !canAccessDocument(documentId, headers)) return null;
  if (hasWorkspaceAccess(headers)) return documentToken;

  const token = tokenFromHeaders(headers);
  return timingSafeEqualString(token, documentToken) ? documentToken : null;
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const idx = entry.indexOf("=");
        if (idx === -1) return [entry, ""];
        return [
          decodeURIComponent(entry.slice(0, idx)),
          decodeURIComponent(entry.slice(idx + 1)),
        ];
      })
  );
}

function authorizeRequest(documentId, headers, url) {
  const requiredToken = tokenForDocument(documentId);
  if (!requiredToken) return true;

  const authorization = headers.authorization || "";
  const bearerPrefix = "Bearer ";
  const cookies = parseCookies(headers.cookie);
  let suppliedToken = "";

  if (authorization.startsWith(bearerPrefix)) {
    suppliedToken = authorization.slice(bearerPrefix.length);
  } else if (cookies.crdt_token) {
    suppliedToken = cookies.crdt_token;
  } else if (ALLOW_URL_TOKENS) {
    suppliedToken = url.searchParams.get("token") || "";
  }

  return (
    (AUTH_TOKEN && timingSafeEqualString(suppliedToken, AUTH_TOKEN)) ||
    timingSafeEqualString(suppliedToken, requiredToken)
  );
}

function isOriginAllowed(origin) {
  return !ALLOWED_ORIGINS || !origin || ALLOWED_ORIGINS.has(origin);
}

function sendHttp(res, status, body = "", headers = {}) {
  const reason = {
    200: "OK",
    302: "Found",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    500: "Internal Server Error",
  }[status] || "Error";

  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  res.writeHead(status, reason, {
    "Content-Length": payload.length,
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, body, headers = {}) {
  sendHttp(res, status, JSON.stringify(body), {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
}

function readRequestBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cookieOptions() {
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    process.env.NODE_ENV === "production" ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function setAuthCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `crdt_token=${encodeURIComponent(token)}; ${cookieOptions()}`
  );
}

function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `crdt_token=; Max-Age=0; ${cookieOptions()}`
  );
}

function loadPgClient() {
  try {
    return require("pg").Client;
  } catch {
    throw new Error(
      "DATABASE_URL is set, but the pg package is not installed. Run npm install in backend/."
    );
  }
}

async function initializePersistence() {
  if (!process.env.DATABASE_URL) {
    console.log("Persistence: in-memory operation log");
    return;
  }

  const Client = loadPgClient();
  pgClient = new Client({ connectionString: process.env.DATABASE_URL });
  await pgClient.connect();

  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS crdt_operations (
      document_id TEXT NOT NULL,
      id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('insert', 'delete')),
      actor_id TEXT,
      previous_id TEXT,
      target_id TEXT,
      value TEXT,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (document_id, id)
    )
  `);
  await pgClient.query(
    "ALTER TABLE crdt_operations ADD COLUMN IF NOT EXISTS actor_id TEXT"
  );
  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS crdt_operations_created_at_idx
      ON crdt_operations (document_id, created_at, id)
  `);
  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS crdt_operations_previous_idx
      ON crdt_operations (document_id, previous_id)
  `);
  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS crdt_operations_target_idx
      ON crdt_operations (document_id, target_id)
  `);
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS crdt_snapshots (
      document_id TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const result = await pgClient.query(
    "SELECT document_id, payload FROM crdt_operations"
  );
  for (const row of result.rows) {
    operationsFor(row.document_id).set(row.payload.id, row.payload);
  }

  await pgClient.query("LISTEN crdt_operation");
  pgClient.on("notification", (message) => {
    if (message.channel !== "crdt_operation") return;
    try {
      const {
        document_id: documentId,
        op,
        source_id: sourceId,
      } = JSON.parse(message.payload);
      if (sourceId === SERVER_INSTANCE_ID) return;
      if (!isValidDocumentId(documentId) || !isValidOperation(op)) return;

      const operations = operationsFor(documentId);
      const existing = operations.get(op.id);
      if (existing && !sameOperation(existing, op)) {
        console.warn(
          `Ignoring conflicting notified operation ${op.id} in ${documentId}`
        );
        return;
      }
      operations.set(op.id, canonicalOperation(op));
      broadcastOperation(documentId, op);
    } catch (error) {
      console.error("Invalid PostgreSQL notification:", error.message);
    }
  });

  console.log(`Persistence: loaded ${result.rowCount} operations from PostgreSQL`);
}

async function notifyOperation(documentId, op) {
  if (!pgClient) return;
  await pgClient.query("SELECT pg_notify($1, $2)", [
    "crdt_operation",
    JSON.stringify({
      document_id: documentId,
      op: canonicalOperation(op),
      source_id: SERVER_INSTANCE_ID,
    }),
  ]);
}

async function persistOperation(documentId, op) {
  if (!pgClient) return { persisted: true };

  const actorId = op.id.includes("@") ? op.id.slice(op.id.indexOf("@") + 1) : null;
  const inserted = await pgClient.query(
    `INSERT INTO crdt_operations
       (document_id, id, type, actor_id, previous_id, target_id, value, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (document_id, id) DO NOTHING
     RETURNING payload`,
    [
      documentId,
      op.id,
      op.type,
      actorId,
      op.previous ?? null,
      op.target ?? null,
      op.value ?? null,
      JSON.stringify(canonicalOperation(op)),
    ]
  );

  if (inserted.rowCount === 1) return { persisted: true };

  const existing = await pgClient.query(
    "SELECT payload FROM crdt_operations WHERE document_id = $1 AND id = $2",
    [documentId, op.id]
  );
  if (existing.rowCount === 1 && sameOperation(existing.rows[0].payload, op)) {
    return { persisted: false, duplicate: true };
  }
  return { persisted: false, conflict: true };
}

function syncMessage(documentId, knownIds = []) {
  const known = new Set(Array.isArray(knownIds) ? knownIds : []);
  return {
    type: "sync",
    document_id: documentId,
    ops: Array.from(operationsFor(documentId).values()).filter(
      (op) => !known.has(op.id)
    ),
    clients: Array.from(clients).filter((client) => client.documentId === documentId)
      .length,
  };
}

function opMessage(documentId, op) {
  return { type: "op", document_id: documentId, op: canonicalOperation(op) };
}

function errorMessage(documentId, message) {
  return { type: "error", document_id: documentId, message };
}

function send(client, message) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(message));
  }
}

function sendSync(client, knownIds = []) {
  send(client, syncMessage(client.documentId, knownIds));
}

function broadcastOperation(documentId, op) {
  for (const client of clients) {
    if (client.documentId === documentId) {
      send(client, opMessage(documentId, op));
    }
  }
}

function isValidOpId(id) {
  return typeof id === "string" && /^[0-9]+@[A-Za-z0-9_-]{1,64}$/.test(id);
}

function hasOnlyKeys(object, keys) {
  const allowed = new Set(keys);
  return Object.keys(object).every((key) => allowed.has(key));
}

function isValidOperation(op) {
  if (!op || typeof op !== "object" || Array.isArray(op) || !isValidOpId(op.id)) {
    return false;
  }

  if (op.type === "insert") {
    if (!hasOnlyKeys(op, ["type", "id", "previous", "value"])) return false;
    const hasValidPrevious =
      op.previous === null || op.previous === undefined || isValidOpId(op.previous);
    return (
      hasValidPrevious &&
      typeof op.value === "string" &&
      [...op.value].length === MAX_OP_VALUE_CHARS
    );
  }

  if (op.type === "delete") {
    return hasOnlyKeys(op, ["type", "id", "target"]) && isValidOpId(op.target);
  }

  return false;
}

function canonicalOperation(op) {
  if (op.type === "insert") {
    return {
      type: "insert",
      id: op.id,
      previous: op.previous ?? null,
      value: op.value,
    };
  }
  return { type: "delete", id: op.id, target: op.target };
}

function sameOperation(left, right) {
  return (
    JSON.stringify(canonicalOperation(left)) ===
    JSON.stringify(canonicalOperation(right))
  );
}

async function rememberOperation(documentId, op) {
  const operations = operationsFor(documentId);
  if (!isValidOperation(op)) {
    return { accepted: false, reason: "invalid operation" };
  }

  const existing = operations.get(op.id);
  if (existing) {
    if (!sameOperation(existing, op)) {
      console.warn(
        `Conflicting duplicate operation ${op.id} in document ${documentId}`
      );
      return { accepted: false, reason: "conflicting duplicate operation" };
    }
    return { accepted: false, reason: "duplicate operation" };
  }

  const persistence = await persistOperation(documentId, op);
  if (persistence.conflict) {
    console.warn(
      `Conflicting persisted operation ${op.id} in document ${documentId}`
    );
    return { accepted: false, reason: "conflicting duplicate operation" };
  }
  if (persistence.duplicate) {
    operations.set(op.id, canonicalOperation(op));
    return { accepted: false, reason: "duplicate operation" };
  }

  operations.set(op.id, canonicalOperation(op));
  await notifyOperation(documentId, op);
  return { accepted: true };
}

function createHttpServer() {
  const frontendDir = path.resolve(__dirname, "../frontend");
  const staticFiles = new Map([
    ["/login.html", { file: "views/login.html", type: "text/html; charset=utf-8" }],
    ["/login.js", { file: "stores/login.js", type: "text/javascript; charset=utf-8" }],
    ["/home.html", { file: "views/home.html", type: "text/html; charset=utf-8" }],
    ["/home.js", { file: "stores/home.js", type: "text/javascript; charset=utf-8" }],
    ["/editor.html", { file: "views/editor.html", type: "text/html; charset=utf-8" }],
    ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
    ["/editor.js", { file: "stores/editor.js", type: "text/javascript; charset=utf-8" }],
    ["/websocket.js", { file: "stores/websocket.js", type: "text/javascript; charset=utf-8" }],
    ["/crdt_wasm.js", { file: "crdt_wasm.js", type: "text/javascript; charset=utf-8" }],
    ["/crdt_wasm.wasm", { file: "crdt_wasm.wasm", type: "application/wasm" }],
  ]);

  return http.createServer(async (req, res) => {
    const url = parseRequestUrl(req.url);
    if (!url) {
      sendHttp(res, 400, "Bad request");
      return;
    }

    if (url.pathname === "/") {
      sendHttp(res, 302, "", {
        Location: hasAuthenticatedSession(req.headers)
          ? "/home.html"
          : "/login.html",
      });
      return;
    }

    if (url.pathname === "/session" && req.method === "POST") {
      try {
        const body = JSON.parse(await readRequestBody(req));
        const suppliedToken = typeof body.token === "string" ? body.token : "";
        const hasDocumentParam =
          url.searchParams.has("document_id") || url.searchParams.has("doc");
        const documentId = hasDocumentParam ? documentIdFromUrl(url) : null;

        if (hasDocumentParam && !documentId) {
          sendJson(res, 400, { error: "Invalid document_id" });
          return;
        }

        if (
          !suppliedToken &&
          (documentId
            ? authorizeRequest(documentId, req.headers, url)
            : hasAuthenticatedSession(req.headers))
        ) {
          sendJson(res, 200, { authenticated: true });
          return;
        }

        const validToken = documentId
          ? tokenCanAccessDocument(documentId, suppliedToken)
          : isKnownToken(suppliedToken);

        if (!validToken) {
          sendJson(res, 401, { error: "Invalid token" });
          return;
        }
        setAuthCookie(res, suppliedToken);
        sendJson(res, 200, { authenticated: true });
      } catch {
        sendJson(res, 400, { error: "Invalid session request" });
      }
      return;
    }

    if (url.pathname === "/session" && req.method === "DELETE") {
      clearAuthCookie(res);
      sendJson(res, 200, { authenticated: false });
      return;
    }

    if (url.pathname === "/documents" && req.method === "GET") {
      if (!hasAuthenticatedSession(req.headers)) {
        sendJson(res, 401, { error: "Not authenticated" });
        return;
      }

      sendJson(res, 200, {
        documents: visibleDocumentIds(req.headers).map((documentId) => ({
          id: documentId,
          can_open: canAccessDocument(documentId, req.headers),
          share_token: shareTokenForDocument(documentId, req.headers),
          operations: operationsFor(documentId).size,
          clients: Array.from(clients).filter(
            (client) => client.documentId === documentId
          ).length,
        })),
        can_create: canCreateDocuments(req.headers),
      });
      return;
    }

    if (url.pathname === "/documents" && req.method === "POST") {
      if (!hasAuthenticatedSession(req.headers)) {
        sendJson(res, 401, { error: "Not authenticated" });
        return;
      }
      if (!canCreateDocuments(req.headers)) {
        sendJson(res, 403, { error: "This token cannot create documents" });
        return;
      }

      const documentId = `doc-${crypto.randomUUID().slice(0, 8)}`;
      operationsFor(documentId);
      sendJson(res, 200, { document_id: documentId });
      return;
    }

    if (req.method !== "GET") {
      sendHttp(res, 405, "Method not allowed");
      return;
    }

    if (url.pathname === "/home.html" && !hasAuthenticatedSession(req.headers)) {
      sendHttp(res, 302, "", { Location: "/login.html" });
      return;
    }

    if (url.pathname === "/editor.html") {
      const documentId = documentIdFromUrl(url);
      if (!documentId) {
        sendHttp(res, 400, "Invalid document_id");
        return;
      }
      if (!authorizeRequest(documentId, req.headers, url)) {
        sendHttp(res, 302, "", { Location: "/login.html" });
        return;
      }
    }

    const normalizedPath = url.pathname;
    const asset = staticFiles.get(normalizedPath);
    if (!asset) {
      sendHttp(res, 404, "Not found");
      return;
    }

    try {
      const content = fs.readFileSync(path.join(frontendDir, asset.file));
      sendHttp(res, 200, content, {
        "Content-Type": asset.type,
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'",
      });
    } catch (error) {
      const missing = error.code === "ENOENT";
      sendHttp(res, missing ? 404 : 500, missing ? "Not found" : "Server error");
    }
  });
}

function createWsServer() {
  const server = http.createServer((_, res) => {
    sendHttp(res, 404, "Not found");
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  });

  server.on("upgrade", (req, socket, head) => {
    const url = parseRequestUrl(req.url);
    if (!url) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const documentId = documentIdFromUrl(url);
    if (!documentId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!isOriginAllowed(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!authorizeRequest(documentId, req.headers, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, documentId);
    });
  });

  wss.on("connection", (ws, _req, documentId) => {
    const client = { ws, documentId };
    clients.add(client);
    sendSync(client);

    ws.on("message", async (data) => {
      if (data.length > MAX_MESSAGE_BYTES) {
        send(client, errorMessage(documentId, "Message too large"));
        return;
      }

      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        send(client, errorMessage(documentId, "Invalid JSON message"));
        return;
      }

      if (message.document_id !== undefined && message.document_id !== documentId) {
        send(client, errorMessage(documentId, "Document mismatch"));
        return;
      }

      if (message.type === "op") {
        const result = await rememberOperation(documentId, message.op);
        if (!result.accepted) {
          send(client, errorMessage(documentId, result.reason));
        } else {
          broadcastOperation(documentId, message.op);
        }
      } else if (message.type === "sync-request") {
        sendSync(client, message.known_ids);
      }
    });

    ws.on("close", () => {
      clients.delete(client);
    });
  });

  return server;
}

async function main() {
  if (REQUIRE_AUTH && !AUTH_TOKEN && DOCUMENT_TOKENS.size === 0) {
    throw new Error(
      "Authentication is required in this environment. Set AUTH_TOKEN or DOCUMENT_TOKENS."
    );
  }

  await initializePersistence();
  console.log(
    `Security: ${AUTH_TOKEN ? "global token enabled" : "open demo mode"}, ` +
      `${DOCUMENT_TOKENS.size} document token(s), ` +
      `${ALLOWED_ORIGINS ? `${ALLOWED_ORIGINS.size} allowed origin(s)` : "all origins allowed"}, ` +
      `${ALLOW_URL_TOKENS ? "URL tokens enabled" : "URL tokens disabled"}`
  );

  const httpServer = createHttpServer();
  const wsServer = createWsServer();

  httpServer.listen(HTTP_PORT, HOST, () => {
    console.log(
      `HTTP server listening on http://${HOST || "localhost"}:${HTTP_PORT}`
    );
  });

  wsServer.listen(WS_PORT, HOST, () => {
    console.log(
      `WebSocket server listening on ws://${HOST || "localhost"}:${WS_PORT}`
    );
  });
}

module.exports = {
  createHttpServer,
  createWsServer,
  main,
  __test: {
    allDocumentIds,
    authorizeRequest,
    canAccessDocument,
    canCreateDocuments,
    hasAuthenticatedSession,
    isKnownToken,
    tokenCanAccessDocument,
  },
};

if (require.main === module) {
  main().catch((error) => {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  });
}
