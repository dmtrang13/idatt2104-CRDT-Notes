const assert = require("node:assert/strict");
const test = require("node:test");
const { createDocument, runScript } = require("./helpers");

function createContext(fetch) {
  const document = createDocument([
    "document-list",
    "home-status",
    "create-document",
    "logout",
  ]);
  const copied = [];
  const context = {
    document,
    location: {
      href: "http://localhost:3000/home.html",
    },
    URL,
    URLSearchParams,
    navigator: {
      clipboard: {
        writeText: async (text) => copied.push(text),
      },
    },
    window: {
      isSecureContext: true,
    },
    fetch,
  };
  context.window.document = document;
  return { context, document, copied };
}

test("home renders only documents returned by the backend and copies invite links", async () => {
  const { context, document, copied } = createContext(async (url) => {
    assert.equal(url, "/documents");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        can_create: false,
        documents: [
          {
            id: "research-doc",
            operations: 4,
            clients: 1,
            share_token: "research-secret",
          },
        ],
      }),
    };
  });

  runScript("stores/home.js", context);
  await new Promise((resolve) => setImmediate(resolve));

  const list = document.getElementById("document-list");
  const createButton = document.getElementById("create-document");

  assert.equal(createButton.disabled, true);
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].href, "/editor.html?document_id=research-doc");
  assert.equal(list.children[0].children[0].children[0].textContent, "research-doc");

  const shareButton = list.children[0].children[1];
  assert.equal(shareButton.disabled, false);
  await shareButton.dispatch("click");

  assert.deepEqual(copied, [
    "http://localhost:3000/login.html?token=research-secret",
  ]);
  assert.equal(
    document.getElementById("home-status").textContent,
    "Copied invite for research-doc."
  );
});

test("home creates a document and navigates to the editor", async () => {
  const { context, document } = createContext(async (url, options = {}) => {
    if (url === "/documents" && !options.method) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ can_create: true, documents: [] }),
      };
    }

    assert.equal(url, "/documents");
    assert.equal(options.method, "POST");
    return {
      ok: true,
      status: 200,
      json: async () => ({ document_id: "doc-12345678" }),
    };
  });

  runScript("stores/home.js", context);
  await new Promise((resolve) => setImmediate(resolve));

  await document.getElementById("create-document").dispatch("click");
  assert.equal(
    context.location.href,
    "/editor.html?document_id=doc-12345678"
  );
});
