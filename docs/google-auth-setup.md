# Google Authentication — Setup & Architecture

Complete guide for Google sign-in in Bubble AI (web + Chrome extension), built on the
existing `/api/v1/auth` router and session architecture.

---

## 1. Architecture Overview

```
                GOOGLE (accounts.google.com)
                        │  ID token (JWT, RS256)
                        ▼
        ┌──────────────────────────────────┐
        │ POST /api/v1/auth/google         │
        │  1. Verify signature (JWKS)      │
        │  2. Verify issuer + audience     │
        │  3. Verify expiration            │
        │  4. Extract verified sub/email   │
        └──────────────┬───────────────────┘
                       ▼
        ┌──────────────────────────────────┐
        │ users / auth_identities          │
        │  find-or-create Bubble AI user   │
        └──────────────┬───────────────────┘
                       ▼
        ┌──────────────────────────────────┐
        │ app_sessions (Bearer token)      │
        └──────────────┬───────────────────┘
                       ▼
     /api/v1/chat · /conversations · /memory · /profile   (user-scoped)
```

- **Google is only the identity provider.** Bubble AI owns the application identity
  (`users.id`), sessions, conversations, memory, and personalization.
- One identity works across web and extension: both exchange a Google ID token for the
  same kind of Bubble AI session, tied to the same `users` row.
- Sessions are independent of Google: requests carry `Authorization: Bearer <bubble-session>`,
  never the Google token.

---

## 2. Google Cloud Console configuration

1. **Create/select a project** at <https://console.cloud.google.com>.
2. **OAuth consent screen** (APIs & Services → OAuth consent screen):
   - User type: External (or Internal for Workspace).
   - App name: `Bubble AI`; add support email; scopes `openid`, `email`, `profile`.
   - Add test users while the app is in *Testing* mode.
3. **Create OAuth client ID** (APIs & Services → Credentials → Create credentials):
   - **Application type: Web application** — this single client serves both the web
     login page and the Chrome extension flow used here.
     - **Authorized JavaScript origins**:
       - `http://localhost:8000` (development web page)
       - `https://your-domain.com` (production)
     - **Authorized redirect URIs**:
       - `https://<EXTENSION-ID>.chromiumapp.org/` — the value printed by
         `chrome.identity.getRedirectURL()` in the extension. Required because the
         extension uses `launchWebAuthFlow`, which redirects to that host.
   - *Optional alternative:* a separate **Chrome app** client type with the extension
     ID. Not required for this implementation.
4. Copy the **Client ID** (looks like `1234567890-abcdef.apps.googleusercontent.com`).
   It is public, but keep configuration centralized.

### Configure the values

| Where | Value |
|---|---|
| `backend/.env` / environment | `GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID` |
| `extension/manifest.json` | `"oauth2": { "client_id": "YOUR_GOOGLE_CLIENT_ID", ... }` (optional; backend `/auth/config` is the primary source) |
| Production env | `CORS_ORIGINS=https://your-domain.com,chrome-extension://YOUR_EXTENSION_ID` |
| Production env | `BUBBLE_ADMIN_EMAILS=you@your-domain.com` |

Never put client *secrets*, AI provider keys, or signing keys in the extension or any
browser-visible code.

---

## 3. Backend endpoints (existing paths, completed)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/auth/google` | Body `{"credential": "<GOOGLE_ID_TOKEN>"}` (legacy `{"token": ...}` accepted). Verifies, find-or-creates user, returns `{authenticated, session_token, expires_at, user}`. |
| `GET /api/v1/auth/me` | Session restore. Bearer token → `{authenticated: true, user}`. |
| `POST /api/v1/auth/logout` | Revokes the Bubble session (Google sign-out is a separate client concern). |
| `GET /api/v1/auth/config` | Public, non-secret: `{google_client_id, session_ttl_seconds}` for login pages. |
| `POST /api/v1/auth/session` | Legacy anonymous bootstrap (kept for compatibility). |
| `POST /api/v1/auth/github` | Unchanged externally; now creates/links real identities. |

Error contract (JSON, consistent codes):

```json
{ "error": { "code": "INVALID_GOOGLE_TOKEN", "message": "The Google authentication credential is invalid." } }
```

Codes: `INVALID_GOOGLE_TOKEN`, `GOOGLE_TOKEN_EXPIRED`, `GOOGLE_AUDIENCE_MISMATCH`,
`GOOGLE_ISSUER_INVALID`, `AUTH_REQUIRED`, `SESSION_INVALID`, `SESSION_EXPIRED`,
`ACCOUNT_CONFLICT`, `RESOURCE_NOT_FOUND`.

---

## 4. Database schema

