from __future__ import annotations

import base64
import hashlib
import re

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured, ValidationError


SOFTDOG_PASSWORD_PATTERN = re.compile(r"^[0-9A-Fa-f]{32,512}$")


def normalize_softdog_password(value: str) -> str:
    normalized = value.strip().upper()
    if not SOFTDOG_PASSWORD_PATTERN.fullmatch(normalized):
        raise ValidationError("softdog pwd 必须为 32–512 位十六进制字符串。")
    return normalized


def _fernet() -> Fernet:
    configured = settings.DEVICE_SECRET_ENCRYPTION_KEY.strip()
    if configured:
        try:
            return Fernet(configured.encode("ascii"))
        except (ValueError, TypeError) as exc:
            raise ImproperlyConfigured(
                "DEVICE_SECRET_ENCRYPTION_KEY 必须是 Fernet 兼容的 32 字节 urlsafe-base64 密钥。"
            ) from exc
    if not settings.DEBUG:
        raise ImproperlyConfigured("生产环境必须配置 DEVICE_SECRET_ENCRYPTION_KEY。")
    derived = hashlib.sha256(
        f"ust-eye-tracker-secret:{settings.SECRET_KEY}".encode("utf-8")
    ).digest()
    return Fernet(base64.urlsafe_b64encode(derived))


def encrypt_softdog_password(value: str) -> tuple[str, str]:
    normalized = normalize_softdog_password(value)
    ciphertext = _fernet().encrypt(normalized.encode("ascii")).decode("ascii")
    fingerprint = hashlib.sha256(normalized.encode("ascii")).hexdigest()
    return ciphertext, fingerprint


def decrypt_softdog_password(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode("ascii")).decode("ascii")
    except InvalidToken as exc:
        raise ImproperlyConfigured(
            "softdog 密钥无法解密，请检查 DEVICE_SECRET_ENCRYPTION_KEY 是否与写入时一致。"
        ) from exc
