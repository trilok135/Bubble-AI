"""Server-side Google ID token verification.

Security contract (see docs/google-auth-setup.md):
  - The browser/extension sends the Google ID token (JWT) to POST /api/v1/auth/google.
  - We NEVER trust decoded payloads: signature is verified against Google's JWKS,
    plus issuer, audience (must equal GOOGLE_CLIENT_ID) and expiration checks.
  - Only after verification is a Bubble AI account created/retrieved.

PyJWT's PyJWKClient fetches and caches Google's public keys (refreshed on unknown
kid). Verification is RS256 with issuer/audience enforced by the library.

For automated tests, `get_google_verifier()` returns a FakeGoogleVerifier when
BUBBLE_FAKE_GOOGLE_VERIFIER=1 so the suite never needs real Google credentials.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import jwt
from jwt import PyJWKClient

from backend.core.app_config import settings
from backend.core.errors import GoogleTokenError

GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")


@dataclass(frozen=True)
class GoogleIdentity:
    """Normalized identity extracted ONLY from a cryptographically verified token."""
    provider: str          # always "google"
    subject: str           # Google's stable `sub` — the identity key (never the name/email)
    email: str | None
    email_verified: bool
    name: str | None
    picture: str | None


class GoogleVerifier:
    """Verifies Google ID tokens against Google's live JWKS."""

    def __init__(self, client_id: str):
        self._client_id = client_id
        self._jwk_client = PyJWKClient(GOOGLE_JWKS_URL, lifespan=3600)

    def verify(self, id_token: str) -> GoogleIdentity:
        if not self._client_id:
            # Fail closed: without a configured audience we cannot verify tokens.
            raise GoogleTokenError(
                "GOOGLE_AUDIENCE_MISMATCH",
                "Server Google authentication is not configured.",
            )
        try:
            signing_key = self._jwk_client.get_signing_key_from_jwt(id_token)
            claims = jwt.decode(
                id_token,
                signing_key.key,
                algorithms=["RS256"],
                audience=self._client_id,   # audience mismatch -> InvalidAudienceError
                issuer=GOOGLE_ISSUERS,      # issuer mismatch      -> InvalidIssuerError
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
                leeway=30,                  # small clock-skew tolerance
            )
        except jwt.ExpiredSignatureError as exc:
            raise GoogleTokenError("GOOGLE_TOKEN_EXPIRED", "The Google credential has expired.") from exc
        except jwt.InvalidAudienceError as exc:
            raise GoogleTokenError("GOOGLE_AUDIENCE_MISMATCH", "The Google credential was issued for a different application.") from exc
        except jwt.InvalidIssuerError as exc:
            raise GoogleTokenError("GOOGLE_ISSUER_INVALID", "The Google credential has an untrusted issuer.") from exc
        except jwt.PyJWTError as exc:
            # Signature failures, malformed tokens, missing claims — one generic code.
            raise GoogleTokenError() from exc

        return GoogleIdentity(
            provider="google",
            subject=str(claims["sub"]),
            email=claims.get("email"),
            email_verified=bool(claims.get("email_verified", False)),
            name=claims.get("name"),
            picture=claims.get("picture"),
        )


class FakeGoogleVerifier:
    """Deterministic test double. Maps token strings to fixed identities.

    Token conventions in tests:
      "valid-token:<sub>:<email>[:verified]"  -> authenticated identity
      "conflict-token:<sub>:<email>"          -> identity whose email is taken
      anything else                           -> invalid (INVALID_GOOGLE_TOKEN)
    """

    def __init__(self):
        self.calls: list[str] = []

    def verify(self, id_token: str) -> GoogleIdentity:
        self.calls.append(id_token)
        if id_token.startswith("valid-token:") or id_token.startswith("conflict-token:"):
            parts = id_token.split(":")
            # ["valid-token", sub, email, ("verified" | "unverified")]
            email_verified = len(parts) < 4 or parts[3] != "unverified"
            return GoogleIdentity(
                provider="google",
                subject=parts[1],
                email=parts[2],
                email_verified=email_verified,
                name=f"Test User {parts[1]}",
                picture="https://example.com/avatar.png",
            )
        raise GoogleTokenError()


_verifier: GoogleVerifier | FakeGoogleVerifier | None = None


def get_google_verifier() -> GoogleVerifier | FakeGoogleVerifier:
    """Process-wide verifier. Swap point for tests (app.state.google_verifier)."""
    global _verifier
    if _verifier is None:
        if os.environ.get("BUBBLE_FAKE_GOOGLE_VERIFIER") == "1":
            _verifier = FakeGoogleVerifier()
        else:
            _verifier = GoogleVerifier(settings.GOOGLE_CLIENT_ID)
    return _verifier


def reset_google_verifier() -> None:
    """Reset the cached verifier (used by tests to install fakes cleanly)."""
    global _verifier
    _verifier = None
