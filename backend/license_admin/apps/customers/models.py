from django.db import models
from django.db.models import Q

from apps.common import UUIDTimeStampedModel
from apps.customers.secrets import encrypt_softdog_password


class Customer(UUIDTimeStampedModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "正常"
        SUSPENDED = "suspended", "暂停"
        CLOSED = "closed", "停用"

    code = models.CharField("客户编号", max_length=40, unique=True)
    name = models.CharField("客户名称", max_length=200)
    contact_name = models.CharField("联系人", max_length=100, blank=True)
    contact_phone = models.CharField("联系电话", max_length=50, blank=True)
    contact_email = models.EmailField("联系邮箱", blank=True)
    address = models.CharField("地址", max_length=500, blank=True)
    status = models.CharField("状态", max_length=20, choices=Status.choices, default=Status.ACTIVE)
    notes = models.TextField("备注", blank=True)

    class Meta:
        ordering = ["code"]
        verbose_name = "客户"
        verbose_name_plural = "客户"

    def __str__(self) -> str:
        return f"{self.code} · {self.name}"


class ProductModule(UUIDTimeStampedModel):
    code = models.SlugField("模块编码", max_length=64, unique=True)
    name = models.CharField("模块名称", max_length=120)
    description = models.TextField("说明", blank=True)
    is_active = models.BooleanField("启用", default=True)

    class Meta:
        ordering = ["code"]
        verbose_name = "产品能力模块"
        verbose_name_plural = "产品能力模块"

    def __str__(self) -> str:
        return f"{self.code} · {self.name}"


class EyeTrackerType(UUIDTimeStampedModel):
    code = models.SlugField("设备类型编码", max_length=64, unique=True)
    name = models.CharField("设备类型名称", max_length=120)
    manufacturer = models.CharField("厂商", max_length=120, blank=True)
    description = models.TextField("说明", blank=True)
    is_active = models.BooleanField("启用", default=True)

    class Meta:
        ordering = ["code"]
        verbose_name = "眼动设备类型"
        verbose_name_plural = "眼动设备类型"

    def __str__(self) -> str:
        return f"{self.code} · {self.name}"


class CustomerEyeTracker(UUIDTimeStampedModel):
    class Status(models.TextChoices):
        ACTIVE = "active", "正常"
        MAINTENANCE = "maintenance", "维护中"
        RETIRED = "retired", "已停用"

    customer = models.ForeignKey(
        Customer,
        verbose_name="客户",
        related_name="eye_trackers",
        on_delete=models.PROTECT,
    )
    device_type = models.ForeignKey(
        EyeTrackerType,
        verbose_name="设备类型",
        related_name="customer_devices",
        on_delete=models.PROTECT,
    )
    display_name = models.CharField("设备名称", max_length=120)
    serial_number = models.CharField("设备序列号", max_length=120, blank=True)
    status = models.CharField("状态", max_length=20, choices=Status.choices, default=Status.ACTIVE)
    softdog_password_ciphertext = models.TextField("softdog 密钥密文", editable=False)
    softdog_password_fingerprint = models.CharField(
        "softdog 密钥指纹", max_length=64, editable=False
    )
    notes = models.TextField("备注", blank=True)

    class Meta:
        ordering = ["customer__code", "device_type__code", "display_name"]
        constraints = [
            models.UniqueConstraint(
                fields=["serial_number"],
                condition=~Q(serial_number=""),
                name="unique_nonempty_eye_tracker_serial",
            )
        ]
        indexes = [models.Index(fields=["customer", "status"])]
        verbose_name = "客户眼动设备"
        verbose_name_plural = "客户眼动设备"

    def set_softdog_password(self, value: str) -> None:
        ciphertext, fingerprint = encrypt_softdog_password(value)
        self.softdog_password_ciphertext = ciphertext
        self.softdog_password_fingerprint = fingerprint

    @property
    def softdog_password_hint(self) -> str:
        return self.softdog_password_fingerprint[:12] if self.softdog_password_fingerprint else ""

    @property
    def softdog_password_configured(self) -> bool:
        return bool(self.softdog_password_ciphertext)

    def __str__(self) -> str:
        return f"{self.customer.code} · {self.device_type.name} · {self.display_name}"
