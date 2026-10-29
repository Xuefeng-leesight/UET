from django.contrib.auth.models import Group, Permission
from django.core.management.base import BaseCommand
from django.db import transaction

from apps.customers.models import EyeTrackerType, ProductModule


DEFAULT_MODULES = [
    ("eye_tracking", "眼动模块"),
    ("facial_analysis", "表情模块"),
]

LEGACY_SUBFEATURE_MODULE_CODES = [
    "stimulus_presentation",
    "aoi_analysis",
    "visual_analysis",
    "data_export",
    "multiplayer",
]

DEFAULT_EYE_TRACKER_TYPES = [
    ("a8", "A8"),
    ("pro", "Pro"),
    ("asee-glasses-plus", "aSeeGlassesPlus"),
]


class Command(BaseCommand):
    help = "幂等创建角色、产品能力模块和默认眼动设备类型。"

    @transaction.atomic
    def handle(self, *args, **options):
        business_apps = {"customers", "licensing", "releases", "audit"}
        permissions = Permission.objects.filter(content_type__app_label__in=business_apps)

        operator, _ = Group.objects.get_or_create(name="运营人员")
        operator.permissions.set(permissions.exclude(codename__startswith="delete_"))

        viewer, _ = Group.objects.get_or_create(name="只读审计")
        viewer.permissions.set(permissions.filter(codename__startswith="view_"))

        for code, name in DEFAULT_MODULES:
            ProductModule.objects.update_or_create(
                code=code,
                defaults={"name": name, "is_active": True},
            )
        ProductModule.objects.filter(code__in=LEGACY_SUBFEATURE_MODULE_CODES).update(
            is_active=False
        )
        for code, name in DEFAULT_EYE_TRACKER_TYPES:
            EyeTrackerType.objects.update_or_create(
                code=code,
                defaults={"name": name, "is_active": True},
            )
        self.stdout.write(self.style.SUCCESS("角色、默认模块和眼动设备类型已初始化。"))
