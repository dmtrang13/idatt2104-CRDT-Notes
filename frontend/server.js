const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const WS_PORT = Number(process.env.WS_PORT || 3001);
const HOST = process.env.HOST;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_DOCUMENT_ID = "default";
const MAX_FRAME_PAYLOAD_BYTES = Number(process.env.MAX_FRAME_PAYLOAD_BYTES || 1024 * 1024);
const MAX_MESSAGE_BYTES = Number(process.env.MAX_MESSAGE_BYTES || 256 * 1024);
const MAX_OP_VALUE_CHARS = Number(process.env.MAX_OP_VALUE_CHARS || 1);
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const DOCUMENT_TOKENS = parseDocumentTokens(process.env.DOCUMENT_TOKENS);
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

const clients = new Set();
const documents = new Map();
let pgClient = null;

function parseDocumentTokens(raw) {
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw);
    return new Map(
      Object.entries(parsed).filter(
        ([documentId, token]) => isValidDocumentId(documentId) && typeof token === "string"
      )
    );
  } catch {
    return new Map(
      raw
        .split(",")
        .map((entry) => entry.split("="))
        .filter(
          ([documentId, token]) => isValidDocumentId(documentId) && typeof token === "string"
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

function operationsFor(documentId) {
  if (!documents.has(documentId)) {
    documents.set(documentId, new Map());
  }
  return documents.get(documentId);
}

function isValidDocumentId(documentId) {
  return (
    typeof documentId === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(documentId)
  );
}

function parseDocumentIdFromPath(requestPath) {
  try {
    const url = new URL(requestPath, "http://localhost");
    const documentId =
      url.searchParams.get("document_id") ||
      url.searchParams.get("doc") ||
      DEFAULT_DOCUMENT_ID;
    return isValidDocumentId(documentId) ? documentId : DEFAULT_DOCUMENT_ID;
  } catch {
    return DEFAULT_DOCUMENT_ID;
  }
}

function parseRequestUrl(requestPath) {
  try {
    return new URL(requestPath, "http://localhost");
  } catch {
    return null;
  }
}

function tokenForDocument(documentId) {
  return DOCUMENT_TOKENS.get(documentId) || AUTH_TOKEN || null;
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function authorizeRequest(documentId, headers, url) {
  const requiredToken = tokenForDocument(documentId);
  if (!requiredToken) {
    return true;
  }

  const authorization = headers.authorization || "";
  const bearerPrefix = "Bearer ";
  const suppliedToken = authorization.startsWith(bearerPrefix)
    ? authorization.slice(bearerPrefix.length)
    : url.searchParams.get("token") || "";

  return timingSafeEqualString(suppliedToken, requiredToken);
}

function isOriginAllowed(origin) {
  return !ALLOWED_ORIGINS || !origin || ALLOWED_ORIGINS.has(origin);
}

function parseHeaders(lines) {
  const headers = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx !== -1) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line
        .slice(idx + 1)
        .trim();
    }
  }
  return headers;
}

function httpResponse(status, body = "", headers = {}) {
  const payload = Buffer.from(body, "utf8");
  const reason = {
    200: "OK",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    500: "Internal Server Error",
  }[status] || "Error";

  const headerLines = {
    "Content-Length": payload.length,
    "X-Content-Type-Options": "nosniff",
    ...headers,
  };

  return Buffer.concat([
    Buffer.from(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        Object.entries(headerLines)
          .map(([name, value]) => `${name}: ${value}\r\n`)
          .join("") +
        "\r\n",
      "utf8"
    ),
    payload,
  ]);
}

function loadPgClient() {
  try {
    return require("pg").Client;
  } catch (error) {
    throw new Error(
      "DATABASE_URL is set, but the pg package is not installed. Run npm install in frontend/."
    );
  }
}

async function initializePersistence() {
  if (!process.env.DATABASE_URL) {
    console.log("Persistence: in-memory operation log");
    return;
  }

  const Client = loadPgClient();
  pgClient = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  await pgClient.connect();
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS crdt_operations (
      document_id TEXT NOT NULL,
      id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('insert', 'delete')),
      previous_id TEXT,
      target_id TEXT,
      value TEXT,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (document_id, id)
    )
  `);

  const schemaCheck = await pgClient.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'crdt_operations'
        AND column_name = 'document_id'
    ) AS has_document_id
  `);
  if (!schemaCheck.rows[0].has_document_id) {
    throw new Error(
      "Existing crdt_operations table is missing document_id. Migrate the table or reset the Docker volume with: docker compose down -v"
    );
  }

  await pgClient.query(`
    CREATE INDEX IF NOT EXISTS crdt_operations_created_at_idx
      ON crdt_operations (document_id, created_at, id)
  `);

  const result = await pgClient.query(
    "SELECT document_id, payload FROM crdt_operations"
  );
  for (const row of result.rows) {
    operationsFor(row.document_id).set(row.payload.id, row.payload);
  }
  console.log(`Persistence: loaded ${result.rowCount} operations from PostgreSQL`);
}

