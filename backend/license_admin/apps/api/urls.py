from django.urls import include, path
from rest_framework.routers import DefaultRouter

from apps.api.views import (
    ActivationView,
    AuditLogViewSet,
    CustomerViewSet,
    CustomerEyeTrackerViewSet,
    DeactivationView,
    HealthView,
    LatestReleaseView,
    LicenseCheckView,
    LicenseDeviceViewSet,
    LicenseItemViewSet,
    LicenseViewSet,
    ProductModuleViewSet,
    PublicTestToolListView,
    EyeTrackerTypeViewSet,
    ReleaseDownloadView,
    ReleaseViewSet,
    SigningKeyView,
    SoftdogPasswordView,
    TestToolDownloadView,
    TestToolViewSet,
    VerifyLicenseView,
)

router = DefaultRouter()
router.register("customers", CustomerViewSet)
router.register("modules", ProductModuleViewSet)
router.register("eye-tracker-types", EyeTrackerTypeViewSet)
router.register("customer-eye-trackers", CustomerEyeTrackerViewSet)
router.register("licenses", LicenseViewSet)
router.register("license-items", LicenseItemViewSet)
router.register("devices", LicenseDeviceViewSet)
router.register("releases", ReleaseViewSet)
router.register("test-tools", TestToolViewSet)
router.register("audit-logs", AuditLogViewSet)

urlpatterns = [
    path("health", HealthView.as_view(), name="health"),
    path("client/activations", ActivationView.as_view(), name="client-activation"),
    path("client/activations/deactivate", DeactivationView.as_view(), name="client-deactivation"),
    path("client/licenses/verify", VerifyLicenseView.as_view(), name="client-license-verify"),
    path("client/licenses/check", LicenseCheckView.as_view(), name="client-license-check"),
    path("client/devices/softdog-password", SoftdogPasswordView.as_view(), name="client-softdog-password"),
    path("client/signing-keys/<str:key_id>", SigningKeyView.as_view(), name="client-signing-key"),
    path("client/releases/latest", LatestReleaseView.as_view(), name="client-latest-release"),
    path(
        "client/releases/<uuid:download_token>/download",
        ReleaseDownloadView.as_view(),
        name="client-release-download",
    ),
    path("client/test-tools", PublicTestToolListView.as_view(), name="client-test-tool-list"),
    path(
        "client/test-tools/<uuid:download_token>/download",
        TestToolDownloadView.as_view(),
        name="client-test-tool-download",
    ),
    path("management/", include(router.urls)),
]
