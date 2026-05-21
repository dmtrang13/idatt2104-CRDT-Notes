(function () {
  const params = new URLSearchParams(location.search);
  const form = document.getElementById("login-form");
  const tokenInput = document.getElementById("token");
  const status = document.getElementById("login-status");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const token = tokenInput.value;

    status.textContent = "Checking token...";

    const sessionUrl = new URL("/session", location.href);
    const documentId = params.get("document_id") || params.get("doc");
    if (documentId) sessionUrl.searchParams.set("document_id", documentId);

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

      location.href = "/home.html";
    } catch {
      status.textContent = "Could not reach the server";
    }
  });
})();
