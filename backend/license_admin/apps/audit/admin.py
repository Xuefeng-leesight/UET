from django.contrib import admin
from unfold.admin import ModelAdmin

from apps.audit.models import AuditLog


@admin.register(AuditLog)
class AuditLogAdmin(ModelAdmin):
    list_display = ["created_at", "action", "actor", "object_type", "object_repr", "request_id", "ip_address"]
    list_filter = ["action", "object_type", "created_at"]
    search_fields = ["object_id", "object_repr", "request_id", "actor__username"]
    readonly_fields = [
        "actor", "action", "object_type", "object_id", "object_repr", "detail",
        "request_id", "ip_address", "created_at",
    ]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
