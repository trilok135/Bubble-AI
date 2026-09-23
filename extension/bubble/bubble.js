/**
 * Bubble AI — Stage 4 Adaptive Sidebar ("Dynamic Island" Engine)
 *
 * Single-init architecture: init() is idempotent and safe to call multiple
 * times — it only wires up event listeners once via a _eventsAttached guard.
 * Thread content is preserved across minimize/maximize cycles; only logout
 * explicitly resets the thread.
 */

"use strict";

window.BubbleSidebar = (function () {
  let currentState = "expanded"; // "pill" | "preview" | "expanded"
  let islandCard = null;
  let currentSelection = null;
  let _eventsAttached = false; // Idempotency guard — prevents duplicate listeners

  /**
   * Safe wrapper for chrome.runtime.sendMessage that catches context invalidation,
   * idle background worker disconnections, and runtime errors cleanly.
   */
  function safeSendMessage(payload) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
        resolve({ error: "Extension context invalidated. Please refresh the page." });
        return;
      }

      try {
        chrome.runtime.sendMessage(payload, (response) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            const errMsg = lastErr.message || "Connection lost";
            if (errMsg.includes("invalidated")) {
              resolve({ error: "Extension context invalidated. Please refresh the page." });
            } else if (errMsg.includes("Could not establish connection") || errMsg.includes("receiving end does not exist")) {
              // MV3 service worker woke up — retry once after 400ms
              setTimeout(() => {
                try {
                  chrome.runtime.sendMessage(payload, (retryResp) => {
                    const retryErr = chrome.runtime.lastError;
                    if (retryErr || !retryResp) {
                      resolve({ error: "Bubble is reconnecting — please try again in a moment." });
                    } else {
                      resolve(retryResp);
                    }
                  });
                } catch (e2) {
                  resolve({ error: "Bubble is reconnecting — please try again in a moment." });
                }
              }, 400);
            } else {
              resolve({ error: "Connection to Bubble lost — try reopening the panel." });
            }
          } else if (!response) {
            resolve({ error: "No response received from background service worker." });
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        const msg = (err && err.message) || String(err);
        if (msg.includes("invalidated") || msg.includes("sendMessage") || msg.includes("undefined")) {
          resolve({ error: "Extension context invalidated. Please refresh the page." });
        } else {
          resolve({ error: "Connection to Bubble lost — try reopening the panel." });
        }
      }
    });
  }

  /**
   * init() is idempotent — safe to call on every "show sidebar" transition.
   * Event listeners are only wired once; subsequent calls only refresh the card ref.
   */
  function init() {
    islandCard = document.getElementById("islandCard");
    if (!islandCard) return;

    if (!_eventsAttached) {
      setupEvents();
      _eventsAttached = true;
    }

    // Always switch to expanded view when sidebar is first shown.
    switchState("expanded");
    // Fetch current page selection on every sidebar show, not only on first attach.
    post({ type: "get-selection" }); // BUG-02 fix — moved from setupEvents()
  }

  function setupEvents() {
    const askBtn = document.getElementById("askBtn");
    const clearSelBtn = document.getElementById("clearSelBtn");
    const collapsePillBtn = document.getElementById("collapsePillBtn");
    const expandBtn = document.getElementById("expandBtn");
    const islandPillView = document.getElementById("islandPillView");
    const islandPreviewView = document.getElementById("islandPreviewView");

    // Click pill or preview to expand to full thread view
    if (islandPillView) {
      islandPillView.addEventListener("click", () => switchState("expanded"));
    }
    if (islandPreviewView) {
      islandPreviewView.addEventListener("click", () => switchState("expanded"));
    }

    const dismissBtn = document.getElementById("dismissBtn");
    if (dismissBtn) {
      dismissBtn.addEventListener("click", () => post({ type: "dismiss" }));
    }

    // Collapse button in expanded view → shrink to pill
    if (collapsePillBtn) {
      collapsePillBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        switchState("pill");
      });
    }

    // Expand button in pill view → restore to expanded (minimize/maximize)
    if (expandBtn) {
      expandBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        switchState("expanded");
      });
    }

    if (askBtn) askBtn.addEventListener("click", handleAsk);
    if (clearSelBtn) clearSelBtn.addEventListener("click", clearSelection);

    // Listen for messages from content script (selection, open triggers)
    window.addEventListener("message", (event) => {
      const d = event.data;
      if (!d || d.__bubble !== true) return;
      if (d.type === "selection" || d.type === "selection-changed") {
        setSelection(d.selection);
      }
      // Note: trigger-boot is handled exclusively in boot-animation.js
      // We do NOT call startFlow() here to avoid double-booting on reopen
    });

    // NOTE: get-selection is posted in init() on every open, not here.
  }

  function switchState(state, textPreview = "") {
    currentState = state;

    const pillView = document.getElementById("islandPillView");
    const previewView = document.getElementById("islandPreviewView");
    const expandedView = document.getElementById("islandExpandedView");

    if (pillView) pillView.classList.toggle("hidden", state !== "pill");
    if (previewView) previewView.classList.toggle("hidden", state !== "preview");
    if (expandedView) expandedView.classList.toggle("hidden", state !== "expanded");

    if (state === "preview" && textPreview) {
      const pText = document.getElementById("previewText");
      if (pText) pText.textContent = textPreview;
    }

    updateDimensions();
  }

  function updateDimensions() {
    // BUG-16: .island-card fills the iframe via CSS (width:100%; height:100%).
    // The iframe is the single sized/animated element — we only tell content.js
    // what state to animate to; no direct style writes happen here.
    let w, h, radius;
    if (currentState === "pill") {
      w = 160; h = 48; radius = 14;
    } else if (currentState === "preview") {
      w = 280; h = 72; radius = 14;
    } else {
      // Expanded sidebar — content.js will use calculateResponsiveBounds()
      // to determine the actual clamped width; w here is the design maximum.
      w = 380; h = window.innerHeight; radius = 0;
    }
    post({
      type: "update-island-bounds",
      width: w,
      height: h,
      radius: radius,
      state: currentState,
    });
  }

  function setSelection(sel) {
    currentSelection = sel;
    const selectionBox = document.getElementById("selectionBox");
    const selectionText = document.getElementById("selectionText");
    const askBtn = document.getElementById("askBtn");

    if (sel && sel.text) {
      if (selectionText) selectionText.textContent = sel.text;
      if (selectionBox) selectionBox.classList.remove("hidden");
      if (askBtn) {
        askBtn.disabled = false;
        askBtn.textContent = "Ask";
      }
      // If in pill or preview state, transition to preview or expanded state
      if (currentState === "pill") {
        switchState("preview", `Selected: "${sel.text.slice(0, 30)}…"`);
      } else if (currentState === "expanded") {
        updateDimensions();
      }
    } else {
      if (selectionBox) selectionBox.classList.add("hidden");
      if (askBtn) {
        askBtn.disabled = true;
        askBtn.textContent = "Select text";
      }
    }
  }

  function clearSelection() {
    setSelection(null);
  }

  async function handleAsk() {
    if (!currentSelection || !currentSelection.text) return;
    const mode = document.getElementById("modeSelect")?.value || "explain";
    const statusEl = document.getElementById("status");

    if (statusEl) statusEl.textContent = "Thinking…";
    switchState("preview", "Reading page & computing response…");

    const resp = await safeSendMessage({
      type: "chat",
      selectedText: currentSelection.text,
      mode,
    });

    if (resp.error) {
      switchState("expanded");
      if (resp.status === 401 || (typeof resp.error === "string" && resp.error.includes("401"))) {
        if (window.BubbleBoot && typeof window.BubbleBoot.logout === "function") {
          window.BubbleBoot.logout();
          return;
        }
      }
      appendMessage("AI", "⚠ " + resp.error);
      if (statusEl) statusEl.textContent = "Error occurred";
      return;
    }

    appendMessage("User", currentSelection.text);
    appendMessage("AI", resp.text, resp.providerUsed);

    switchState("expanded");
    if (statusEl) statusEl.textContent = "Answered via " + (resp.providerUsed || "Router");
  }

  /**
   * resetState() is called ONLY on explicit logout.
   * It clears the thread and selection so the next user session starts fresh.
   * Minimize/maximize DOES NOT call this — thread content is preserved.
   */
  function resetState() {
    clearSelection();
    const thread = document.getElementById("chatThread");
    if (thread) {
      thread.innerHTML = `
        <div style="padding:12px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.05); border-radius:12px; font-family:var(--font-mono); font-size:12px; color:#d4d4d4;">
          Welcome to Bubble AI! Highlight text on any page to explain or generate study notes.
        </div>
      `;
    }
    // BUG-02 fix: do NOT reset _eventsAttached — the DOM and listeners persist
    // across logout/reopen cycles.  Only the data (thread, selection) is cleared.
    // Resetting the guard caused duplicate listeners to stack on each reopen.
    islandCard = null;
  }

  function appendMessage(role, text, provider) {
    const thread = document.getElementById("chatThread");
    if (!thread) return;

    const div = document.createElement("div");
    const isUser = role === "User";
    Object.assign(div.style, {
      padding: "12px",
      borderRadius: "12px",
      marginBottom: "8px",
      fontSize: "12px",
      fontFamily: "var(--font-mono)",
      lineHeight: "1.6",
      background: isUser ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.05)",
      color: isUser ? "#ffffff" : "#e5e5e5",
      border: isUser ? "1px solid rgba(255,255,255,0.15)" : "1px solid rgba(255,255,255,0.05)",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      fontSize: "10px",
      color: "#a3a3a3",
      marginBottom: "6px",
      fontWeight: "700",
    });
    header.innerHTML = `<span>${escapeHtml(role)}</span>${provider ? `<span style="color:#34d399;font-weight:400;">via ${escapeHtml(provider)}</span>` : ""}`;

    const body = document.createElement("div");
    body.textContent = text;

    div.appendChild(header);
    div.appendChild(body);
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
    updateDimensions();
  }

  function escapeHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function post(msg) {
    if (window.parent) {
      try {
        window.parent.postMessage(Object.assign({ __bubble: true }, msg), "*");
      } catch (e) {}
    }
  }

  return {
    init,
    switchState,
    updateDimensions,
    resetState,
  };
})();