async function persistOperation(documentId, op) {
  if (!pgClient) return;

  await pgClient.query(
    `INSERT INTO crdt_operations
       (document_id, id, type, previous_id, target_id, value, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (document_id, id) DO NOTHING`,
    [
      documentId,
      op.id,
      op.type,
      op.previous ?? null,
      op.target ?? null,
      op.value ?? null,
      JSON.stringify(op),
    ]
  );
}

function computeAcceptKey(secWebSocketKey) {
  return crypto
    .createHash("sha1")
    .update(secWebSocketKey.trim() + WS_GUID, "utf8")
    .digest("base64");
}

function makeTextFrame(str) {
  const payload = Buffer.from(str, "utf8");
  let header;

  if (payload.length <= 125) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([header, payload]);
}

function makeControlFrame(opcode, payloadBuf = Buffer.alloc(0)) {
  if (payloadBuf.length > 125) {
    throw new Error("Control payload too long.");
  }
  const frame = Buffer.alloc(2 + payloadBuf.length);
  frame[0] = 0x80 | (opcode & 0x0f);
  frame[1] = payloadBuf.length;
  payloadBuf.copy(frame, 2);
  return frame;
}

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (buffer.length - offset < 4) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (buffer.length - offset < 10) break;
      const bigLen = buffer.readBigUInt64BE(offset + 2);
      if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Frame too large.");
      }
      payloadLen = Number(bigLen);
      headerLen = 10;
    }

    if (payloadLen > MAX_FRAME_PAYLOAD_BYTES) {
      throw new Error("Frame payload too large.");
    }

    if (!fin) {
      throw new Error("Fragmented frames are not supported.");
    }
    if (!masked) {
      throw new Error("Client frames must be masked.");
    }

    const maskOffset = offset + headerLen;
    const payloadOffset = maskOffset + 4;
    if (buffer.length - offset < headerLen + 4 + payloadLen) break;

    const maskKey = buffer.subarray(maskOffset, maskOffset + 4);
    const payload = Buffer.from(
      buffer.subarray(payloadOffset, payloadOffset + payloadLen)
    );
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }

    frames.push({ opcode, payload });
    offset = payloadOffset + payloadLen;
  }

  return { frames, remaining: buffer.subarray(offset) };
}

function send(client, message) {
  if (client.state === "OPEN" && !client.socket.destroyed) {
    client.socket.write(makeTextFrame(JSON.stringify(message)));
  }
}

function syncMessage(documentId) {
  return {
    type: "sync",
    document_id: documentId,
    ops: Array.from(operationsFor(documentId).values()),
    clients: Array.from(clients).filter((client) => client.documentId === documentId)
      .length,
  };
}

