const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const WS_PORT = Number(process.env.WS_PORT || 3001);
const HOST = process.env.HOST;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const clients = new Set();
const operations = new Map();

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

function broadcast(message) {
  for (const client of clients) {
    send(client, message);
  }
}

function syncMessage() {
  return {
    type: "sync",
    ops: Array.from(operations.values()),
    clients: clients.size,
  };
}

function syncAll() {
  broadcast(syncMessage());
}

function rememberOperation(op) {
  if (!op || typeof op.id !== "string" || operations.has(op.id)) {
    return false;
  }
  if (op.type !== "insert" && op.type !== "delete") {
    return false;
  }
  operations.set(op.id, op);
  return true;
}

const httpServer = net.createServer((connection) => {
  connection.on("error", (error) => {
    console.error("HTTP socket error:", error.message);
  });

  connection.once("data", (reqBuf) => {
    const req = reqBuf.toString("utf8");
    const [requestLine] = req.split("\r\n");
    const [method, urlPath] = requestLine.split(" ");

    if (method !== "GET") {
      connection.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
      return;
    }

    const normalizedPath =
      urlPath === "/" ? "/editor.html" : decodeURIComponent(urlPath);
    if (normalizedPath !== "/editor.html") {
      connection.end("HTTP/1.1 404 Not Found\r\n\r\nNot found");
      return;
    }

    const filePath = path.join(__dirname, "editor.html");
    const content = fs.readFileSync(filePath);
    connection.write(
      "HTTP/1.1 200 OK\r\n" +
        "Content-Type: text/html; charset=utf-8\r\n" +
        "Content-Length: " +
        content.length +
        "\r\n\r\n"
    );
    connection.write(content);
    connection.end();
  });
});

httpServer.listen(HTTP_PORT, HOST, () => {
  console.log(`HTTP server listening on http://${HOST || "localhost"}:${HTTP_PORT}`);
});

const wsServer = net.createServer((connection) => {
  const client = {
    socket: connection,
    state: "HANDSHAKE",
    buffer: Buffer.alloc(0),
  };
  clients.add(client);

  connection.on("data", (data) => {
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

        const headers = {};
        for (const line of lines) {
          const idx = line.indexOf(":");
          if (idx !== -1) {
            headers[line.slice(0, idx).trim().toLowerCase()] = line
              .slice(idx + 1)
              .trim();
          }
        }

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
        syncAll();
      }

      if (client.state === "OPEN") {
        const { frames, remaining } = parseFrames(client.buffer);
        client.buffer = remaining;

        for (const frame of frames) {
          if (frame.opcode === 0x1) {
            const message = JSON.parse(frame.payload.toString("utf8"));
            if (message.type === "op" && rememberOperation(message.op)) {
              syncAll();
            } else if (message.type === "sync-request") {
              send(client, syncMessage());
            } else if (message.type === "op") {
              send(client, syncMessage());
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
      syncAll();
    }
  }

  connection.on("end", removeClient);
  connection.on("close", removeClient);
  connection.on("error", (error) => {
    console.error("Socket error:", error.message);
    removeClient();
  });
});

wsServer.listen(WS_PORT, HOST, () => {
  console.log(`WebSocket server listening on ws://${HOST || "localhost"}:${WS_PORT}`);
});
