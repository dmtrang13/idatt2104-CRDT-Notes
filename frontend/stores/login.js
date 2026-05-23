(function () {
  const form = document.getElementById("login-form");
  const tokenInput = document.getElementById("token");
  const status = document.getElementById("login-status");
  const params = new URLSearchParams(location.search);

  async function login(token) {
    status.textContent = "Checking token...";

    const sessionUrl = new URL("/session", location.href);
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

    history.replaceState(null, "", "/login.html");
    location.href = "/home.html";
  }

  const urlToken = params.get("token");
  if (urlToken) {
    tokenInput.value = urlToken;
    login(urlToken).catch(() => {
      status.textContent = "Could not reach the server";
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const token = tokenInput.value;

    try {
      await login(token);
    } catch {
      status.textContent = "Could not reach the server";
    }
  });
})();
