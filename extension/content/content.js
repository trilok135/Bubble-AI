(() => {
  "use strict";

  const ROOT_ID  = "bubble-ai-host-root";
  const FRAME_ID = "bubble-ai-frame";

  const FIXED_MAX_WIDTH = 380;
  const MIN_HOST_WIDTH  = 320; // Minimum host width before we fall back to overlay
  const TRANSITION_MS   = 450;
  const SPRING = "cubic-bezier(0.32, 0.72, 0, 1)";

  let frame = null;
  let isOpen = false;

  /**
   * Tracks the panel's current display mode.
   *   "closed"  — FAB only (44 × 44)
   *   "login"   — full-viewport overlay (no page shrink)
   *   "pill"    — compact pill overlay  (no page shrink)
   *   "preview" — medium overlay during AI thinking (no page shrink)
   *   "sidebar" — docked sidebar (host page shrinks by panel width)
   */
  let currentMode = "closed";
  let lastSelection = null;
  let fallbackOverlayMode = false;

  /**
   * BUG-14: track the state-closed setTimeout so openPanel() can cancel
   * it if the user re-opens before the timer fires.
   */
  let pendingCloseTimerId = null;
  /** rAF handle for the page-shrink read loop. */
  let currentAnimId = null;

  const bubbleUrl = chrome.runtime.getURL("bubble/bubble.html");

  // ── Responsive bounds ──────────────────────────────────────────────────────

  function calculateResponsiveBounds() {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const panelWidth = Math.min(FIXED_MAX_WIDTH, Math.floor(viewportWidth * 0.45));
    const remainingHostWidth = viewportWidth - panelWidth;
    const shouldShrinkHost   = remainingHostWidth >= MIN_HOST_WIDTH;
    return { viewportWidth, panelWidth, remainingHostWidth, shouldShrinkHost };
  }

  // ── Host page shrink helpers ───────────────────────────────────────────────

  /**
   * Applies margin-right to html + body with 0ms transition so the
   * write tracks the rAF loop exactly (no CSS delay on top of the rAF).
   */
  function applyPageShrink(panelWidthPx) {
    const px = Math.round(panelWidthPx);
    const html = document.documentElement;
    const body = document.body;
    if (html) { html.style.transition = "margin-right 0ms"; html.style.marginRight = `${px}px`; }
    if (body) { body.style.transition = "margin-right 0ms"; body.style.marginRight = `${px}px`; }
  }

  function clearPageShrink() {
    const html = document.documentElement;
    const body = document.body;
    if (html) { html.style.marginRight = ""; html.style.transition = ""; }
    if (body) { body.style.marginRight = ""; body.style.transition = ""; }
  }

  function pageShrinkLooksBroken() {
    const html = document.documentElement;
    if (!html) return false;
    return html.scrollWidth > html.clientWidth + 4;
  }

  // ── Single-element animation engine (BUG-16 fix) ──────────────────────────

  /**
   * Sets the iframe's target geometry once and returns immediately.
   *
   * The CSS transition defined in the shadow stylesheet handles the
   * spring animation — no per-frame size writes happen here.  The iframe
   * is the single sized/animated element; .island-card inside it is a
   * passive fill (width:100%; height:100%) and has no independent
   * transition.  Two elements animated in sync will eventually drift;
   * one element structurally cannot drift from itself.
   */
  function setFrameGeometry(target) {
    if (!frame) return;
    frame.style.width        = Math.round(target.width)  + "px";
    frame.style.height       = Math.round(target.height) + "px";
    frame.style.right        = Math.round(target.right)  + "px";
    frame.style.bottom       = Math.round(target.bottom) + "px";
    frame.style.borderRadius = Math.round(target.radius) + "px";
  }

  /**
   * Reads the iframe's live rendered width on every rAF tick and mirrors
   * it to the host page's margin-right for the duration of the transition.
   *
   * This loop never writes the iframe's size — it only reads
   * getBoundingClientRect() and writes the page margin.  One element,
   * one measurement, one write per frame — page shrink cannot drift from
   * the panel's actual rendered width.
   */
  function startShrinkLoop(durationMs) {
    if (currentAnimId !== null) {
      cancelAnimationFrame(currentAnimId);
      currentAnimId = null;
    }
    const startTime = performance.now();

    function step(now) {
      const elapsed   = now - startTime;
      const liveWidth = frame ? frame.getBoundingClientRect().width : 0;
      const bounds    = calculateResponsiveBounds();

      if (isOpen && currentMode === "sidebar") {
        if (bounds.shouldShrinkHost && !fallbackOverlayMode) {
          applyPageShrink(liveWidth);
        } else {
          clearPageShrink();
        }
      } else if (!isOpen) {
        // Closing: mirror the panel shrinking back toward zero.
        if (liveWidth <= 44.5) {
          clearPageShrink();
        } else if (!fallbackOverlayMode) {
          applyPageShrink(liveWidth);
        }
      } else {
        // Open but in an overlay mode (pill / preview / login) — no shrink.
        clearPageShrink();
      }

      if (elapsed < durationMs + 50) {
        currentAnimId = requestAnimationFrame(step);
      } else {
        currentAnimId = null;
        // Final reconciliation after the CSS transition finishes.
        if (!isOpen || liveWidth <= 44.5) {
          clearPageShrink();
        } else if (currentMode === "sidebar" && pageShrinkLooksBroken()) {
          console.warn("[Bubble AI] Host page layout broke on shrink — falling back to overlay:", location.hostname);
          fallbackOverlayMode = true;
          clearPageShrink();
        }
      }
    }
    currentAnimId = requestAnimationFrame(step);
  }

  // ── Lifecycle cleanup (BUG-02/04/14 root-cause fix) ───────────────────────

  /**
   * Cancels any pending close timer or in-flight rAF before starting a
   * new open/close cycle.  Called at the top of both openPanel() and
   * closePanel().
   *
   * Root cause shared by BUG-02, BUG-04, BUG-14: artefacts from a
   * previous open/close cycle (a pending timer, a running rAF) were
   * still alive when the next cycle began, causing them to fire into the
   * wrong state.  One teardown function called at every transition entry
   * point eliminates the entire class.
   */
  function cleanupPendingTransitions() {
    if (pendingCloseTimerId !== null) {
      clearTimeout(pendingCloseTimerId);
      pendingCloseTimerId = null;
    }
    if (currentAnimId !== null) {
      cancelAnimationFrame(currentAnimId);
      currentAnimId = null;
    }
  }

  // ── DOM setup ─────────────────────────────────────────────────────────────

  function setupDOM() {
    if (document.getElementById(ROOT_ID)) return;

    const host = document.createElement("div");
    host.id = ROOT_ID;
    Object.assign(host.style, {
      position: "fixed",
      top: "0", left: "0",
      width: "0", height: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
    });

    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    // CSS transition lives here — the single source of easing for the
    // panel's open/close/state animations.  The rAF loop in startShrinkLoop
    // reads the live computed width; it never competes with this.
    style.textContent = `
      #${FRAME_ID} {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 48px;
        height: 48px;
        border-radius: 14px;
        z-index: 2147483647;
        border: none;
        background: transparent;
        display: block;
        pointer-events: auto;
        box-shadow: 0 4px 20px rgba(0,0,0,0.45);
        overflow: hidden;
        transition:
          width         ${TRANSITION_MS}ms ${SPRING},
          height        ${TRANSITION_MS}ms ${SPRING},
          border-radius ${TRANSITION_MS}ms ${SPRING},
          right         ${TRANSITION_MS}ms ${SPRING},
          bottom        ${TRANSITION_MS}ms ${SPRING};
      }
    `;
    shadow.appendChild(style);

    frame = document.createElement("iframe");
    frame.id  = FRAME_ID;
    frame.src = bubbleUrl;
    shadow.appendChild(frame);

    (document.body || document.documentElement).appendChild(host);
  }

  // ── Panel open / close ────────────────────────────────────────────────────

  function openPanel() {
    cleanupPendingTransitions(); // BUG-14: cancel any pending state-closed from a rapid close
    isOpen = true;
    sendToFrame({ type: "state-expanding" });
    sendToFrame({ type: "trigger-boot" });
  }

  function closePanel() {
    cleanupPendingTransitions();
    const wasLogin = currentMode === "login"; // BUG-06: capture before clearing
    isOpen = false;
    currentMode = "closed";
    setFrameGeometry({ width: 48, height: 48, right: 20, bottom: 20, radius: 14 });
    if (wasLogin) {
      // Login was a full-viewport overlay — host page was never shrunk, nothing to unwind.
      clearPageShrink();
    } else {
      // Mirror the panel shrinking back to 44px so the host page expands in lockstep.
      startShrinkLoop(TRANSITION_MS);
    }
    pendingCloseTimerId = setTimeout(() => {
      pendingCloseTimerId = null;
      sendToFrame({ type: "state-closed" });
    }, TRANSITION_MS);
  }

  function sendToFrame(msg) {
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(Object.assign({ __bubble: true }, msg), "*");
    } catch (e) {}
  }

  // ── Message routing ───────────────────────────────────────────────────────

  window.addEventListener("message", (event) => {
    const d = event.data;
    if (!d || d.__bubble !== true) return;

    if (d.state === "open" || d.type === "open") {
      openPanel();

    } else if (d.type === "close") {
      closePanel();

    } else if (d.state === "boot") {
      // Regression fix: "boot" stays at idle FAB size so the boot overlay
      // plays inside the 48x48 rounded square. Do not expand iframe yet.
      if (!isOpen) return;

    } else if (d.state === "login") {
      // BUG-05 fix: track login mode explicitly so the resize handler can
      // follow viewport changes while the login screen is displayed.
      if (!isOpen) return;
      currentMode = "login";
      setFrameGeometry({
        width: window.innerWidth  || 1024,
        height: window.innerHeight || 768,
        right: 0, bottom: 0, radius: 0,
      });
      clearPageShrink(); // Login is a full-viewport overlay — host page never shrinks for it.

    } else if (d.type === "update-island-bounds" || d.state === "sidebar") {
      if (!isOpen) return;
      const state = d.state || "expanded";

      if (state === "pill") {
        currentMode = "pill";
        setFrameGeometry({ width: 160, height: 48, right: 20, bottom: 20, radius: 14 });
        clearPageShrink(); // Pill is overlay.

      } else if (state === "preview") {
        currentMode = "preview";
        setFrameGeometry({ width: 280, height: 72, right: 20, bottom: 24, radius: 14 });
        clearPageShrink(); // Preview is overlay.

      } else {
        // "sidebar" | "expanded" | default — docked panel, may shrink host.
        currentMode = "sidebar";
        const bounds = calculateResponsiveBounds();
        setFrameGeometry({
          width: bounds.panelWidth,
          height: window.innerHeight || 768,
          right: 0, bottom: 0, radius: 0,
        });
        if (bounds.shouldShrinkHost && !fallbackOverlayMode) {
          startShrinkLoop(TRANSITION_MS);
        } else {
          clearPageShrink();
        }
      }

    } else if (d.type === "get-selection") {
      const sel  = window.getSelection();
      const text = sel && sel.toString().trim();
      const payload = text && text.length > 2 ? { text, url: location.href } : lastSelection;
      sendToFrame({ type: "selection", selection: payload });

    } else if (d.type === "dismiss") {
      closePanel();
    }
  });

  // ── Resize tracking ───────────────────────────────────────────────────────

  window.addEventListener("resize", () => {
    if (!isOpen) return;
    if (currentMode === "sidebar") {
      const bounds = calculateResponsiveBounds();
      setFrameGeometry({
        width: bounds.panelWidth,
        height: window.innerHeight || 768,
        right: 0, bottom: 0, radius: 0,
      });
      // Restart shrink loop to track the new panel width.
      if (bounds.shouldShrinkHost && !fallbackOverlayMode) {
        startShrinkLoop(TRANSITION_MS);
      } else {
        clearPageShrink();
      }
    } else if (currentMode === "login") {
      // BUG-05 fix: login frame tracks viewport resize.
      setFrameGeometry({
        width: window.innerWidth  || 1024,
        height: window.innerHeight || 768,
        right: 0, bottom: 0, radius: 0,
      });
    }
  });

  // ── Selection tracking ────────────────────────────────────────────────────

  document.addEventListener("mouseup", () => {
    const sel  = window.getSelection();
    const text = sel && sel.toString().trim();
    if (text && text.length > 2) {
      lastSelection = { text, url: location.href, ts: Date.now() };
      sendToFrame({ type: "selection-changed", selection: lastSelection });
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupDOM);
  } else {
    setupDOM();
  }
})();
