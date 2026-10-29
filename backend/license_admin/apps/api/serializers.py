from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from rest_framework import serializers

from apps.audit.models import AuditLog
from apps.customers.models import Customer, CustomerEyeTracker, EyeTrackerType, ProductModule
from apps.customers.secrets import normalize_softdog_password
from apps.licensing.models import License, LicenseDevice, LicenseItem
from apps.releases.models import (
    Release,
    TestTool,
    validate_release_package,
    validate_release_target,
    validate_test_tool_package,
)


class ActivationRequestSerializer(serializers.Serializer):
    license_key = serializers.CharField(max_length=40)
    machine_code = serializers.CharField(min_length=4, max_length=500, write_only=True)
    device_name = serializers.CharField(max_length=120, required=False, allow_blank=True)
    client_version = serializers.CharField(max_length=40, required=False, allow_blank=True)
    platform = serializers.ChoiceField(choices=LicenseDevice.Platform.choices, required=False, allow_blank=True)


class DeactivationRequestSerializer(serializers.Serializer):
    license_key = serializers.CharField(max_length=40)
    machine_code = serializers.CharField(min_length=4, max_length=500, write_only=True)


class LicenseCheckSerializer(serializers.Serializer):
    """离线 License 联网自检：按 license_id + machine_code 查询是否仍可用，不依赖 license_key。"""
    license_id = serializers.CharField(max_length=40)
    machine_code = serializers.CharField(min_length=4, max_length=500, write_only=True)


class SoftdogPasswordRequestSerializer(serializers.Serializer):
    license_key = serializers.CharField(max_length=40)
    machine_code = serializers.CharField(min_length=4, max_length=500, write_only=True)
    device_model = serializers.CharField(max_length=40)
    serial_number = serializers.CharField(max_length=120, required=False, allow_blank=True)


class LatestReleaseQuerySerializer(serializers.Serializer):
    product_type = serializers.ChoiceField(
        choices=Release.ProductType.choices, default=Release.ProductType.PC
    )
    platform = serializers.ChoiceField(choices=Release.Platform.choices)
    architecture = serializers.ChoiceField(choices=Release.Architecture.choices, default=Release.Architecture.X64)
    channel = serializers.ChoiceField(choices=Release.Channel.choices, default=Release.Channel.STABLE)
    current_version = serializers.CharField(max_length=40, required=False, allow_blank=True)
    machine_hash = serializers.RegexField(r"^[a-fA-F0-9]{64}$", required=False, allow_blank=True)

    def validate(self, attrs):
        try:
            validate_release_target(attrs["product_type"], attrs["platform"])
        except DjangoValidationError as exc:
            raise serializers.ValidationError(exc.message_dict) from exc
        return attrs


class EyeTrackerSummarySerializer(serializers.ModelSerializer):
    device_type_code = serializers.CharField(source="device_type.code", read_only=True)
    device_type_name = serializers.CharField(source="device_type.name", read_only=True)
    softdog_password_configured = serializers.BooleanField(read_only=True)
    softdog_password_hint = serializers.CharField(read_only=True)

    class Meta:
        model = CustomerEyeTracker
        fields = [
            "id", "device_type", "device_type_code", "device_type_name",
            "display_name", "serial_number", "status",
            "softdog_password_configured", "softdog_password_hint",
        ]


class CustomerSerializer(serializers.ModelSerializer):
    eye_tracker_count = serializers.SerializerMethodField()
    eye_trackers = EyeTrackerSummarySerializer(many=True, read_only=True)

    class Meta:
        model = Customer
        fields = "__all__"
        read_only_fields = [
            "id", "eye_tracker_count", "eye_trackers", "created_at", "updated_at"
        ]

    def get_eye_tracker_count(self, obj) -> int:
        prefetched = getattr(obj, "_prefetched_objects_cache", {}).get("eye_trackers")
        return len(prefetched) if prefetched is not None else obj.eye_trackers.count()


class ProductModuleSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProductModule
        fields = "__all__"
        read_only_fields = ["id", "created_at", "updated_at"]


class EyeTrackerTypeSerializer(serializers.ModelSerializer):
    class Meta:
        model = EyeTrackerType
        fields = "__all__"
        read_only_fields = ["id", "created_at", "updated_at"]


class CustomerEyeTrackerSerializer(serializers.ModelSerializer):
    customer_name = serializers.CharField(source="customer.name", read_only=True)
    device_type_code = serializers.CharField(source="device_type.code", read_only=True)
    device_type_name = serializers.CharField(source="device_type.name", read_only=True)
    softdog_password = serializers.CharField(
        write_only=True,
        min_length=32,
        max_length=512,
        required=False,
        style={"input_type": "password"},
    )
    softdog_password_configured = serializers.SerializerMethodField()
    softdog_password_hint = serializers.CharField(read_only=True)

    class Meta:
        model = CustomerEyeTracker
        fields = [
            "id", "customer", "customer_name", "device_type", "device_type_code",
            "device_type_name", "display_name", "serial_number", "status",
            "softdog_password", "softdog_password_configured", "softdog_password_hint",
            "notes", "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "softdog_password_configured", "softdog_password_hint",
            "created_at", "updated_at",
        ]

    def get_softdog_password_configured(self, obj) -> bool:
        return bool(obj.softdog_password_ciphertext)

    def validate_softdog_password(self, value):
        try:
            return normalize_softdog_password(value)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(exc.messages) from exc

    def validate(self, attrs):
        if self.instance is None and not attrs.get("softdog_password"):
            raise serializers.ValidationError(
                {"softdog_password": "新增设备时必须填写 softdog pwd。"}
            )
        return attrs

    def create(self, validated_data):
        password = validated_data.pop("softdog_password")
        instance = CustomerEyeTracker(**validated_data)
        instance.set_softdog_password(password)
        instance.save()
        return instance

    def update(self, instance, validated_data):
        password = validated_data.pop("softdog_password", "")
        for name, value in validated_data.items():
            setattr(instance, name, value)
        if password:
            instance.set_softdog_password(password)
        instance.save()
        return instance


