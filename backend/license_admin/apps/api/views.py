from __future__ import annotations

import re
from urllib.parse import quote

from django.conf import settings
from django.db.models import Count
from django.http import FileResponse, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import mixins, permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.api.serializers import (
    ActivationRequestSerializer,
    AuditLogSerializer,
    CustomerSerializer,
    CustomerEyeTrackerSerializer,
    DeactivationRequestSerializer,
    LatestReleaseQuerySerializer,
    LicenseCheckSerializer,
    LicenseDeviceSerializer,
    LicenseItemSerializer,
    LicenseSerializer,
    OfflineLicenseRequestSerializer,
    ProductModuleSerializer,
    PublicTestToolSerializer,
    EyeTrackerTypeSerializer,
    ReleaseSerializer,
    SoftdogPasswordRequestSerializer,
    TestToolSerializer,
)
from apps.audit.middleware import client_ip
from apps.audit.models import AuditLog
from apps.audit.services import write_audit_log
from apps.customers.models import Customer, CustomerEyeTracker, EyeTrackerType, ProductModule
from apps.licensing.models import License, LicenseDevice, LicenseItem
from apps.licensing.services import (
    activate_license,
    check_license_status,
    deactivate_license,
    fetch_softdog_password,
    issue_offline_license,
    refresh_license,
)
from apps.licensing.signing import configured_public_key
from apps.releases.models import DownloadEvent, Release, TestTool, TestToolDownloadEvent
from apps.releases.services import latest_release


class HealthView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = []

    @extend_schema(responses={200: dict})
    def get(self, request):
        return Response({"status": "ok", "service": "ust-license-admin", "time": timezone.now()})


class ActivationView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "activation"

    @extend_schema(request=ActivationRequestSerializer, responses={200: dict, 201: dict})
    def post(self, request):
        serializer = ActivationRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = activate_license(**serializer.validated_data, ip_address=client_ip(request))
        return Response(
            {"activation_id": result.device.id, "created": result.created, "license": result.envelope},
            status=status.HTTP_201_CREATED if result.created else status.HTTP_200_OK,
        )


class VerifyLicenseView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "activation"

    @extend_schema(request=ActivationRequestSerializer, responses={200: dict})
    def post(self, request):
        serializer = ActivationRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        result = refresh_license(
            license_key=values["license_key"],
            machine_code=values["machine_code"],
            client_version=values.get("client_version", ""),
            platform=values.get("platform", ""),
            ip_address=client_ip(request),
        )
        return Response({"valid": True, "activation_id": result.device.id, "license": result.envelope})


class DeactivationView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "activation"

    @extend_schema(request=DeactivationRequestSerializer, responses={200: dict})
    def post(self, request):
        serializer = DeactivationRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        device = deactivate_license(**serializer.validated_data)
        return Response({"deactivated": True, "activation_id": device.id})


class LicenseCheckView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "activation"

    @extend_schema(request=LicenseCheckSerializer, responses={200: dict})
    def post(self, request):
        serializer = LicenseCheckSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = check_license_status(**serializer.validated_data)
        return Response(result)


class SoftdogPasswordView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "activation"

    @extend_schema(request=SoftdogPasswordRequestSerializer, responses={200: dict})
    def post(self, request):
        serializer = SoftdogPasswordRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = fetch_softdog_password(**serializer.validated_data)
        return Response(result)


class SigningKeyView(APIView):
    permission_classes = [permissions.AllowAny]

    @extend_schema(responses={200: dict})
    def get(self, request, key_id: str):
        value = configured_public_key(key_id)
        if not value:
            return Response(
                {
                    "error": {
                        "code": "SIGNING_KEY_NOT_FOUND",
                        "message": "签名公钥不存在。",
                        "request_id": request.request_id,
                        "details": {},
                    }
                },
                status=404,
            )
        return Response({"key_id": key_id, "algorithm": "Ed25519", "public_key": value})


