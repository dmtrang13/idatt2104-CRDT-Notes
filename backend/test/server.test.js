const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const WORKSPACE_TOKEN = "workspace-secret";
const NOTES_TOKEN = "notes-secret";
const RESEARCH_TOKEN = "research-secret";

function loadServer() {
  const serverPath = require.resolve("../server.js");
  delete require.cache[serverPath];

  process.env.REQUIRE_AUTH = "true";
  process.env.AUTH_TOKEN = WORKSPACE_TOKEN;
  process.env.DOCUMENT_TOKENS = JSON.stringify({
    "notes-main": NOTES_TOKEN,
    "research-doc": RESEARCH_TOKEN,
  });
  delete process.env.DATABASE_URL;
  delete process.env.ALLOW_URL_TOKENS;

  return require("../server.js");
}

async function withHttpServer(run) {
  const { createHttpServer } = loadServer();
  const server = createHttpServer();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function request(baseUrl, path, options = {}) {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method || "GET",
        headers: {
          ...(options.json ? { "Content-Type": "application/json" } : {}),
          ...(options.cookie ? { Cookie: options.cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const contentType = res.headers["content-type"] || "";
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json: contentType.includes("application/json") && text
              ? JSON.parse(text)
              : null,
          });
        });
      }
    );
    req.on("error", reject);
    if (options.json) req.write(JSON.stringify(options.json));
    req.end();
  });
}

async function login(baseUrl, token) {
  const response = await request(baseUrl, "/session", {
    method: "POST",
    json: { token },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.authenticated, true);
  return response.headers["set-cookie"][0].split(";")[0];
}

test("root redirects unauthenticated users to login", async () => {
  await withHttpServer(async (baseUrl) => {
    const response = await request(baseUrl, "/");
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, "/login.html");
  });
});

test("workspace token can see, open, share, and create documents", async () => {
  await withHttpServer(async (baseUrl) => {
    const cookie = await login(baseUrl, WORKSPACE_TOKEN);

    const root = await request(baseUrl, "/", { cookie });
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, "/home.html");

    const documents = await request(baseUrl, "/documents", { cookie });
    assert.equal(documents.status, 200);
    assert.equal(documents.json.can_create, true);
    assert.deepEqual(
      documents.json.documents.map((doc) => doc.id),
      ["default", "notes-main", "research-doc"]
    );
    assert.equal(
      documents.json.documents.find((doc) => doc.id === "research-doc").can_open,
      true
    );
    assert.equal(
      documents.json.documents.find((doc) => doc.id === "research-doc").share_token,
      RESEARCH_TOKEN
    );

    const editor = await request(baseUrl, "/editor.html?document_id=research-doc", {
      cookie,
    });
    assert.equal(editor.status, 200);

    const created = await request(baseUrl, "/documents", {
      method: "POST",
      cookie,
    });
    assert.equal(created.status, 200);
    assert.match(created.json.document_id, /^doc-[a-f0-9-]{8}$/);
  });
});

test("document token only sees and opens its shared document", async () => {
  await withHttpServer(async (baseUrl) => {
    const cookie = await login(baseUrl, RESEARCH_TOKEN);

    const documents = await request(baseUrl, "/documents", { cookie });
    assert.equal(documents.status, 200);
    assert.equal(documents.json.can_create, false);
    assert.deepEqual(
      documents.json.documents.map((doc) => doc.id),
      ["research-doc"]
    );
    assert.equal(documents.json.documents[0].share_token, RESEARCH_TOKEN);

    const allowed = await request(baseUrl, "/editor.html?document_id=research-doc", {
      cookie,
    });
    assert.equal(allowed.status, 200);

    const blocked = await request(baseUrl, "/editor.html?document_id=notes-main", {
      cookie,
    });
    assert.equal(blocked.status, 302);
    assert.equal(blocked.headers.location, "/login.html");

    const created = await request(baseUrl, "/documents", {
      method: "POST",
      cookie,
    });
    assert.equal(created.status, 403);
  });
});