function syncDocument(documentId) {
  for (const client of clients) {
    if (client.documentId === documentId) {
      send(client, syncMessage(documentId));
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
    if (!hasOnlyKeys(op, ["type", "id", "previous", "value"])) {
      return false;
    }
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
  return {
    type: "delete",
    id: op.id,
    target: op.target,
  };
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

  operations.set(op.id, op);
  await persistOperation(documentId, op);
  return { accepted: true };
}

const httpServer = net.createServer((connection) => {
  connection.on("error", (error) => {
    console.error("HTTP socket error:", error.message);
  });

  connection.once("data", (reqBuf) => {
    const req = reqBuf.toString("utf8");
    const [requestLine, ...headerLines] = req.split("\r\n");
    const [method, urlPath] = requestLine.split(" ");
    const headers = parseHeaders(headerLines);
    const url = parseRequestUrl(urlPath || "/");

    if (!url) {
      connection.end(httpResponse(400, "Bad request"));
      return;
    }

    if (method !== "GET") {
      connection.end(httpResponse(405, "Method not allowed"));
      return;
    }

    const documentId = parseDocumentIdFromPath(urlPath);
    if (!authorizeRequest(documentId, headers, url)) {
      connection.end(httpResponse(401, "Unauthorized"));
      return;
    }

    const normalizedPath = url.pathname === "/" ? "/editor.html" : url.pathname;
    if (normalizedPath !== "/editor.html") {
      connection.end(httpResponse(404, "Not found"));
      return;
    }

    const filePath = path.join(__dirname, "editor.html");
    try {
      const content = fs.readFileSync(filePath);
      connection.end(
        httpResponse(200, content.toString("utf8"), {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; style-src 'unsafe-inline' 'self'; script-src 'unsafe-inline' 'self'",
        })
      );
    } catch {
      connection.end(httpResponse(500, "Server error"));
    }
  });
});

const wsServer = net.createServer((connection) => {
  const client = {
    socket: connection,
    state: "HANDSHAKE",
    buffer: Buffer.alloc(0),
    documentId: DEFAULT_DOCUMENT_ID,
  };
  clients.add(client);

  connection.on("data", async (data) => {
    client.buffer = Buffer.concat([client.buffer, data]);

    try {
      if (client.state === "HANDSHAKE") {
        const asText = client.buffer.toString("utf8");
        const headerEnd = asText.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headerText = asText.slice(0, headerEnd);
        const lines = headerText.split("\r\n");
        const requestLine = lines.shift();
        if (!requestLine || !requestLine.startsWith("GET ")) {
          connection.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        const [, requestPath] = requestLine.split(" ");
        const url = parseRequestUrl(requestPath || "/");
        if (!url) {
          connection.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        client.documentId = parseDocumentIdFromPath(requestPath);

        const headers = parseHeaders(lines);

        const upgrade = (headers.upgrade || "").toLowerCase();
        const connectionHeader = (headers.connection || "").toLowerCase();
        const key = headers["sec-websocket-key"];
        const version = headers["sec-websocket-version"];
        if (
          upgrade !== "websocket" ||
          !connectionHeader.includes("upgrade") ||
          !key ||
          version !== "13"
        ) {
          connection.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        if (!isOriginAllowed(headers.origin)) {
          connection.end("HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
        if (!authorizeRequest(client.documentId, headers, url)) {
          connection.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
          return;
        }

        connection.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n` +
            "\r\n"
        );

        const headerBytes = Buffer.byteLength(
          asText.slice(0, headerEnd + 4),
          "utf8"
        );
        client.buffer = client.buffer.subarray(headerBytes);
        client.state = "OPEN";
        syncDocument(client.documentId);
      }

      if (client.state === "OPEN") {
        const { frames, remaining } = parseFrames(client.buffer);
        client.buffer = remaining;

        for (const frame of frames) {
          if (frame.opcode === 0x1) {
            if (frame.payload.length > MAX_MESSAGE_BYTES) {
              send(client, { type: "error", message: "Message too large" });
              continue;
            }

            let message;
            try {
              message = JSON.parse(frame.payload.toString("utf8"));
            } catch {
              send(client, { type: "error", message: "Invalid JSON message" });
              continue;
            }

            if (message.type === "op") {
              const result = await rememberOperation(client.documentId, message.op);
              if (result.accepted) {
                syncDocument(client.documentId);
              } else {
                send(client, { type: "error", message: result.reason });
              }
            } else if (message.type === "sync-request") {
              send(client, syncMessage(client.documentId));
            }
          } else if (frame.opcode === 0x8) {
            connection.write(makeControlFrame(0x8));
            connection.end();
          } else if (frame.opcode === 0x9) {
            connection.write(makeControlFrame(0xA, frame.payload));
          }
        }
      }
    } catch (error) {
      console.error("WebSocket error:", error.message);
      try {
        connection.write(makeControlFrame(0x8));
      } catch {}
      connection.end();
    }
  });

  function removeClient() {
    const removed = clients.delete(client);
    if (removed) {
      syncDocument(client.documentId);
    }
  }

  connection.on("end", removeClient);
  connection.on("close", removeClient);
  connection.on("error", (error) => {
    console.error("Socket error:", error.message);
    removeClient();
  });
});

async function main() {
  await initializePersistence();
  console.log(
    `Security: ${AUTH_TOKEN ? "global token enabled" : "open demo mode"}, ` +
      `${DOCUMENT_TOKENS.size} document token(s), ` +
      `${ALLOWED_ORIGINS ? `${ALLOWED_ORIGINS.size} allowed origin(s)` : "all origins allowed"}`
  );

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

main().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});
