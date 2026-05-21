(function () {
  const params = new URLSearchParams(location.search);
  const form = document.getElementById("login-form");
  const documentInput = document.getElementById("document-id");
  const tokenInput = document.getElementById("token");
  const status = document.getElementById("login-status");

  documentInput.value = params.get("document_id") || params.get("doc") || "default";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const documentId = documentInput.value.trim();
    const token = tokenInput.value;
    if (!documentId) return;

    status.textContent = "Checking token...";

    const sessionUrl = new URL("/session", location.href);
    sessionUrl.searchParams.set("document_id", documentId);

    try {
      const response = await fetch(sessionUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (!response.ok) {
        status.textContent = response.status === 401 ? "Invalid token" : "Login failed";
        return;
      }

      const body = await response.json().catch(() => ({}));
      if (body.authenticated !== true) {
        status.textContent = "Login failed";
        return;
      }

      location.href = `/editor.html?document_id=${encodeURIComponent(documentId)}`;
    } catch {
      status.textContent = "Could not reach the server";
    }
  });
})();
