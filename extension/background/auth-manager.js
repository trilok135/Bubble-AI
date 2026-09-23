/**
 * Bubble AI — Authentication Manager (background service worker)
 *
 * Owns the full auth lifecycle so no other component duplicates it:
 *   popup / bubble UI  ->  chrome.runtime message  ->  THIS module  ->  Google ->  backend
 *
 * Flow (Google):
 *   1. chrome.identity.launchWebAuthFlow with response_type=id_token (OIDC implicit).
 *      The redirect URI (https://<ext-id>.chromiumapp.org/) must be registered as an
 *      Authorized redirect URI on the Web OAuth client (docs/google-auth-setup.md).
 *   2. ID token + client-side nonce check -> POST /api/v1/auth/google {credential}.
 *   3. Backend cryptographically verifies the token and returns a Bubble AI session.
 *   4. Session stored in chrome.storage.local under `bubble_auth` (plus legacy
 *      `bubble_user` for compatibility with the existing bubble UI code).
 *
 * Storage choice: chrome.storage.local — sandboxed per-extension by the browser
 * profile; content scripts and web pages cannot read it. Only the Bubble session
 * token and minimal profile (email/name/picture/expiry) are stored — never
 * client secrets or AI provider keys.
 *
 * Session expiry: every read checks expires_at; a 401 from any backend call
 * clears the session and flips state to "expired" (client shows sign-in again).
 */

"use strict";

const DEFAULT_API_BASE = "http://127.0.0.1:8000";
const AUTH_STORAGE_KEY = "bubble_auth";
const LEGACY_USER_KEY = "bubble_user"; // kept in sync for boot-animation.js compat

class AuthManager {
  constructor() {
    this._state = { status: "signed_out", user: null };
  }

  // ------------------------------------------------------------ config

  async getApiBase() {
    const data = await chrome.storage.local.get("api_base");
    return data.api_base || DEFAULT_API_BASE;
  }

  async getGoogleClientId() {
    // 1. explicit override  2. backend /auth/config  3. manifest oauth2 block
    const data = await chrome.storage.local.get("google_client_id");
    if (data.google_client_id) return data.google_client_id;
    try {
      const base = await this.getApiBase();
      const res = await fetch(`${base}/api/v1/auth/config`, { method: "GET" });
      if (res.ok) {
        const cfg = await res.json();
        if (cfg.google_client_id) return cfg.google_client_id;
      }
    } catch (_) { /* backend down — fall through */ }
    const manifest = chrome.runtime.getManifest();
    const mid = manifest.oauth2 && manifest.oauth2.client_id;
    if (mid && !mid.startsWith("<YOUR_")) return mid;
    return null;
  }

  // ------------------------------------------------------------ session state

  async _readSession() {
    const data = await chrome.storage.local.get([AUTH_STORAGE_KEY, LEGACY_USER_KEY]);
    const session = data[AUTH_STORAGE_KEY];
    if (!session || typeof session !== "object" || !session.session_token) return null;
    if (!session.expires_at || Date.now() > session.expires_at) {
      await this.clearSession();
      return null;
    }
    return session;
  }

  async clearSession() {
    await chrome.storage.local.remove([AUTH_STORAGE_KEY, LEGACY_USER_KEY, "active_session_id"]);
    this._state = { status: "signed_out", user: null };
  }

