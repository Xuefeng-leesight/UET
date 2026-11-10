from __future__ import annotations

import hashlib
import secrets
import string

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone

from apps.common import UUIDTimeStampedModel
from apps.customers.models import Customer, ProductModule


LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_license_key() -> str:
    groups = ["".join(secrets.choice(LICENSE_ALPHABET) for _ in range(4)) for _ in range(4)]
    return "UST-" + "-".join(groups)


def normalize_machine_code(value: str) -> str:
    return " ".join(value.strip().upper().split())


def hash_machine_code(value: str) -> str:
    return hashlib.sha256(normalize_machine_code(value).encode("utf-8")).hexdigest()


class License(UUIDTimeStampedModel):
    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        ACTIVE = "active", "有效"
        SUSPENDED = "suspended", "暂停"
        REVOKED = "revoked", "吊销"
        EXPIRED = "expired", "已过期"

    license_key = models.CharField("授权号", max_length=40, unique=True, default=generate_license_key, editable=False)
    customer = models.ForeignKey(Customer, verbose_name="客户", related_name="licenses", on_delete=models.PROTECT)
    status = models.CharField("状态", max_length=20, choices=Status.choices, default=Status.DRAFT)
    starts_at = models.DateTimeField("生效时间", default=timezone.now)
    expires_at = models.DateTimeField("到期时间")
    max_devices = models.PositiveSmallIntegerField("设备上限", default=1)
    allow_online_activation = models.BooleanField("允许在线激活", default=True)
    allow_offline_activation = models.BooleanField("允许离线授权", default=True)
    offline_grace_days = models.PositiveSmallIntegerField("离线宽限天数", default=7)
    notes = models.TextField("备注", blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        verbose_name="创建人",
        related_name="created_licenses",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["status", "expires_at"])]
        verbose_name = "License"
        verbose_name_plural = "License"

    def clean(self) -> None:
        if self.expires_at and self.starts_at and self.expires_at <= self.starts_at:
            raise ValidationError({"expires_at": "到期时间必须晚于生效时间。"})
        if self.max_devices < 1:
            raise ValidationError({"max_devices": "设备上限必须至少为 1。"})
        if not self.allow_online_activation and not self.allow_offline_activation:
            raise ValidationError("在线激活和离线授权至少启用一种。")

    @property
    def active_device_count(self) -> int:
        return self.devices.filter(status=LicenseDevice.Status.ACTIVE).count()

    @property
    def issued_offline_devices(self) -> list["LicenseDevice"]:
        """返回已签发过离线 License（offline_envelope 非空）的设备列表。"""
        return [d for d in self.devices.all() if d.offline_envelope]

    def __str__(self) -> str:
        return f"{self.license_key} · {self.customer.name}"


class LicenseItem(UUIDTimeStampedModel):
    license = models.ForeignKey(License, verbose_name="License", related_name="items", on_delete=models.CASCADE)
    module = models.ForeignKey(ProductModule, verbose_name="产品模块", related_name="license_items", on_delete=models.PROTECT)
    expires_at = models.DateTimeField("模块到期时间", null=True, blank=True)
    notes = models.CharField("备注", max_length=500, blank=True)

    class Meta:
        ordering = ["module__code"]
        constraints = [
            models.UniqueConstraint(fields=["license", "module"], name="unique_license_module"),
        ]
        verbose_name = "授权模块"
        verbose_name_plural = "授权模块"

    def clean(self) -> None:
        if self.expires_at and self.license_id and self.expires_at > self.license.expires_at:
            raise ValidationError({"expires_at": "模块到期时间不能晚于 License 到期时间。"})

    def __str__(self) -> str:
        return f"{self.license.license_key} · {self.module.code}"


class LicenseDevice(UUIDTimeStampedModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "已激活"
        DEACTIVATED = "deactivated", "已解绑"
        REVOKED = "revoked", "已吊销"

    class Platform(models.TextChoices):
        PC = "pc", "PC 端"
        ANDROID = "android", "安卓端"

    license = models.ForeignKey(License, verbose_name="License", related_name="devices", on_delete=models.CASCADE)
    machine_hash = models.CharField("机器指纹哈希", max_length=64)
    machine_code = models.TextField("机器码", blank=True, default="")
    platform = models.CharField("平台", max_length=20, choices=Platform.choices, blank=True, default="")
    device_name = models.CharField("设备名称", max_length=120, blank=True)
    status = models.CharField("状态", max_length=20, choices=Status.choices, default=Status.ACTIVE)
    client_version = models.CharField("客户端版本", max_length=40, blank=True)
    first_activated_at = models.DateTimeField("首次激活时间", default=timezone.now)
    last_seen_at = models.DateTimeField("最后在线时间", default=timezone.now)
    deactivated_at = models.DateTimeField("解绑时间", null=True, blank=True)
    last_ip = models.GenericIPAddressField("最后 IP", null=True, blank=True)
    offline_envelope = models.JSONField("离线 License 信封", null=True, blank=True, editable=False)

    class Meta:
        ordering = ["-last_seen_at"]
        constraints = [
            models.UniqueConstraint(fields=["license", "machine_hash"], name="unique_license_machine"),
        ]
        indexes = [models.Index(fields=["license", "status"])]
        verbose_name = "激活设备"
        verbose_name_plural = "激活设备"

    @property
    def machine_hint(self) -> str:
        return self.machine_hash[:12]

    def __str__(self) -> str:
        return f"{self.license.license_key} · {self.device_name or self.machine_hint}"
