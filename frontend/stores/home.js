(function () {
  const list = document.getElementById("document-list");
  const status = document.getElementById("home-status");
  const createButton = document.getElementById("create-document");
  const logoutButton = document.getElementById("logout");

  function editorUrl(documentId) {
    return `/editor.html?document_id=${encodeURIComponent(documentId)}`;
  }

  function renderDocuments(documents) {
    list.replaceChildren();

    if (documents.length === 0) {
      status.textContent = "No documents available for this token.";
      return;
    }

    status.textContent = "";
    for (const doc of documents) {
      const link = document.createElement("a");
      const title = document.createElement("strong");
      const operations = document.createElement("span");
      const clients = document.createElement("span");

      link.href = editorUrl(doc.id);
      link.className = "document-item";
      title.textContent = doc.id;
      operations.textContent = `${doc.operations} ops`;
      clients.textContent = `${doc.clients} active`;

      link.append(title, operations, clients);
      list.appendChild(link);
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
    createButton.disabled = body.can_create !== true;
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
