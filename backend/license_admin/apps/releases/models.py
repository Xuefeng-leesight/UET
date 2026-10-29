from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone
from packaging.version import InvalidVersion, Version

from apps.common import UUIDTimeStampedModel


def validate_semantic_version(value: str) -> None:
    try:
        Version(value)
    except InvalidVersion as exc:
        raise ValidationError("请输入有效版本号，例如 1.2.3 或 1.2.3-beta.1。") from exc


def release_upload_to(instance: "Release", filename: str) -> str:
    safe_name = Path(filename).name
    return f"releases/{instance.product_type}/{instance.platform}/{instance.channel}/{instance.version}/{safe_name}"


def test_tool_upload_to(instance: "TestTool", filename: str) -> str:
    safe_name = Path(filename).name
    return f"test-tools/{instance.platform}/{instance.version}/{safe_name}"


def validate_release_package(package, platform: str) -> None:
    if not package:
        return
    name = package.name.lower()
    allowed = {
        "windows": (".exe", ".msi", ".zip"),
        "macos": (".dmg", ".pkg", ".zip"),
        "linux": (".appimage", ".deb", ".rpm", ".tar.gz", ".zip"),
        "android": (".apk", ".aab"),
    }
    if platform in allowed and not name.endswith(allowed[platform]):
        raise ValidationError(
            {"package": f"{platform} 安装包仅支持：{', '.join(allowed[platform])}。"}
        )
    if package.size > settings.LICENSE_MAX_UPLOAD_BYTES:
        raise ValidationError(
            {"package": f"安装包不能超过 {settings.LICENSE_MAX_UPLOAD_BYTES} 字节。"}
        )


def validate_release_target(product_type: str, platform: str) -> None:
    if product_type == "android" and platform != "android":
        raise ValidationError({"platform": "安卓端版本的平台必须选择 Android。"})
    if product_type == "pc" and platform == "android":
        raise ValidationError({"platform": "PC 端版本不能选择 Android 平台。"})


def validate_test_tool_package(package) -> None:
    if not package:
        return
    name = package.name.lower()
    allowed = (
        ".exe", ".msi", ".zip", ".dmg", ".pkg", ".appimage",
        ".deb", ".rpm", ".tar.gz", ".apk",
    )
    if not name.endswith(allowed):
        raise ValidationError({"package": f"测试工具仅支持：{', '.join(allowed)}。"})
    if package.size > settings.LICENSE_MAX_UPLOAD_BYTES:
        raise ValidationError(
            {"package": f"测试工具不能超过 {settings.LICENSE_MAX_UPLOAD_BYTES} 字节。"}
        )


def update_file_metadata(instance, original_name: str | None) -> None:
    file_changed = bool(instance.package and instance.package.name != original_name)
    if not instance.package or (not file_changed and instance.file_sha256):
        return
    digest = hashlib.sha256()
    size = 0
    instance.package.open("rb")
    try:
        for chunk in instance.package.chunks():
            digest.update(chunk)
            size += len(chunk)
    finally:
        instance.package.close()
    type(instance).objects.filter(pk=instance.pk).update(
        file_sha256=digest.hexdigest(), file_size=size
    )
    instance.file_sha256 = digest.hexdigest()
    instance.file_size = size


class Release(UUIDTimeStampedModel):
    class ProductType(models.TextChoices):
        PC = "pc", "PC 端"
        ANDROID = "android", "安卓端"

    class Platform(models.TextChoices):
        WINDOWS = "windows", "Windows"
        MACOS = "macos", "macOS"
        LINUX = "linux", "Linux"
        ANDROID = "android", "Android"

    class Architecture(models.TextChoices):
        X64 = "x64", "x64"
        ARM64 = "arm64", "arm64"
        UNIVERSAL = "universal", "Universal"

    class Channel(models.TextChoices):
        STABLE = "stable", "Stable"
        BETA = "beta", "Beta"

    class Status(models.TextChoices):
        DRAFT = "draft", "草稿"
        PUBLISHED = "published", "已发布"
        WITHDRAWN = "withdrawn", "已撤回"

    version = models.CharField("版本号", max_length=40, validators=[validate_semantic_version])
    product_type = models.CharField(
        "产品端类型", max_length=20, choices=ProductType.choices, default=ProductType.PC
    )
    platform = models.CharField("平台", max_length=20, choices=Platform.choices)
    architecture = models.CharField("架构", max_length=20, choices=Architecture.choices, default=Architecture.X64)
    channel = models.CharField("渠道", max_length=20, choices=Channel.choices, default=Channel.STABLE)
    status = models.CharField("状态", max_length=20, choices=Status.choices, default=Status.DRAFT)
    package = models.FileField("安装包", upload_to=release_upload_to, blank=True)
    file_sha256 = models.CharField("SHA-256", max_length=64, blank=True, editable=False)
    file_size = models.PositiveBigIntegerField("文件大小", default=0, editable=False)
    changelog = models.TextField("更新日志", blank=True)
    force_update = models.BooleanField("强制更新", default=False)
    minimum_supported_version = models.CharField(
        "最低支持版本", max_length=40, blank=True, validators=[validate_semantic_version]
    )
    rollout_percentage = models.PositiveSmallIntegerField(
        "灰度比例", default=100, validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    published_at = models.DateTimeField("发布时间", null=True, blank=True)
    download_token = models.UUIDField("下载令牌", default=uuid.uuid4, unique=True, editable=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        verbose_name="创建人",
        related_name="created_releases",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )

    class Meta:
        ordering = ["-published_at", "-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["version", "product_type", "platform", "architecture", "channel"],
                name="unique_release_target",
            )
        ]
        indexes = [
            models.Index(
                fields=["product_type", "platform", "architecture", "channel", "status", "published_at"]
            )
        ]
        verbose_name = "软件版本"
        verbose_name_plural = "软件版本"

    def clean(self) -> None:
        validate_release_target(self.product_type, self.platform)
        validate_release_package(self.package, self.platform)
        if self.status == self.Status.PUBLISHED and not self.package:
            raise ValidationError({"package": "发布版本必须上传安装包。"})
        if self.status == self.Status.PUBLISHED and not self.published_at:
            self.published_at = timezone.now()

    def save(self, *args, **kwargs) -> None:
        original_name = None
        if self.pk:
            original_name = type(self).objects.filter(pk=self.pk).values_list("package", flat=True).first()
        super().save(*args, **kwargs)
        update_file_metadata(self, original_name)

    @property
    def parsed_version(self) -> Version:
        return Version(self.version)

    def __str__(self) -> str:
        return f"{self.get_product_type_display()} {self.version} · {self.platform}/{self.architecture} · {self.channel}"