  async getState() {
    const session = await this._readSession();
    if (!session) {
      return { status: "signed_out", user: null };
    }
    // Best-effort server validation (keeps UI honest after server-side revocation).
    try {
      const base = await this.getApiBase();
      const res = await fetch(`${base}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${session.session_token}` },
      });
      if (res.status === 401) {
        await this.clearSession();
        return { status: "expired", user: null };
      }
      if (res.ok) {
        const body = await res.json();
        return { status: "signed_in", user: body.user };
      }
      // Backend reachable but erroring — trust local session rather than lock out.
      return { status: "signed_in", user: session.user };
    } catch (_) {
      // Backend unreachable (e.g. dev server stopped) — offline: trust local expiry.
      return { status: "signed_in", user: session.user };
    }
  }

  // ------------------------------------------------------------ Google sign-in

  async signInWithGoogle(interactive = true) {
    const clientId = await this.getGoogleClientId();
    if (!clientId) {
      throw Object.assign(new Error(
        "Google client ID is not configured. Set GOOGLE_CLIENT_ID on the backend (see docs/google-auth-setup.md)."
      ), { code: "AUTH_NOT_CONFIGURED" });
    }

    const redirectUri = chrome.identity.getRedirectURL();
    const nonce = crypto.randomUUID();
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "id_token");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("nonce", nonce);
    authUrl.searchParams.set("prompt", interactive ? "select_account" : "none");

    const responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl.toString(), interactive },
        (url) => {
          const err = chrome.runtime.lastError;
          if (err || !url) reject(new Error(err ? err.message : "Google sign-in was cancelled"));
          else resolve(url);
        }
      );
    });

    // ID token arrives in the URL fragment: #id_token=...
    const fragment = new URL(responseUrl).hash.substring(1);
    const params = new URLSearchParams(fragment);
    const idToken = params.get("id_token");
    if (!idToken) throw Object.assign(new Error("No ID token returned by Google."), { code: "INVALID_GOOGLE_TOKEN" });

    // Client-side CSRF check: nonce we generated must be present in the token payload.
    // Malformed tokens (not JWT-shaped) are rejected here with the same coded error.
    let payload;
    try {
      const payloadPart = idToken.split(".")[1];
      payload = JSON.parse(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")));
    } catch (_) {
      throw Object.assign(new Error("Malformed Google credential."), { code: "INVALID_GOOGLE_TOKEN" });
    }
    if (!payload || payload.nonce !== nonce) {
      throw Object.assign(new Error("Google credential failed the nonce check."), { code: "INVALID_GOOGLE_TOKEN" });
    }

    return this._exchangeIdTokenForSession(idToken, "google");
  }

  async _exchangeIdTokenForSession(idToken, provider) {
    const base = await this.getApiBase();
    const res = await fetch(`${base}/api/v1/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: idToken }),
    });

    if (!res.ok) {
      let code = "INVALID_GOOGLE_TOKEN";
      let message = `Backend authentication failed (${res.status}).`;
      try {
        const errBody = await res.json();
        if (errBody && errBody.error && errBody.error.code) { code = errBody.error.code; message = errBody.error.message; }
      } catch (_) { /* non-JSON error */ }
      throw Object.assign(new Error(message), { code, status: res.status });
    }

    return this._persistSession(await res.json(), provider);
  }

  async _persistSession(body, provider) {
    const expiresAtMs = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 7 * 24 * 3600 * 1000;
    const session = {
      session_token: body.session_token,
      expires_at: expiresAtMs,
      provider,
      user: body.user,
    };
    await chrome.storage.local.set({
      [AUTH_STORAGE_KEY]: session,
      // Legacy key consumed by bubble/boot-animation.js UI checks.
      [LEGACY_USER_KEY]: {
        email: body.user && body.user.email,
        name: body.user && body.user.name,
        provider,
        token: body.session_token,
        ts: Date.now(),
        expires_at: expiresAtMs,
      },
    });
    this._state = { status: "signed_in", user: body.user };
    return { status: "signed_in", user: body.user, expires_at: body.expires_at };
  }

  // ------------------------------------------------------------ authenticated fetch

  async signInWithGitHub(interactive = true) {
    const clientId = (await chrome.storage.local.get("github_client_id")).github_client_id || "<YOUR_GITHUB_CLIENT_ID>";
    if (!clientId || clientId.startsWith("<YOUR_")) {
      throw Object.assign(new Error("GitHub client ID is not configured (storage key: github_client_id)."), { code: "AUTH_NOT_CONFIGURED" });
    }
    const redirectUri = chrome.identity.getRedirectURL();
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user:email`;
    const responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, (url) => {
        const err = chrome.runtime.lastError;
        if (err || !url) reject(new Error(err ? err.message : "GitHub sign-in was cancelled"));
        else resolve(url);
      });
    });
    const code = new URL(responseUrl).searchParams.get("code");
    if (!code) throw Object.assign(new Error("No authorization code returned by GitHub."), { code: "INVALID_GOOGLE_TOKEN" });

    const base = await this.getApiBase();
    const res = await fetch(`${base}/api/v1/auth/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      let message = `Backend authentication failed (${res.status}).`;
      try { const b = await res.json(); if (b && b.error) message = b.error.message || message; } catch (_) {}
      throw Object.assign(new Error(message), { code: "INVALID_GOOGLE_TOKEN", status: res.status });
    }
    return this._persistSession(await res.json(), "github");
  }

  // ------------------------------------------------------------ authenticated fetch

  async authedFetch(path, options = {}) {
    const session = await this._readSession();
    if (!session) {
      throw Object.assign(new Error("Sign in required."), { code: "AUTH_REQUIRED" });
    }
    const base = await this.getApiBase();
    const res = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.session_token}`,
      },
    });
    if (res.status === 401) {
      // Bubble session expired/revoked server-side: clear and tell the client.
      await this.clearSession();
      throw Object.assign(new Error("Session expired. Please sign in again."), { code: "SESSION_EXPIRED" });
    }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch (_) { /* keep text */ }
    return { ok: res.ok, status: res.status, data };
  }

  // ------------------------------------------------------------ logout

  async logout() {
    // Best-effort server-side revocation (local state is cleared regardless).
    const session = await this._readSession();
    if (session) {
      try {
        const base = await this.getApiBase();
        await fetch(`${base}/api/v1/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.session_token}` },
        });
      } catch (_) { /* offline logout is still a logout */ }
    }
    await this.clearSession();
    return { status: "signed_out" };
  }
}

export const authManager = new AuthManager();
