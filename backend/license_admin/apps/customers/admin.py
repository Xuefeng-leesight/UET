from django.contrib import admin
from unfold.admin import ModelAdmin, TabularInline

from apps.audit.admin_base import AuditModelAdminMixin
from apps.customers.forms import CustomerEyeTrackerForm
from apps.customers.models import Customer, CustomerEyeTracker, EyeTrackerType, ProductModule


class CustomerEyeTrackerInline(TabularInline):
    model = CustomerEyeTracker
    form = CustomerEyeTrackerForm
    extra = 0
    autocomplete_fields = ["device_type"]
    fields = [
        "device_type", "display_name", "serial_number", "status",
        "softdog_password", "softdog_password_hint",
    ]
    readonly_fields = ["softdog_password_hint"]

    @admin.display(description="密钥指纹")
    def softdog_password_hint(self, obj):
        return obj.softdog_password_hint or "-"


@admin.register(Customer)
class CustomerAdmin(AuditModelAdminMixin, ModelAdmin):
    list_display = [
        "code", "name", "status", "eye_tracker_count", "contact_name", "contact_phone", "updated_at"
    ]
    list_filter = ["status"]
    search_fields = ["code", "name", "contact_name", "contact_email", "contact_phone"]
    ordering = ["code"]
    inlines = [CustomerEyeTrackerInline]

    @admin.display(description="眼动设备数")
    def eye_tracker_count(self, obj):
        return obj.eye_trackers.count()


@admin.register(ProductModule)
class ProductModuleAdmin(AuditModelAdminMixin, ModelAdmin):
    list_display = ["code", "name", "is_active", "updated_at"]
    list_editable = ["is_active"]
    list_filter = ["is_active"]
    search_fields = ["code", "name", "description"]
    ordering = ["code"]


@admin.register(EyeTrackerType)
class EyeTrackerTypeAdmin(AuditModelAdminMixin, ModelAdmin):
    list_display = ["code", "name", "manufacturer", "is_active", "updated_at"]
    list_editable = ["is_active"]
    list_filter = ["is_active", "manufacturer"]
    search_fields = ["code", "name", "manufacturer", "description"]
    ordering = ["code"]


@admin.register(CustomerEyeTracker)
class CustomerEyeTrackerAdmin(AuditModelAdminMixin, ModelAdmin):
    form = CustomerEyeTrackerForm
    list_display = [
        "display_name", "customer", "device_type", "serial_number", "status",
        "softdog_password_hint", "updated_at",
    ]
    list_filter = ["status", "device_type"]
    search_fields = [
        "display_name", "serial_number", "customer__code", "customer__name",
        "device_type__code", "device_type__name",
    ]
    autocomplete_fields = ["customer", "device_type"]
    readonly_fields = [
        "softdog_password_hint", "softdog_password_fingerprint", "created_at", "updated_at"
    ]
