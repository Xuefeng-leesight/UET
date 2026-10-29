from __future__ import annotations

import base64
import json
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.exceptions import InvalidSignature
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def b64decode_padded(value: str) -> bytes:
    encoded = value.strip().encode("ascii")
    return base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4))


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_private_key() -> Ed25519PrivateKey:
    configured = settings.LICENSE_SIGNING_PRIVATE_KEY.strip()
    if not configured:
        raise ImproperlyConfigured(
            "LICENSE_SIGNING_PRIVATE_KEY is required for activation and offline License issuance."
        )
    if configured.startswith("-----BEGIN"):
        loaded = serialization.load_pem_private_key(configured.encode("utf-8"), password=None)
        if not isinstance(loaded, Ed25519PrivateKey):
            raise ImproperlyConfigured("Configured signing key is not an Ed25519 private key.")
        return loaded
    try:
        return Ed25519PrivateKey.from_private_bytes(b64decode_padded(configured))
    except (ValueError, TypeError) as exc:
        raise ImproperlyConfigured(
            "LICENSE_SIGNING_PRIVATE_KEY must be a base64url 32-byte Ed25519 key or PEM."
        ) from exc


def public_key_value(private_key: Ed25519PrivateKey | None = None) -> str:
    key = (private_key or load_private_key()).public_key()
    raw = key.public_bytes(encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)
    return b64url_encode(raw)


def configured_public_key(key_id: str) -> str | None:
    if key_id == settings.LICENSE_SIGNING_KEY_ID and settings.LICENSE_SIGNING_PRIVATE_KEY:
        return public_key_value()
    value = settings.LICENSE_PUBLIC_KEYS.get(key_id)
    return str(value) if value else None


def sign_payload(payload: dict[str, Any]) -> dict[str, Any]:
    private_key = load_private_key()
    return {
        "schema_version": 1,
        "algorithm": "Ed25519",
        "key_id": settings.LICENSE_SIGNING_KEY_ID,
        "payload": payload,
        "signature": b64url_encode(private_key.sign(canonical_json(payload))),
    }


def verify_envelope(envelope: dict[str, Any], public_key: str) -> bool:
    try:
        key = Ed25519PublicKey.from_public_bytes(b64decode_padded(public_key))
        key.verify(b64decode_padded(envelope["signature"]), canonical_json(envelope["payload"]))
        return True
    except (InvalidSignature, KeyError, TypeError, ValueError):
        return False
