from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

from app.config import Settings, get_settings


class TokenError(ValueError):
    """Raised when an access token is malformed, expired, or untrusted."""


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding)
    except Exception as exc:
        raise TokenError("Token khong hop le") from exc


def create_access_token(user_id: str, settings: Settings | None = None) -> tuple[str, int]:
    settings = settings or get_settings()
    now = int(time.time())
    expires_in = settings.access_token_minutes * 60
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": user_id,
        "type": "access",
        "iss": settings.jwt_issuer,
        "iat": now,
        "exp": now + expires_in,
    }
    header_part = _b64url_encode(json.dumps(header, separators=(",", ":")).encode())
    payload_part = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header_part}.{payload_part}".encode("ascii")
    signature = hmac.new(settings.jwt_secret.encode(), signing_input, hashlib.sha256).digest()
    return f"{header_part}.{payload_part}.{_b64url_encode(signature)}", expires_in


def decode_access_token(token: str, settings: Settings | None = None) -> dict[str, Any]:
    settings = settings or get_settings()
    parts = token.split(".")
    if len(parts) != 3:
        raise TokenError("Token khong hop le")

    header_part, payload_part, signature_part = parts
    signing_input = f"{header_part}.{payload_part}".encode("ascii")
    expected = hmac.new(settings.jwt_secret.encode(), signing_input, hashlib.sha256).digest()
    supplied = _b64url_decode(signature_part)
    if not hmac.compare_digest(expected, supplied):
        raise TokenError("Chu ky token khong hop le")

    try:
        header = json.loads(_b64url_decode(header_part))
        payload = json.loads(_b64url_decode(payload_part))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise TokenError("Token khong hop le") from exc

    if header.get("alg") != "HS256" or header.get("typ") != "JWT":
        raise TokenError("Thuat toan token khong duoc ho tro")
    if payload.get("type") != "access" or payload.get("iss") != settings.jwt_issuer:
        raise TokenError("Token khong dung muc dich")
    if not isinstance(payload.get("sub"), str) or not payload["sub"]:
        raise TokenError("Token thieu dinh danh nguoi dung")
    if not isinstance(payload.get("exp"), int) or payload["exp"] <= int(time.time()):
        raise TokenError("Token da het han")
    return payload


def create_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
