import json
from urllib.parse import unquote, urlencode

from django.contrib import admin
from django.contrib import messages
from django.http import HttpResponse
from django.shortcuts import redirect
from django.urls import path, reverse
from django.utils.html import format_html
from unfold.admin import ModelAdmin, TabularInline

from apps.audit.admin_base import AuditModelAdminMixin
from apps.licensing.exceptions import LicenseServiceError
from apps.licensing.models import License, LicenseDevice, LicenseItem
from apps.licensing.services import issue_offline_license, save_device_machine_code


class LicenseItemInline(TabularInline):
    model = LicenseItem
    extra = 1
    autocomplete_fields = ["module"]


@admin.register(License)
class LicenseAdmin(AuditModelAdminMixin, ModelAdmin):
    list_display = [
        "license_key", "customer", "status", "starts_at", "expires_at",
        "device_usage", "allow_online_activation", "allow_offline_activation",
    ]
    list_filter = ["status", "allow_online_activation", "allow_offline_activation", "expires_at"]
    search_fields = ["license_key", "customer__code", "customer__name"]
    autocomplete_fields = ["customer"]
    readonly_fields = ["license_key", "created_by", "created_at", "updated_at", "device_usage"]
    inlines = [LicenseItemInline]
    date_hierarchy = "expires_at"
    # 签发区块与已签发列表都放在授权模块（inline）之后，顺序为：
    # 基本信息 → 授权模块 → 签发离线 License → 已签发的离线 License（下载）
    change_form_outer_after_template = "admin/licensing/license/offline_licenses.html"

    def get_urls(self):
        urls = super().get_urls()
        custom_urls = [
            path(
                "<path:object_id>/issue-offline/",
                self.admin_site.admin_view(self.issue_offline_view),
                name="licensing_license_issue_offline",
            ),
            path(
                "<path:object_id>/save-machine-code/",
                self.admin_site.admin_view(self.save_machine_code_view),
                name="licensing_license_save_machine_code",
            ),
        ]
        return custom_urls + urls

    def _fallback_url(self, object_id: str, machine_code: str, device_name: str) -> str:
        fallback_params = {}
        if machine_code:
            fallback_params["machine_code"] = machine_code
        if device_name:
            fallback_params["device_name"] = device_name
        fallback_url = reverse("admin:licensing_license_change", args=[object_id])
        if fallback_params:
            fallback_url += "?" + urlencode(fallback_params)
        return fallback_url

    def save_machine_code_view(self, request, object_id):
        license_obj = self.get_object(request, unquote(object_id))
        if license_obj is None:
            return redirect(reverse("admin:licensing_license_changelist"))
        if request.method != "POST":
            return redirect(reverse("admin:licensing_license_change", args=[object_id]))

        machine_code = request.POST.get("machine_code", "").strip()
        device_name = request.POST.get("device_name", "").strip()
        fallback_url = self._fallback_url(object_id, machine_code, device_name)

        if not machine_code:
            self.message_user(request, "机器码不能为空。", level=messages.ERROR)
            return redirect(fallback_url)

        try:
            save_device_machine_code(
                license_obj=license_obj,
                machine_code=machine_code,
                device_name=device_name,
            )
        except LicenseServiceError as exc:
            self.message_user(request, exc.message, level=messages.ERROR)
            return redirect(fallback_url)

        self.message_user(request, "机器码已保存。", level=messages.SUCCESS)
        return redirect(reverse("admin:licensing_license_change", args=[object_id]))

    def issue_offline_view(self, request, object_id):
        license_obj = self.get_object(request, unquote(object_id))
        if license_obj is None:
            return redirect(reverse("admin:licensing_license_changelist"))
        if request.method != "POST":
            return redirect(reverse("admin:licensing_license_change", args=[object_id]))

        machine_code = request.POST.get("machine_code", "").strip()
        device_name = request.POST.get("device_name", "").strip()
        fallback_url = self._fallback_url(object_id, machine_code, device_name)

        if not machine_code:
            self.message_user(request, "机器码不能为空。", level=messages.ERROR)
            return redirect(fallback_url)

        try:
            result = issue_offline_license(
                license_obj=license_obj,
                machine_code=machine_code,
                device_name=device_name,
            )
        except LicenseServiceError as exc:
            self.message_user(request, exc.message, level=messages.ERROR)
            return redirect(fallback_url)

        content = json.dumps(result.envelope, ensure_ascii=False, indent=2)
        filename = f"{license_obj.license_key}-offline.lic"
        response = HttpResponse(content, content_type="application/octet-stream")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response

    @admin.display(description="设备用量")
    def device_usage(self, obj):
        if not obj.pk:
            return "-"
        count = obj.active_device_count
        color = "#dc2626" if count >= obj.max_devices else "#16a34a"
        return format_html('<span style="color:{}">{}/{}</span>', color, count, obj.max_devices)

    def save_model(self, request, obj, form, change):
        if not obj.created_by_id:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)


@admin.register(LicenseDevice)
class LicenseDeviceAdmin(AuditModelAdminMixin, ModelAdmin):
    list_display = ["device_name", "license", "machine_hint", "platform", "status", "client_version", "last_seen_at", "last_ip", "offline_lic_download"]
    list_filter = ["status", "platform", "last_seen_at"]
    search_fields = ["device_name", "machine_hash", "license__license_key", "license__customer__name"]
    autocomplete_fields = ["license"]
    readonly_fields = [
        "license", "machine_hash", "platform", "offline_envelope", "first_activated_at", "last_seen_at",
        "deactivated_at", "last_ip", "created_at", "updated_at",
    ]

    def get_urls(self):
        urls = super().get_urls()
        custom_urls = [
            path(
                "<path:object_id>/download-lic/",
                self.admin_site.admin_view(self.download_offline_lic_view),
                name="licensing_licensedevice_download_offline",
            ),
        ]
        return custom_urls + urls

    def download_offline_lic_view(self, request, object_id):
        device = self.get_object(request, unquote(object_id))
        if device is None:
            return redirect(reverse("admin:licensing_licensedevice_changelist"))
        if not device.offline_envelope:
            self.message_user(request, "该设备没有已签发的离线 License。", level=messages.WARNING)
            return redirect(reverse("admin:licensing_licensedevice_changelist"))
        content = json.dumps(device.offline_envelope, ensure_ascii=False, indent=2)
        filename = f"{device.license.license_key}-{device.machine_hint}-offline.lic"
        response = HttpResponse(content, content_type="application/octet-stream")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response

    @admin.display(description="离线 .lic")
    def offline_lic_download(self, obj):
        if not obj.offline_envelope:
            return "-"
        url = reverse("admin:licensing_licensedevice_download_offline", args=[obj.pk])
        return format_html('<a href="{}">下载</a>', url)


@admin.register(LicenseItem)
class LicenseItemAdmin(AuditModelAdminMixin, ModelAdmin):
    list_display = ["license", "module", "expires_at", "updated_at"]
    list_filter = ["module"]
    search_fields = ["license__license_key", "module__code", "module__name"]
    autocomplete_fields = ["license", "module"]
