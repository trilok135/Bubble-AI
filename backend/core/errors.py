from typing import Any, Dict, Optional
from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

class ErrorDetail(BaseModel):
    code: str
    message: str
    request_id: Optional[str] = None
    details: Optional[Dict[str, Any]] = None

class ErrorResponse(BaseModel):
    error: ErrorDetail

class BubbleError(Exception):
    """Base exception for Bubble AI."""
    def __init__(self, message: str, code: str = "internal_error", status_code: int = 500, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code
        self.details = details

class AuthError(BubbleError):
    def __init__(self, message: str = "Authentication failed", details: Optional[Dict[str, Any]] = None):
        super().__init__(message, code="auth_error", status_code=401, details=details)

class RateLimitError(BubbleError):
    def __init__(self, message: str = "Rate limit exceeded", details: Optional[Dict[str, Any]] = None):
        super().__init__(message, code="rate_limit_exceeded", status_code=429, details=details)

class InvalidRequestError(BubbleError):
    def __init__(self, message: str = "Invalid request", details: Optional[Dict[str, Any]] = None):
        super().__init__(message, code="invalid_request", status_code=400, details=details)

class ProviderError(BubbleError):
    def __init__(self, message: str = "AI Provider error", details: Optional[Dict[str, Any]] = None):
        super().__init__(message, code="provider_error", status_code=502, details=details)


# ---------- Authentication error contract ----------
# Codes are stable identifiers clients (extension + web) branch on.
# Never leak internal verification details (JWKS URLs, claim values, etc.).

class GoogleTokenError(BubbleError):
    """Google ID token failed verification (signature/issuer/audience/expiry)."""
    def __init__(self, code: str = "INVALID_GOOGLE_TOKEN", message: str = "The Google authentication credential is invalid."):
        super().__init__(message, code=code, status_code=401)

class AuthRequiredError(BubbleError):
    def __init__(self, message: str = "Authentication required."):
        super().__init__(message, code="AUTH_REQUIRED", status_code=401)

class SessionInvalidError(BubbleError):
    """Session token missing/unknown/expired — client should sign in again."""
    def __init__(self, message: str = "Session is invalid or has expired.", code: str = "SESSION_INVALID"):
        super().__init__(message, code=code, status_code=401)

class AccountConflictError(BubbleError):
    """Identity maps to an account the caller cannot claim (e.g. verified email
    belongs to a different Bubble AI user). Requires explicit linking flow."""
    def __init__(self, message: str = "An account with this email already exists. Sign in with the original provider to link Google."):
        super().__init__(message, code="ACCOUNT_CONFLICT", status_code=409)

class OwnershipError(BubbleError):
    """Authenticated user tried to access a resource they do not own."""
    def __init__(self, message: str = "Resource not found."):
        # Deliberately 404, not 403: do not reveal other users' resource ids exist.
        super().__init__(message, code="RESOURCE_NOT_FOUND", status_code=404)

async def bubble_error_handler(request: Request, exc: BubbleError) -> JSONResponse:
    request_id = request.headers.get("X-Request-ID")
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(
            error=ErrorDetail(
                code=exc.code,
                message=exc.message,
                request_id=request_id,
                details=exc.details
            )
        ).model_dump()
    )

def setup_exception_handlers(app):
    app.add_exception_handler(BubbleError, bubble_error_handler)
