(() => {
  "use strict";

  const saveBtn = document.getElementById("saveBtn");
  const saveMsg = document.getElementById("saveMsg");
  const statusBody = document.getElementById("statusBody");
  const refreshBtn = document.getElementById("refreshBtn");
  const newSessionBtn = document.getElementById("newSessionBtn");
  const clearMemoryBtn = document.getElementById("clearMemoryBtn");
  const sessionInfo = document.getElementById("sessionInfo");

  const keys = ["gemini", "groq", "openai"];

  async function loadConfig() {
    const data = await chrome.storage.local.get(["raw_key_gemini", "raw_key_groq", "raw_key_openai"]);
    
    keys.forEach(k => {
      const el = document.getElementById(`${k}Status`);
      const val = data[`raw_key_${k}`];
      if (val) {
        el.textContent = "key saved ✓";
        el.className = "key-status ok";
        document.getElementById(`${k}Key`).placeholder = "••••••••••••••••";
      } else {
        el.textContent = "no key ✗";
        el.className = "key-status bad";
      }
    });
  }

  async function save() {
    saveBtn.disabled = true;
    saveMsg.textContent = "Saving...";
    saveMsg.className = "msg";
    
    const toSave = {};
    
    keys.forEach(k => {
      const input = document.getElementById(`${k}Key`).value.trim();
      if (input) {
        toSave[`raw_key_${k}`] = input;
      }
    });

    try {
      if (Object.keys(toSave).length > 0) {
        await chrome.storage.local.set(toSave);
      }
      
      // Clear inputs
      keys.forEach(k => {
        document.getElementById(`${k}Key`).value = "";
      });
      
      await loadConfig();
      await refreshStatus();
      
      saveMsg.textContent = "Keys saved successfully.";
      saveMsg.className = "msg ok";
    } catch (e) {
      saveMsg.textContent = "Failed to save: " + e.message;
      saveMsg.className = "msg err";
    } finally {
      saveBtn.disabled = false;
      setTimeout(() => { if (saveMsg.className === "msg ok") saveMsg.textContent = ""; }, 3000);
    }
  }

  async function refreshStatus() {
    statusBody.innerHTML = "<tr><td colspan=3>Loading…</td></tr>";
    try {
      const list = await chrome.runtime.sendMessage({ type: "get-provider-status" });
      
      if (list && list.error) {
          throw new Error(list.error);
      }
      
      statusBody.innerHTML = "";
      
      if (!list || list.length === 0) {
        statusBody.innerHTML = "<tr><td colspan=3>No providers enabled. Add keys above.</td></tr>";
        return;
      }
      
      list.forEach((p) => {
        const tr = document.createElement("tr");
        const name = document.createElement("td");
        name.textContent = p.name;
        
        const health = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = "badge " + (p.healthy ? "ok" : "bad");
        badge.textContent = p.healthy ? "healthy" : "unhealthy";
        health.appendChild(badge);
        
        const count = document.createElement("td");
        count.textContent = p.requests_today;
        
        tr.append(name, health, count);
        statusBody.appendChild(tr);
      });
    } catch (e) {
      statusBody.innerHTML = `<tr><td colspan=3>Error: ${e.message}</td></tr>`;
    }
  }

  async function currentSession() {
    // BUG-01 fix: normalise to active_session_id — the key the service worker
    // actually reads and writes (settings.js was using the wrong key 'session_id').
    return (await chrome.storage.local.get("active_session_id")).active_session_id;
  }

  async function refreshSessionInfo() {
    const sid = await currentSession();
    sessionInfo.textContent = sid ? `Active session #${sid}.` : "No active session.";
  }

  async function newSession() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "new-session", subject: null, topic: null });
      if (resp.error) throw new Error(resp.error);
      await chrome.storage.local.set({ active_session_id: resp.sessionId });
      await refreshSessionInfo();
      saveMsg.textContent = "New session #" + resp.sessionId;
      saveMsg.className = "msg ok";
    } catch (e) {
      saveMsg.textContent = "Failed: " + e.message;
      saveMsg.className = "msg err";
    }
  }

  async function clearMemoryNow() {
    const sid = await currentSession();
    if (!sid) {
      saveMsg.textContent = "Start a session first.";
      saveMsg.className = "msg err";
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({ type: "clear-memory", sessionId: sid });
      if (resp.error) throw new Error(resp.error);
      
      saveMsg.textContent = "Memory cleared for this session.";
      saveMsg.className = "msg ok";
    } catch (e) {
      saveMsg.textContent = "Clear failed: " + e.message;
      saveMsg.className = "msg err";
    }
  }

  saveBtn.addEventListener("click", save);
  refreshBtn.addEventListener("click", refreshStatus);
  newSessionBtn.addEventListener("click", newSession);
  clearMemoryBtn.addEventListener("click", clearMemoryNow);

  loadConfig().then(() => {
    refreshStatus();
    refreshSessionInfo();
  });
})();