class LatestReleaseView(APIView):
    permission_classes = [permissions.AllowAny]

    @extend_schema(
        parameters=[
            OpenApiParameter("product_type", str, required=False),
            OpenApiParameter("platform", str, required=True),
            OpenApiParameter("architecture", str, required=False),
            OpenApiParameter("channel", str, required=False),
            OpenApiParameter("current_version", str, required=False),
            OpenApiParameter("machine_hash", str, required=False),
        ],
        responses={200: dict},
    )
    def get(self, request):
        serializer = LatestReleaseQuerySerializer(data=request.query_params)
        serializer.is_valid(raise_exception=True)
        release, update_available, force_update = latest_release(**serializer.validated_data)
        if release is None:
            return Response({"update_available": False, "release": None})
        download_url = request.build_absolute_uri(
            f"/api/v1/client/releases/{release.download_token}/download"
        )
        return Response(
            {
                "update_available": update_available,
                "force_update": force_update,
                "release": {
                    "version": release.version,
                    "product_type": release.product_type,
                    "platform": release.platform,
                    "architecture": release.architecture,
                    "channel": release.channel,
                    "changelog": release.changelog,
                    "published_at": release.published_at,
                    "file_sha256": release.file_sha256,
                    "file_size": release.file_size,
                    "download_url": download_url,
                },
            }
        )


