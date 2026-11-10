from django.conf import settings
from django.db import models


class AuditLog(models.Model):
    id = models.BigAutoField(primary_key=True)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        verbose_name="操作人",
        related_name="ust_audit_logs",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )
    action = models.CharField("动作", max_length=50)
    object_type = models.CharField("对象类型", max_length=120)
    object_id = models.CharField("对象 ID", max_length=100, blank=True)
    object_repr = models.CharField("对象", max_length=300, blank=True)
    detail = models.JSONField("详情", default=dict, blank=True)
    request_id = models.CharField("请求 ID", max_length=64, blank=True)
    ip_address = models.GenericIPAddressField("IP", null=True, blank=True)
    created_at = models.DateTimeField("时间", auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["object_type", "object_id"]), models.Index(fields=["created_at"])]
        verbose_name = "操作日志"
        verbose_name_plural = "操作日志"

    def __str__(self) -> str:
        return f"{self.action} · {self.object_repr or self.object_type}"