class TestTool(UUIDTimeStampedModel):
    class Platform(models.TextChoices):
        WINDOWS = "windows", "Windows"
        MACOS = "macos", "macOS"
        LINUX = "linux", "Linux"
        ANDROID = "android", "Android"
        UNIVERSAL = "universal", "通用"

    name = models.CharField("工具名称", max_length=120)
    version = models.CharField("版本号", max_length=40, validators=[validate_semantic_version])
    platform = models.CharField("平台", max_length=20, choices=Platform.choices)
    description = models.TextField("说明", blank=True)
    package = models.FileField("工具安装包", upload_to=test_tool_upload_to)
    file_sha256 = models.CharField("SHA-256", max_length=64, blank=True, editable=False)
    file_size = models.PositiveBigIntegerField("文件大小", default=0, editable=False)
    is_active = models.BooleanField("允许下载", default=True)
    download_token = models.UUIDField("下载令牌", default=uuid.uuid4, unique=True, editable=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        verbose_name="创建人",
        related_name="created_test_tools",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )

    class Meta:
        ordering = ["name", "-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["name", "version", "platform"], name="unique_test_tool_version"
            )
        ]
        indexes = [models.Index(fields=["is_active", "platform", "created_at"])]
        verbose_name = "测试工具"
        verbose_name_plural = "测试工具"

    def clean(self) -> None:
        validate_test_tool_package(self.package)

    def save(self, *args, **kwargs) -> None:
        original_name = None
        if self.pk:
            original_name = type(self).objects.filter(pk=self.pk).values_list("package", flat=True).first()
        super().save(*args, **kwargs)
        update_file_metadata(self, original_name)

    def __str__(self) -> str:
        return f"{self.name} {self.version} · {self.get_platform_display()}"


class DownloadEvent(models.Model):
    id = models.BigAutoField(primary_key=True)
    release = models.ForeignKey(Release, verbose_name="版本", related_name="download_events", on_delete=models.CASCADE)
    machine_hash = models.CharField("机器哈希", max_length=64, blank=True)
    client_version = models.CharField("客户端版本", max_length=40, blank=True)
    ip_address = models.GenericIPAddressField("IP", null=True, blank=True)
    user_agent = models.CharField("User-Agent", max_length=500, blank=True)
    request_id = models.CharField("请求 ID", max_length=64, blank=True)
    created_at = models.DateTimeField("下载时间", auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["release", "created_at"])]
        verbose_name = "下载记录"
        verbose_name_plural = "下载记录"

    def __str__(self) -> str:
        return f"{self.release} · {self.created_at:%Y-%m-%d %H:%M:%S}"


class TestToolDownloadEvent(models.Model):
    id = models.BigAutoField(primary_key=True)
    test_tool = models.ForeignKey(
        TestTool, verbose_name="测试工具", related_name="download_events", on_delete=models.CASCADE
    )
    ip_address = models.GenericIPAddressField("IP", null=True, blank=True)
    user_agent = models.CharField("User-Agent", max_length=500, blank=True)
    request_id = models.CharField("请求 ID", max_length=64, blank=True)
    created_at = models.DateTimeField("下载时间", auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["test_tool", "created_at"])]
        verbose_name = "测试工具下载记录"
        verbose_name_plural = "测试工具下载记录"

    def __str__(self) -> str:
        return f"{self.test_tool} · {self.created_at:%Y-%m-%d %H:%M:%S}"
