from django.contrib import admin
from django.db.models import Count
from django.utils.html import format_html
from unfold.admin import ModelAdmin

from apps.audit.admin_base import AuditModelAdminMixin
from apps.releases.models import DownloadEvent, Release, TestTool, TestToolDownloadEvent


@admin.register(Release)
class ReleaseAdmin(AuditModelAdminMixin, ModelAdmin):
    list_display = [
        "version", "product_type", "platform", "architecture", "channel", "status", "published_at",
        "force_update", "rollout_percentage", "download_count",
    ]
    list_filter = ["product_type", "platform", "architecture", "channel", "status", "force_update"]
    search_fields = ["version", "changelog", "file_sha256"]
    readonly_fields = ["file_sha256", "file_size", "download_token", "created_by", "created_at", "updated_at"]
    date_hierarchy = "published_at"

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(_download_count=Count("download_events"))

    @admin.display(description="下载次数", ordering="_download_count")
    def download_count(self, obj):
        return obj._download_count

    def save_model(self, request, obj, form, change):
        if not obj.created_by_id:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)


@admin.register(TestTool)
class TestToolAdmin(AuditModelAdminMixin, ModelAdmin):
    list_display = [
        "name", "version", "platform", "is_active", "download_link", "file_size", "download_count", "updated_at",
    ]
    list_editable = ["is_active"]
    list_filter = ["platform", "is_active"]
    search_fields = ["name", "version", "description", "file_sha256"]
    readonly_fields = [
        "file_sha256", "file_size", "download_token", "download_link", "created_by", "created_at", "updated_at",
    ]

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(_download_count=Count("download_events"))

    @admin.display(description="下载次数", ordering="_download_count")
    def download_count(self, obj):
        return obj._download_count

    @admin.display(description="下载链接")
    def download_link(self, obj):
        if not obj or not obj.pk:
            return "保存后生成"
        url = f"/api/v1/client/test-tools/{obj.download_token}/download"
        return format_html('<a href="{}" target="_blank">复制或下载</a>', url)

    def save_model(self, request, obj, form, change):
        if not obj.created_by_id:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)


@admin.register(DownloadEvent)
class DownloadEventAdmin(ModelAdmin):
    list_display = ["created_at", "release", "client_version", "ip_address", "request_id"]
    list_filter = ["created_at", "release__platform", "release__channel"]
    search_fields = ["release__version", "machine_hash", "request_id", "ip_address"]
    readonly_fields = [
        "release", "machine_hash", "client_version", "ip_address",
        "user_agent", "request_id", "created_at",
    ]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(TestToolDownloadEvent)
class TestToolDownloadEventAdmin(ModelAdmin):
    list_display = ["created_at", "test_tool", "ip_address", "request_id"]
    list_filter = ["created_at", "test_tool__platform"]
    search_fields = ["test_tool__name", "test_tool__version", "request_id", "ip_address"]
    readonly_fields = ["test_tool", "ip_address", "user_agent", "request_id", "created_at"]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
