#!/usr/bin/env python3
"""JWT issuance, verification, and revocation for MCP vault access."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class TokenError(RuntimeError):
    pass


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _atomic_write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(payload, encoding="utf-8")
    tmp_path.replace(path)


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _canonical_json(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sign(secret: str, signing_input: bytes) -> bytes:
    return hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()


def _jwt_secret() -> str:
    secret = os.getenv("MCP_JWT_SECRET")
    if not secret:
        raise TokenError("MCP_JWT_SECRET is required")
    return secret


def _default_issuer() -> str:
    return os.getenv("MCP_JWT_ISSUER", "brAIn-mcp")


def _default_audience() -> str:
    return os.getenv("MCP_JWT_AUDIENCE", "brAIn-mcp")


def _default_revocation_path() -> Path:
    env = os.getenv("MCP_JWT_REVOCATION_PATH")
    if env:
        return Path(env)
    return Path.cwd() / "vaults" / ".mcp-jwt-revocations.json"


@dataclass(frozen=True)
class TokenClaims:
    tenant_id: str
    token_name: str
    subject: str
    scopes: tuple[str, ...]
    read_roots: tuple[str, ...]
    write_roots: tuple[str, ...]
    jwt_id: str
    issued_at: int
    expires_at: int
    issuer: str
    audience: str

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "TokenClaims":
        return cls(
            tenant_id=str(payload["tenant_id"]),
            token_name=str(payload["token_name"]),
            subject=str(payload.get("sub", "")),
            scopes=tuple(str(scope) for scope in payload.get("scopes", [])),
            read_roots=tuple(
                str(path) for path in payload.get("read_roots", payload.get("allowed_paths", []))
            ),
            write_roots=tuple(
                str(path) for path in payload.get("write_roots", payload.get("allowed_paths", []))
            ),
            jwt_id=str(payload["jti"]),
            issued_at=int(payload["iat"]),
            expires_at=int(payload["exp"]),
            issuer=str(payload.get("iss", "")),
            audience=str(payload.get("aud", "")),
        )


class TokenRevocationStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or _default_revocation_path()

    def load(self) -> dict[str, Any]:
        data = _read_json(self.path)
        revoked = data.get("revoked", {})
        if not isinstance(revoked, dict):
            raise TokenError("JWT revocation store is malformed")
        return {"revoked": revoked}

    def is_revoked(self, jwt_id: str) -> bool:
        revoked = self.load()["revoked"]
        entry = revoked.get(jwt_id)
        if not isinstance(entry, dict):
            return False
        revoked_at = int(entry.get("revoked_at", 0))
        expires_at = int(entry.get("expires_at", 0))
        if expires_at and expires_at <= int(time.time()):
            return False
        return revoked_at > 0

    def revoke(self, claims: TokenClaims, reason: str = "manual") -> None:
        data = self.load()
        revoked = data["revoked"]
        revoked[claims.jwt_id] = {
            "tenant_id": claims.tenant_id,
            "token_name": claims.token_name,
            "subject": claims.subject,
            "scopes": list(claims.scopes),
            "read_roots": list(claims.read_roots),
            "write_roots": list(claims.write_roots),
            "issued_at": claims.issued_at,
            "expires_at": claims.expires_at,
            "revoked_at": int(time.time()),
            "reason": reason,
        }
        _atomic_write(
            self.path,
            json.dumps({"revoked": revoked, "updated_at": int(time.time())}, indent=2, sort_keys=True) + "\n",
        )

    def revoke_token(self, token: str) -> None:
        claims = decode_token(token)
        self.revoke(claims)


def issue_token(
    *,
    tenant_id: str,
    token_name: str,
    subject: str,
    scopes: list[str],
    read_roots: list[str] | None = None,
    write_roots: list[str] | None = None,
    ttl_seconds: int = 60 * 60 * 24 * 365,
    audience: str | None = None,
    issuer: str | None = None,
) -> str:
    now = int(time.time())
    effective_read_roots = read_roots
    effective_write_roots = write_roots
    if effective_read_roots is None and effective_write_roots is not None:
        effective_read_roots = list(effective_write_roots)
    if effective_write_roots is None and effective_read_roots is not None:
        effective_write_roots = list(effective_read_roots)
    payload = {
        "iss": issuer or _default_issuer(),
        "aud": audience or _default_audience(),
        "sub": subject,
        "tenant_id": tenant_id,
        "token_name": token_name,
        "scopes": scopes,
        "jti": secrets.token_urlsafe(24),
        "iat": now,
        "nbf": now,
        "exp": now + ttl_seconds,
        "v": 1,
    }
    if effective_read_roots:
        payload["read_roots"] = effective_read_roots
    if effective_write_roots:
        payload["write_roots"] = effective_write_roots
    header = {"alg": "HS256", "typ": "JWT"}
    signing_input = f"{_b64url_encode(_canonical_json(header))}.{_b64url_encode(_canonical_json(payload))}".encode(
        "ascii"
    )
    signature = _sign(_jwt_secret(), signing_input)
    return f"{signing_input.decode('ascii')}.{_b64url_encode(signature)}"


def decode_token(token: str) -> TokenClaims:
    parts = token.split(".")
    if len(parts) != 3:
        raise TokenError("Malformed JWT")

    header_raw = _b64url_decode(parts[0])
    payload_raw = _b64url_decode(parts[1])
    signature_raw = _b64url_decode(parts[2])

    try:
        header = json.loads(header_raw.decode("utf-8"))
        payload = json.loads(payload_raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise TokenError("JWT payload is not valid JSON") from exc

    if header.get("alg") != "HS256":
        raise TokenError("Unsupported JWT algorithm")

    signing_input = f"{parts[0]}.{parts[1]}".encode("ascii")
    expected = _sign(_jwt_secret(), signing_input)
    if not hmac.compare_digest(expected, signature_raw):
        raise TokenError("Invalid JWT signature")

    claims = TokenClaims.from_payload(payload)
    now = int(time.time())
    if claims.issued_at > now + 60:
        raise TokenError("JWT issued in the future")
    if claims.expires_at <= now:
        raise TokenError("JWT expired")
    if payload.get("nbf") is not None and int(payload["nbf"]) > now:
        raise TokenError("JWT not yet valid")
    if claims.issuer != _default_issuer():
        raise TokenError("JWT issuer mismatch")
    if claims.audience != _default_audience():
        raise TokenError("JWT audience mismatch")
    return claims


def verify_token(token: str, revocation_path: Path | None = None) -> TokenClaims:
    claims = decode_token(token)
    revocation_store = TokenRevocationStore(revocation_path)
    if revocation_store.is_revoked(claims.jwt_id):
        raise TokenError("JWT has been revoked")
    return claims


def require_scope(claims: TokenClaims, scope: str) -> None:
    if scope not in claims.scopes:
        raise TokenError(f"JWT lacks required scope: {scope}")
