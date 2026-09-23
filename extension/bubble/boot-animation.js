/**
 * Bubble AI — Boot Engine & Auth Router
 *
 * Implements Stage 1 (ASCII Boot sequence), Stage 2 (Auth Branching & Validity Check),
 * Stage 3 (Revised Login Screen - Plain Single Card), Stage 4 (Post-Login Sidebar & Logout).
 */

"use strict";

window.BubbleBoot = (function() {
  // Explicit setting for boot animation replay behavior: 'every-open' | 'once-per-session' | 'once-ever'
  const BOOT_REPLAY_MODE = 'every-open';
  const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days default TTL

  const rampChars = " .:-=+*#%@";
  const cols = 42, rows = 22;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const bubbles = [
    { cx: cols * 0.32, cy: rows * 0.42, delay: 0.00, target: 4.2, dur: 1.05 },
    { cx: cols * 0.65, cy: rows * 0.30, delay: 0.18, target: 3.2, dur: 1.05 },
    { cx: cols * 0.50, cy: rows * 0.64, delay: 0.34, target: 4.8, dur: 1.05 }
  ];

  const growEnd = Math.max(...bubbles.map(b => b.delay + b.dur)); // ~1.4s
  const popDur = 0.55;
  const popEnd = growEnd + popDur;       // ~1.95s
  const nameAt = popEnd + 0.12;          // ~2.07s
  const nameHold = 0.95;
  const chatAt = nameAt + nameHold;      // ~3.02s
  const typingDur = 0.95;
  const totalDur = chatAt + typingDur + 0.4; // ~4.37s

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function frameAt(t) {
    const grid = new Array(cols * rows).fill(' ');
    const aspect = 2.05;

    bubbles.forEach(b => {
      const localT = Math.min(Math.max((t - b.delay) / b.dur, 0), 1);
      if (localT <= 0) return;
      let radius, ringWidth, alpha;
      if (t <= growEnd) {
        radius = b.target * easeOutCubic(localT);
        ringWidth = 0.9;
        alpha = 1;
      } else {
        const popT = Math.min((t - growEnd) / popDur, 1);
        radius = b.target * (1 + popT * 1.9);
        ringWidth = 0.9 + popT * 3.2;
        alpha = Math.max(0, 1 - popT * 1.15);
      }
      if (alpha <= 0) return;
      const minX = Math.max(0, Math.floor(b.cx - radius - ringWidth - 2));
      const maxX = Math.min(cols - 1, Math.ceil(b.cx + radius + ringWidth + 2));
      const minY = Math.max(0, Math.floor(b.cy - (radius + ringWidth + 2) / aspect));
      const maxY = Math.min(rows - 1, Math.ceil(b.cy + (radius + ringWidth + 2) / aspect));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const dx = x - b.cx;
          const dy = (y - b.cy) * aspect;
          const d = Math.sqrt(dx * dx + dy * dy);
          const distFromRing = Math.abs(d - radius);
          if (distFromRing < ringWidth) {
            if (t > growEnd) {
              const popT = (t - growEnd) / popDur;
              if (Math.random() < popT * 0.9) continue;
            }
            const intensity = (1 - distFromRing / ringWidth) * alpha;
            const idx = Math.min(rampChars.length - 1, Math.max(0, Math.round(intensity * (rampChars.length - 1))));
            const ch = rampChars[idx];
            const gi = y * cols + x;
            if (ch !== ' ' && grid[gi] === ' ') grid[gi] = ch;
          }
          if (t <= growEnd) {
            const hx = dx + radius * 0.35, hy = dy + radius * 0.35;
            const hd = Math.sqrt(hx * hx + hy * hy);
            if (hd < radius * 0.32 && Math.random() < 0.02) {
              const gi = y * cols + x;
              if (grid[gi] === ' ') grid[gi] = '.';
            }
          }
        }
      }
    });

    let out = '';
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) out += grid[y * cols + x];
      out += '\n';
    }
    return out;
  }

  let rafId = null;
  let _bootRunning = false; // Guard: prevents double-boot on rapid reopen

  function runSequence(onComplete) {
    const overlay = document.getElementById('boot-overlay');
    const pre = document.getElementById('asciiBoot');
    const nameEl = document.getElementById('bootName');
    const chatEl = document.getElementById('bootChat');

    if (!overlay || !pre || !nameEl || !chatEl) {
      if (onComplete) onComplete();
      return;
    }

    // Cancel any in-flight animation before starting a fresh one
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    _bootRunning = true;

    console.log("[Bubble Boot] Boot sequence started.");
    overlay.style.display = "flex";
    overlay.style.visibility = "visible";
    overlay.style.opacity = "1";
    overlay.classList.add('is-active');

    nameEl.classList.remove('show');
    chatEl.classList.remove('show');
    const bootMsg = document.getElementById('bootMsg');
    const bootTyping = document.getElementById('bootTyping');
    if (bootMsg) bootMsg.classList.add('hidden');
    if (bootTyping) bootTyping.style.display = 'flex';

    notifyHost("boot");

    if (reduced) {
      pre.textContent = '';
      nameEl.classList.add('show');
      setTimeout(() => {
        chatEl.classList.add('show');
        setTimeout(() => {
          if (bootTyping) bootTyping.style.display = 'none';
          if (bootMsg) bootMsg.classList.remove('hidden');
          setTimeout(() => {
            overlay.classList.remove('is-active');
            overlay.style.display = "none";
            _bootRunning = false;
            if (onComplete) onComplete();
          }, 400);
        }, 300);
      }, 300);
      return;
    }

    const start = performance.now();
    function tick(now) {
      const t = (now - start) / 1000;
      if (t <= popEnd + 0.05) {
        pre.textContent = frameAt(t);
      } else if (pre.textContent !== '') {
        pre.textContent = '';
      }
      if (t >= nameAt) nameEl.classList.add('show');
      if (t >= chatAt) chatEl.classList.add('show');
      if (t >= chatAt + typingDur) {
        if (bootTyping) bootTyping.style.display = 'none';
        if (bootMsg) bootMsg.classList.remove('hidden');
      }

      if (t < totalDur) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = null;
        _bootRunning = false;
        overlay.classList.remove('is-active');
        overlay.style.display = "none";
        console.log("[Bubble Boot] Boot sequence completed.");
        setTimeout(() => {
          if (onComplete) onComplete();
        }, 300);
      }
    }
    rafId = requestAnimationFrame(tick);
  }


  function notifyHost(type, extra = {}) {
    if (window.parent) {
      try {
        window.parent.postMessage(Object.assign({ __bubble: true, state: type }, extra), '*');
      } catch (e) {}
    }
  }

  /**
   * Fix 1: Session Validity Check (safely handles context invalidation & storage errors).
   * Checks stored expires_at timestamp against Date.now(). Expired or missing -> returns null.
   */
  async function checkAuthSession() {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome || !chrome.storage || !chrome.storage.local) {
        resolve(null);
        return;
      }
      try {
        chrome.storage.local.get("bubble_user", (data) => {
          const lastErr = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError;
          if (lastErr) {
            console.warn("[Bubble Auth] Storage read error or context invalidated:", lastErr.message);
            resolve(null);
            return;
          }
          const user = data ? data.bubble_user : null;
          if (!user || typeof user !== "object") {
            resolve(null);
            return;
          }

          const expiresAt = user.expires_at;
          if (!expiresAt || typeof expiresAt !== "number" || Date.now() > expiresAt) {
            try {
              chrome.storage.local.remove(["bubble_user", "active_session_id"]);
            } catch (e) {}
            resolve(null);
            return;
          }

          resolve(user);
        });
      } catch (err) {
        console.warn("[Bubble Auth] Exception checking session:", err);
        resolve(null);
      }
    });
  }

  /**
   * Order of Operations on Open:
   * 1. Boot animation plays per BOOT_REPLAY_MODE ('every-open' by default).
   * 2. Immediately after boot finishes, run validity check.
   * 3. Valid unexpired session -> sidebar. Invalid/expired -> login screen.
   */
  async function startFlow() {
    if (BOOT_REPLAY_MODE === 'every-open') {
      runSequence(async () => {
        const user = await checkAuthSession();
        if (user) {
          showSidebar();
        } else {
          showLoginScreen();
        }
      });
    } else {
      const user = await checkAuthSession();
      if (user) {
        showSidebar();
      } else {
        runSequence(async () => {
          showLoginScreen();
        });
      }
    }
  }

  function showLoginScreen() {
    notifyHost("login");
    document.body.classList.remove("in-sidebar");
    const login = document.getElementById("signin-screen");
    const sidebar = document.getElementById("sidebar-container");
    if (login) {
      login.style.opacity = "1";
      login.classList.remove("hidden");
    }
    if (sidebar) sidebar.classList.add("hidden");
  }

  function showSidebar() {
    notifyHost("sidebar");
    document.body.classList.add("in-sidebar");
    const login = document.getElementById("signin-screen");
    const sidebar = document.getElementById("sidebar-container");
    if (login) login.classList.add("hidden");
    if (sidebar) sidebar.classList.remove("hidden");

    if (window.BubbleSidebar) {
      window.BubbleSidebar.init();
    }
  }

  /**
   * Completes login UI transition. The real session (bubble_auth + bubble_user)
   * was already persisted by the background AuthManager — we only mirror the
   * display profile here when it is not already present, then boot the sidebar.
   */
  async function handleLoginSuccess(email, providerName = "Email", user = null) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      try {
        const data = await chrome.storage.local.get("bubble_user");
        if (!data || !data.bubble_user) {
          // Fallback for providers whose flow did not persist via AuthManager.
          const expiresAt = Date.now() + DEFAULT_SESSION_TTL_MS;
          await chrome.storage.local.set({
            bubble_user: { email, provider: providerName, ts: Date.now(), expires_at: expiresAt },
          });
        }
      } catch (e) {
        console.warn("[Bubble Auth] Storage warning:", e);
      }
    }

    const login = document.getElementById("signin-screen");
    if (login) login.classList.add("hidden");
    const errEl = document.getElementById("bubble-auth-error");
    if (errEl) errEl.remove();

    console.log(`[Bubble Auth] Login successful via ${providerName}. Running boot animation...`);
    runSequence(() => {
      showSidebar();
    });
  }

  /**
   * Fix 2: Manual Logout Action
   * Clears token & expiry from chrome.storage.local, resets auth state,
   * and immediately transitions to the login screen without boot replay.
   */
  async function logout() {
    // Ask the AuthManager to revoke the Bubble session server-side, then the
    // local state clear happens in the same handler. Google account sign-out
    // is deliberately NOT performed here (separate concerns).
    try {
      await safeSendMessage({ type: "auth-logout" });
    } catch (e) {}
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      try {
        await chrome.storage.local.remove(["bubble_user", "bubble_auth", "active_session_id"]);
      } catch (e) {}
    }
    if (window.BubbleSidebar && typeof window.BubbleSidebar.resetState === "function") {
      window.BubbleSidebar.resetState();
    }
    showLoginScreen();
  }

  function setupOAuthHandlers() {
    const oauthBtns = document.querySelectorAll(".oauth-btn");
    oauthBtns.forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const isGoogle = btn.textContent.includes("Google");
        const providerName = isGoogle ? "Google" : "GitHub";

        btn.style.opacity = "0.75";
        btn.innerHTML = `<span style="font-family:var(--font-mono); font-size:11px;">Signing in with ${providerName}…</span>`;

        try {
          // Auth is owned by the background service worker's AuthManager.
          const resp = await safeSendMessage({ type: isGoogle ? "auth-google-signin" : "auth-github-signin" });
          if (resp && resp.error) throw new Error(resp.error);
          const email = (resp && resp.user && resp.user.email) || `${isGoogle ? "google" : "github"}_user@bubble.ai`;
          await handleLoginSuccess(email, providerName, resp && resp.user);
        } catch (err) {
          console.error(`[Bubble Auth] ${providerName} sign-in failed:`, err.message);
          showAuthError(`${providerName} sign-in failed: ${err.message}`);
        } finally {
          btn.style.opacity = "1";
          btn.innerHTML = `<span>Sign in with ${providerName}</span>`;
        }
      });
    });
  }

  function safeSendMessage(payload) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
        resolve({ error: "Extension context unavailable. Open Bubble from the extension icon." });
        return;
      }
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) { resolve({ error: lastErr.message }); return; }
          resolve(response || { error: "No response from background worker" });
        });
      } catch (e) {
        resolve({ error: e.message });
      }
    });
  }

  function showAuthError(message) {
    const login = document.getElementById("signin-screen");
    if (!login) return;
    let errEl = document.getElementById("bubble-auth-error");
    if (!errEl) {
      errEl = document.createElement("div");
      errEl.id = "bubble-auth-error";
      errEl.style.cssText = "font-family:var(--font-mono); font-size:11px; color:#dc2626; margin-top:8px; word-break:break-word;";
      const container = login.querySelector(".oauth-container");
      if (container) container.insertAdjacentElement("afterend", errEl);
      else login.appendChild(errEl);
    }
    errEl.textContent = message;
  }

  document.addEventListener("DOMContentLoaded", () => {
    const signinForm = document.getElementById("signinForm");
    if (signinForm) {
      signinForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = document.getElementById("email")?.value || "user@bubble.ai";
        await handleLoginSuccess(email, "Email");
      });
    }

    setupOAuthHandlers();

    // Connect logout button in sidebar header
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        logout();
      });
    }

    // Connect FAB View click handler inside idle 44x44 state
    const fabView = document.getElementById("fabView");
    if (fabView) {
      fabView.addEventListener("click", (e) => {
        e.stopPropagation(); // BUG-04: prevent click from bubbling to the body handler below,
                             // which would send a second notifyHost("open") in the same tick.
        notifyHost("open");
      });
    }

    document.body.addEventListener("click", (e) => {
      if (!document.body.classList.contains("is-open")) {
        notifyHost("open");
      }
    });

    // Listen for host messages controlling open/closed DOM states
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.__bubble !== true) return;

      if (data.type === "state-expanding") {
        document.body.classList.add("is-open");
      } else if (data.type === "state-closed") {
        document.body.classList.remove("is-open");
        // BUG-03: cancel any in-flight boot RAF before resetting the guard.
        // Without this, a stale animation frame from an aborted cycle could
        // call its onComplete callback into the wrong lifecycle stage.
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        _bootRunning = false;
      } else if (data.type === "trigger-boot") {
        // Only start flow if we aren't already open/running
        // This prevents double-boot on rapid reopen or mid-animation triggers
        if (!_bootRunning) {
          document.body.classList.add("is-open");
          startFlow();
        } else {
          console.log("[Bubble Boot] trigger-boot ignored — already running.");
          document.body.classList.add("is-open");
        }
      }
    });
  });

  return {
    startFlow,
    runSequence,
    checkAuthSession,
    showLoginScreen,
    showSidebar,
    logout,
  };
})();
