const assert = require("node:assert/strict");
const test = require("node:test");
const { createDocument, runScript } = require("./helpers");

test("login auto-submits token from invite links", async () => {
  const document = createDocument(["login-form", "token", "login-status"]);
  const requests = [];
  const context = {
    document,
    history: {
      replaced: null,
      replaceState: (_state, _title, url) => {
        context.history.replaced = url;
      },
    },
    location: {
      href: "http://localhost:3000/login.html?token=invite-secret",
      search: "?token=invite-secret",
    },
    URL,
    URLSearchParams,
    fetch: async (url, options) => {
      requests.push({ url: url.toString(), options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ authenticated: true }),
      };
    },
  };

  runScript("stores/login.js", context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(document.getElementById("token").value, "invite-secret");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://localhost:3000/session");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.body, JSON.stringify({ token: "invite-secret" }));
  assert.equal(context.history.replaced, "/login.html");
  assert.equal(context.location.href, "/home.html");
});