New tables (created idempotently by `init_db()`; existing dev data is untouched):

```sql
users             (id, email UNIQUE, name, picture, created_at, last_login)
auth_identities   (id, user_id → users, provider, provider_subject, created_at,
                   UNIQUE(provider, provider_subject))
app_sessions      (id, token_hash UNIQUE, user_id → users, created_at, expires_at, revoked)
```

- `sessions` (chat sessions) gained `user_id` — every conversation is owned.
- `app_sessions` stores **SHA-256 hashes** of session tokens only.
- Identity key = `provider_subject` (Google's stable `sub`), never name or email.
- Email-based auto-linking is **refused** (`ACCOUNT_CONFLICT`, 409) when the verified
  email already belongs to a different account — no silent account merging.

---

## 5. Web login page

Served at **`GET /login`** (backend/static/login.html):

- Google **One Tap** (`google.accounts.id.prompt()`, FedCM-backed) — convenience path.
- Official **Sign in with Google** button (`renderButton`) — fallback path.
- The client ID is fetched from `/api/v1/auth/config`; no secrets in the page.
- Google's rendered UI is never styled, overlaid, or hidden.
- On success the Bubble session is stored in `localStorage.bubble_auth` (web equivalent
  of the extension's `chrome.storage.local`), and `/api/v1/auth/me` restores it.

---

## 6. Chrome extension

```
Popup / Bubble UI            Background service worker            Backend
─────────────────            ──────────────────────────           ────────
auth-google-signin  ───────►  AuthManager.signInWithGoogle()
                              chrome.identity.launchWebAuthFlow ──► accounts.google.com
                              (nonce check, id_token)              │
                              POST /api/v1/auth/google ───────────► verify + session
chrome.storage.local ◄──────  bubble_auth {session_token, expiry}  │
authedFetch('/api/v1/...') ─►  Authorization: Bearer <session> ───► user-scoped data
```

- The bubble UI/popup never touches Google or the backend directly for auth; they send
  `chrome.runtime` messages to the service worker (`auth-manager.js`).
- Stored: session token, expiry, minimal profile. Never secrets.
- Expired/401 responses clear the session and surface `SESSION_EXPIRED` → UI shows
  sign-in again (no infinite retries).
- Logout: `auth-logout` → server revocation + local clear.
- The previous mock-login fallback (fake session on backend failure) was **removed** —
  failures now show an inline error instead of pretending to be signed in.

---

## 7. Security notes

- **Server-side verification only**: RS256 signature via Google JWKS (PyJWT `PyJWKClient`),
  issuer `https://accounts.google.com`, audience = `GOOGLE_CLIENT_ID`, expiry with 30s
  leeway. Decoded-payload inspection never grants authentication.
- **Fail closed**: without `GOOGLE_CLIENT_ID`, `/auth/google` rejects all tokens.
- **Sessions**: random 256-bit tokens, SHA-256 at rest, TTL (default 7 days), revocable.
- **Ownership**: every chat/conversation/memory/profile query filters by `user_id`;
  foreign resources 404. Provider admin endpoints require admin in production.
- **CORS**: env-driven allowlist; development without `CORS_ORIGINS` stays permissive
  with a warning; production defaults to closed.
- **Privacy**: no message bodies logged; user-scoped deletion via `DELETE /memory`,
  `DELETE /profile`, `DELETE /conversations/{id}`.

---

## 8. Testing

```bash
python -m pytest backend/tests -q
```

- `backend/tests/test_auth.py` (22 tests) covers verification outcomes, user lifecycle,
  conflicts, sessions, logout, cross-user authorization, and persistence across re-login.
- Automated tests use `FakeGoogleVerifier` (`BUBBLE_FAKE_GOOGLE_VERIFIER=1`); no real
  Google credentials are needed and nothing real is committed.
- **Real-Google validation is a separate manual step** (below) — do not assume the flow
  works with Google until it has been run with a configured client ID.

### Manual validation with real Google credentials

```bash
# 1. Configure
#    backend/.env: GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
#    Google Cloud: add http://localhost:8000 to Authorized JavaScript origins
cd backend && uvicorn main:app --reload   # or: python -m uvicorn backend.main:app
# 2. Open http://localhost:8000/login → use One Tap or the button
# 3. Verify: GET /api/v1/auth/me with the returned token; then sign out and back in
#    and confirm the same user id and retained conversations.
```

Extension: load `extension/` unpacked, run `chrome.identity.getRedirectURL()` in the
service worker console, add that URL to the OAuth client's redirect URIs, set
`google_client_id` (storage) or the manifest `oauth2.client_id`, reload, open the bubble,
sign in.
