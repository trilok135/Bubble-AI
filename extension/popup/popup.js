(() => {
  "use strict";

  const connEl = document.getElementById("conn");
  const statusRow = document.getElementById("statusRow");
  const authRow = document.getElementById("authRow");
  const authBtn = document.getElementById("authBtn");

  let signedIn = false;

  function safeSend(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) { resolve({ error: err.message }); return; }
          resolve(resp || { error: "No response" });
        });
      } catch (e) {
        resolve({ error: e.message });
      }
    });
  }

  async function refreshAuth() {
    const resp = await safeSend({ type: "auth-get-state" });
    if (resp.error) {
      authRow.textContent = "Auth state unknown";
      setAuthButton(false);
      return;
    }
    if (resp.status === "signed_in" && resp.user) {
      signedIn = true;
      authRow.classList.remove("empty");
      authRow.textContent = "Signed in as " + (resp.user.email || resp.user.name || "user");
    } else {
      signedIn = false;
      authRow.classList.add("empty");
      authRow.textContent = resp.status === "expired" ? "Session expired — sign in again" : "Not signed in";
    }
    setAuthButton(signedIn);
  }

  function setAuthButton(isSignedIn) {
    authBtn.textContent = isSignedIn ? "Sign out" : "Sign in with Google";
  }

  authBtn.addEventListener("click", async () => {
    authBtn.disabled = true;
    try {
      if (signedIn) {
        await safeSend({ type: "auth-logout" });
      } else {
        const resp = await safeSend({ type: "auth-google-signin" });
        if (resp.error) throw new Error(resp.error);
      }
    } catch (e) {
      authRow.textContent = e.message;
    } finally {
      authBtn.disabled = false;
      refreshAuth();
    }
  });

  async function refresh() {
    statusRow.textContent = "Loading\u2026";
    try {
      const resp = await safeSend({ type: "get-provider-status" });
      if (resp.error) throw new Error(resp.error);

      connEl.classList.remove("unknown", "bad");
      connEl.classList.add("ok");
      render(resp);
    } catch (e) {
      connEl.classList.remove("unknown", "ok");
      connEl.classList.add("bad");
      statusRow.textContent = "Service worker unreachable or error";
    }
  }

  function render(list) {
    statusRow.innerHTML = "";
    if (!list || list.length === 0) {
      statusRow.classList.add("empty");
      statusRow.textContent = "No providers configured. Open Settings to add keys.";
      return;
    }
    statusRow.classList.remove("empty");
    list.forEach((p) => {
      const div = document.createElement("div");
      div.className = "provider";
      const dot = document.createElement("span");
      dot.className = "dot " + (p.healthy ? "ok" : "bad");
      const name = document.createElement("span");
      name.className = "pname";
      name.textContent = p.name;
      const count = document.createElement("span");
      count.className = "pcount";
      count.textContent = p.requests_today + " today";
      div.append(dot, name, count);
      statusRow.appendChild(div);
    });
  }

  document.getElementById("openSettingsBtn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById("newSessionBtn").addEventListener("click", async () => {
    try {
      const resp = await safeSend({ type: "new-session", subject: null, topic: null });
      if (resp.error) throw new Error(resp.error);
      // BUG-13 fix: write to active_session_id (the key the SW uses), not session_id.
      await chrome.storage.local.set({ active_session_id: resp.sessionId });
      statusRow.textContent = "New session #" + resp.sessionId;
    } catch (e) {
      statusRow.textContent = "Could not create session";
    }
  });

  refreshAuth();
  refresh();
})();
