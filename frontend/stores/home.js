(function () {
  const list = document.getElementById("document-list");
  const status = document.getElementById("home-status");
  const createButton = document.getElementById("create-document");
  const logoutButton = document.getElementById("logout");

  function editorUrl(documentId) {
    return `/editor.html?document_id=${encodeURIComponent(documentId)}`;
  }

  function inviteUrl(token) {
    const url = new URL("/login.html", location.href);
    url.searchParams.set("token", token);
    return url.toString();
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const input = document.createElement("input");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }

  function renderDocuments(documents) {
    list.replaceChildren();

    if (documents.length === 0) {
      status.textContent = "No documents available.";
      return;
    }

    status.textContent = "";
    for (const doc of documents) {
      const item = document.createElement("div");
      const link = document.createElement("a");
      const title = document.createElement("strong");
      const operations = document.createElement("span");
      const clients = document.createElement("span");
      const shareButton = document.createElement("button");

      item.className = "document-item";
      link.href = editorUrl(doc.id);
      link.className = "document-open-link";
      title.textContent = doc.id;
      operations.textContent = `${doc.operations} ops`;
      clients.textContent = `${doc.clients} active`;
      link.append(title, operations, clients);

      shareButton.type = "button";
      shareButton.textContent = "Share";
      shareButton.disabled = !doc.share_token;
      shareButton.title = doc.share_token
        ? "Copy invite link"
        : "No document token is configured for this document.";
      shareButton.addEventListener("click", async () => {
        try {
          await copyText(inviteUrl(doc.share_token));
          status.textContent = `Copied invite for ${doc.id}.`;
        } catch {
          status.textContent = "Could not copy invite link.";
        }
      });

      item.append(link, shareButton);
      list.appendChild(item);
    }
  }

  async function loadDocuments() {
    const response = await fetch("/documents", { credentials: "same-origin" });
    if (response.status === 401) {
      location.href = "/login.html";
      return;
    }
    if (!response.ok) {
      status.textContent = "Could not load documents.";
      return;
    }

    const body = await response.json();
    createButton.disabled = body.can_create === false;
    createButton.title =
      body.can_create === false
        ? "Sign in with the workspace token to create documents."
        : "";
    renderDocuments(Array.isArray(body.documents) ? body.documents : []);
  }

  createButton.addEventListener("click", async () => {
    status.textContent = "Creating document...";
    const response = await fetch("/documents", {
      method: "POST",
      credentials: "same-origin",
    });

    if (response.status === 401) {
      location.href = "/login.html";
      return;
    }
    if (response.status === 403) {
      status.textContent = "This token cannot create documents.";
      return;
    }
    if (!response.ok) {
      status.textContent = "Could not create document.";
      return;
    }

    const body = await response.json();
    location.href = editorUrl(body.document_id);
  });

  logoutButton.addEventListener("click", async () => {
    await fetch("/session", { method: "DELETE", credentials: "same-origin" });
    location.href = "/login.html";
  });

  loadDocuments().catch(() => {
    status.textContent = "Could not load documents.";
  });
})();