def _package_download_response(package_field, download_filename: str):
    """返回安装包下载响应。

    nginx 环境（DJANGO_DOWNLOAD_X_ACCEL=true）走 X-Accel-Redirect：Django 只做
    鉴权与下载记录，nginx 用 sendfile 直发文件，绕开 gunicorn worker 超时
    （2-5G 大文件下载）。否则退回 FileResponse 流式下载（本地 runserver 兜底）。
    """
    if settings.DOWNLOAD_USE_X_ACCEL:
        response = HttpResponse(status=200)
        # package_field.name 是相对 MEDIA_ROOT 的路径，例如 releases/pc/windows/stable/1.0.0/app.exe
        response["X-Accel-Redirect"] = settings.DOWNLOAD_X_ACCEL_PREFIX + quote(package_field.name)
        response["Content-Type"] = "application/octet-stream"
        response["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(download_filename)
        return response
    package_field.open("rb")
    return FileResponse(package_field, as_attachment=True, filename=download_filename)


class ReleaseDownloadView(APIView):
    permission_classes = [permissions.AllowAny]

    @extend_schema(responses={(200, "application/octet-stream"): bytes})
    def get(self, request, download_token):
        release = get_object_or_404(
            Release,
            download_token=download_token,
            status=Release.Status.PUBLISHED,
            published_at__lte=timezone.now(),
        )
        if not release.package:
            return Response(
                {
                    "error": {
                        "code": "PACKAGE_NOT_FOUND",
                        "message": "安装包不存在。",
                        "request_id": request.request_id,
                        "details": {},
                    }
                },
                status=404,
            )
        DownloadEvent.objects.create(
            release=release,
            machine_hash=(
                request.query_params.get("machine_hash", "").lower()
                if re.fullmatch(r"[a-fA-F0-9]{64}", request.query_params.get("machine_hash", ""))
                else ""
            ),
            client_version=request.query_params.get("client_version", "")[:40],
            ip_address=client_ip(request),
            user_agent=request.headers.get("User-Agent", "")[:500],
            request_id=request.request_id,
        )
        write_audit_log(action="release.downloaded", instance=release)
        return _package_download_response(release.package, release.package.name.rsplit("/", 1)[-1])


class PublicTestToolListView(APIView):
    permission_classes = [permissions.AllowAny]

    @extend_schema(
        parameters=[OpenApiParameter("platform", str, required=False)],
        responses={200: PublicTestToolSerializer(many=True)},
    )
    def get(self, request):
        tools = TestTool.objects.filter(is_active=True)
        platform = request.query_params.get("platform", "")
        if platform:
            allowed = {choice for choice, _label in TestTool.Platform.choices}
            if platform not in allowed:
                return Response(
                    {"platform": [f"无效平台，可选值：{', '.join(sorted(allowed))}。"]},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            tools = tools.filter(platform__in=[platform, TestTool.Platform.UNIVERSAL])
        serializer = PublicTestToolSerializer(tools, many=True, context={"request": request})
        return Response(serializer.data)


class TestToolDownloadView(APIView):
    permission_classes = [permissions.AllowAny]

    @extend_schema(responses={(200, "application/octet-stream"): bytes})
    def get(self, request, download_token):
        test_tool = get_object_or_404(TestTool, download_token=download_token, is_active=True)
        if not test_tool.package:
            return Response(
                {
                    "error": {
                        "code": "TOOL_PACKAGE_NOT_FOUND",
                        "message": "测试工具安装包不存在。",
                        "request_id": request.request_id,
                        "details": {},
                    }
                },
                status=404,
            )
        TestToolDownloadEvent.objects.create(
            test_tool=test_tool,
            ip_address=client_ip(request),
            user_agent=request.headers.get("User-Agent", "")[:500],
            request_id=request.request_id,
        )
        write_audit_log(action="test_tool.downloaded", instance=test_tool)
        return _package_download_response(test_tool.package, test_tool.package.name.rsplit("/", 1)[-1])


class AuditedModelViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.IsAdminUser]

    def perform_create(self, serializer):
        instance = serializer.save()
        write_audit_log(action="api.created", instance=instance, actor=self.request.user)

    def perform_update(self, serializer):
        instance = serializer.save()
        write_audit_log(action="api.updated", instance=instance, actor=self.request.user)

    def perform_destroy(self, instance):
        write_audit_log(action="api.deleted", instance=instance, actor=self.request.user)
        instance.delete()


class CustomerViewSet(AuditedModelViewSet):
    queryset = Customer.objects.prefetch_related("eye_trackers__device_type")
    serializer_class = CustomerSerializer
    http_method_names = ["get", "post", "put", "patch", "head", "options"]
    filterset_fields = ["status"]
    search_fields = ["code", "name"]


class ProductModuleViewSet(AuditedModelViewSet):
    queryset = ProductModule.objects.all()
    serializer_class = ProductModuleSerializer
    http_method_names = ["get", "post", "put", "patch", "head", "options"]


class EyeTrackerTypeViewSet(AuditedModelViewSet):
    queryset = EyeTrackerType.objects.all()
    serializer_class = EyeTrackerTypeSerializer
    http_method_names = ["get", "post", "put", "patch", "head", "options"]


class CustomerEyeTrackerViewSet(AuditedModelViewSet):
    queryset = CustomerEyeTracker.objects.select_related("customer", "device_type")
    serializer_class = CustomerEyeTrackerSerializer
    http_method_names = ["get", "post", "put", "patch", "head", "options"]

    def get_queryset(self):
        queryset = super().get_queryset()
        for parameter, field in (
            ("customer", "customer_id"),
            ("device_type", "device_type_id"),
            ("status", "status"),
        ):
            value = self.request.query_params.get(parameter)
            if value:
                queryset = queryset.filter(**{field: value})
        return queryset


class LicenseViewSet(AuditedModelViewSet):
    queryset = License.objects.select_related("customer", "created_by").prefetch_related("items__module")
    serializer_class = LicenseSerializer
    http_method_names = ["get", "post", "put", "patch", "head", "options"]

    def perform_create(self, serializer):
        instance = serializer.save(created_by=self.request.user)
        write_audit_log(action="api.created", instance=instance, actor=self.request.user)

    @action(detail=True, methods=["post"], url_path="offline-license")
    def offline_license(self, request, pk=None):
        serializer = OfflineLicenseRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = issue_offline_license(license_obj=self.get_object(), **serializer.validated_data)
        return Response({"activation_id": result.device.id, "created": result.created, "license": result.envelope})


class LicenseItemViewSet(AuditedModelViewSet):
    queryset = LicenseItem.objects.select_related("license", "module")
    serializer_class = LicenseItemSerializer


class LicenseDeviceViewSet(AuditedModelViewSet):
    queryset = LicenseDevice.objects.select_related("license")
    serializer_class = LicenseDeviceSerializer
    http_method_names = ["get", "patch", "head", "options"]


class ReleaseViewSet(AuditedModelViewSet):
    queryset = Release.objects.select_related("created_by").annotate(download_count=Count("download_events"))
    serializer_class = ReleaseSerializer
    http_method_names = ["get", "post", "put", "patch", "head", "options"]

    def perform_create(self, serializer):
        instance = serializer.save(created_by=self.request.user)
        write_audit_log(action="api.created", instance=instance, actor=self.request.user)


class TestToolViewSet(AuditedModelViewSet):
    queryset = TestTool.objects.select_related("created_by").annotate(
        download_count=Count("download_events")
    )
    serializer_class = TestToolSerializer
    http_method_names = ["get", "post", "put", "patch", "head", "options"]
    filterset_fields = ["platform", "is_active"]
    search_fields = ["name", "version", "description", "file_sha256"]

    def perform_create(self, serializer):
        instance = serializer.save(created_by=self.request.user)
        write_audit_log(action="api.created", instance=instance, actor=self.request.user)


class AuditLogViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    permission_classes = [permissions.IsAdminUser]
    queryset = AuditLog.objects.select_related("actor")
    serializer_class = AuditLogSerializer