class LicenseItemSerializer(serializers.ModelSerializer):
    module_code = serializers.CharField(source="module.code", read_only=True)
    module_name = serializers.CharField(source="module.name", read_only=True)

    class Meta:
        model = LicenseItem
        fields = ["id", "license", "module", "module_code", "module_name", "expires_at", "notes", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class LicenseSerializer(serializers.ModelSerializer):
    items = LicenseItemSerializer(many=True, read_only=True)
    active_device_count = serializers.IntegerField(read_only=True)
    customer_name = serializers.CharField(source="customer.name", read_only=True)

    class Meta:
        model = License
        fields = [
            "id", "license_key", "customer", "customer_name", "status", "starts_at", "expires_at",
            "max_devices", "active_device_count", "allow_online_activation", "allow_offline_activation",
            "offline_grace_days", "notes", "items", "created_by", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "license_key", "active_device_count", "created_by", "created_at", "updated_at"]

    def validate(self, attrs):
        starts_at = attrs.get("starts_at", getattr(self.instance, "starts_at", None))
        expires_at = attrs.get("expires_at", getattr(self.instance, "expires_at", None))
        max_devices = attrs.get("max_devices", getattr(self.instance, "max_devices", 1))
        online = attrs.get(
            "allow_online_activation", getattr(self.instance, "allow_online_activation", True)
        )
        offline = attrs.get(
            "allow_offline_activation", getattr(self.instance, "allow_offline_activation", True)
        )
        if starts_at and expires_at and expires_at <= starts_at:
            raise serializers.ValidationError({"expires_at": "到期时间必须晚于生效时间。"})
        if max_devices < 1:
            raise serializers.ValidationError({"max_devices": "设备上限必须至少为 1。"})
        if not online and not offline:
            raise serializers.ValidationError("在线激活和离线授权至少启用一种。")
        return attrs


class LicenseDeviceSerializer(serializers.ModelSerializer):
    machine_hint = serializers.CharField(read_only=True)
    license_key = serializers.CharField(source="license.license_key", read_only=True)

    class Meta:
        model = LicenseDevice
        fields = [
            "id", "license", "license_key", "machine_hash", "machine_hint", "platform", "device_name", "status",
            "client_version", "first_activated_at", "last_seen_at", "deactivated_at", "last_ip",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "license", "machine_hash", "machine_hint", "platform", "first_activated_at", "last_seen_at",
            "deactivated_at", "last_ip", "created_at", "updated_at",
        ]


class ReleaseSerializer(serializers.ModelSerializer):
    download_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Release
        fields = [
            "id", "version", "product_type", "platform", "architecture", "channel", "status", "package",
            "file_sha256", "file_size", "changelog", "force_update", "minimum_supported_version",
            "rollout_percentage", "published_at", "download_token", "download_count", "created_by",
            "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "file_sha256", "file_size", "download_token", "download_count", "created_by",
            "created_at", "updated_at",
        ]

    def validate(self, attrs):
        release_status = attrs.get("status", getattr(self.instance, "status", Release.Status.DRAFT))
        package = attrs.get("package", getattr(self.instance, "package", None))
        platform = attrs.get("platform", getattr(self.instance, "platform", ""))
        product_type = attrs.get(
            "product_type", getattr(self.instance, "product_type", Release.ProductType.PC)
        )
        try:
            validate_release_target(product_type, platform)
            validate_release_package(package, platform)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(exc.message_dict) from exc
        if release_status == Release.Status.PUBLISHED and not package:
            raise serializers.ValidationError({"package": "发布版本必须上传安装包。"})
        if release_status == Release.Status.PUBLISHED and not attrs.get(
            "published_at", getattr(self.instance, "published_at", None)
        ):
            attrs["published_at"] = timezone.now()
        return attrs


class TestToolSerializer(serializers.ModelSerializer):
    download_count = serializers.IntegerField(read_only=True)
    download_url = serializers.SerializerMethodField()

    class Meta:
        model = TestTool
        fields = [
            "id", "name", "version", "platform", "description", "package",
            "file_sha256", "file_size", "is_active", "download_token",
            "download_url", "download_count", "created_by", "created_at", "updated_at",
        ]
        read_only_fields = [
            "id", "file_sha256", "file_size", "download_token", "download_url",
            "download_count", "created_by", "created_at", "updated_at",
        ]

    def get_download_url(self, obj) -> str:
        path = f"/api/v1/client/test-tools/{obj.download_token}/download"
        request = self.context.get("request")
        return request.build_absolute_uri(path) if request else path

    def validate_package(self, package):
        try:
            validate_test_tool_package(package)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(exc.message_dict.get("package", exc.messages)) from exc
        return package


class PublicTestToolSerializer(serializers.ModelSerializer):
    download_url = serializers.SerializerMethodField()

    class Meta:
        model = TestTool
        fields = [
            "id", "name", "version", "platform", "description", "file_sha256",
            "file_size", "download_url", "updated_at",
        ]

    def get_download_url(self, obj) -> str:
        path = f"/api/v1/client/test-tools/{obj.download_token}/download"
        return self.context["request"].build_absolute_uri(path)


class AuditLogSerializer(serializers.ModelSerializer):
    actor_name = serializers.CharField(source="actor.username", read_only=True)

    class Meta:
        model = AuditLog
        fields = "__all__"


class OfflineLicenseRequestSerializer(serializers.Serializer):
    machine_code = serializers.CharField(min_length=4, max_length=500, write_only=True)
    device_name = serializers.CharField(max_length=120, required=False, allow_blank=True)
    platform = serializers.ChoiceField(choices=LicenseDevice.Platform.choices, required=False, allow_blank=True)
