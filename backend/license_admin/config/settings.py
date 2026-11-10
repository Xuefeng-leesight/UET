from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import unquote, urlparse

from django.urls import reverse_lazy


BASE_DIR = Path(__file__).resolve().parent.parent


def load_local_env() -> None:
    """Load an ignored local .env without overriding Docker/server variables."""
    env_path = BASE_DIR / ".env"
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip()
        if name and name not in os.environ:
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            os.environ[name] = value


load_local_env()


def env_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


def admin_permission(permission: str):
    """Return an Unfold sidebar permission callback for a Django permission."""

    return lambda request: request.user.has_perm(permission)


SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "dev-only-insecure-secret-key-change-before-production")
DEBUG = env_bool("DJANGO_DEBUG", True)
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "127.0.0.1,localhost")
CSRF_TRUSTED_ORIGINS = env_list("DJANGO_CSRF_TRUSTED_ORIGINS")

if not DEBUG and SECRET_KEY.startswith("dev-only-"):
    raise RuntimeError("Production requires DJANGO_SECRET_KEY.")

INSTALLED_APPS = [
    "unfold",
    "unfold.contrib.filters",
    "unfold.contrib.inlines",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "drf_spectacular",
    "apps.audit",
    "apps.customers",
    "apps.licensing",
    "apps.releases",
    "apps.api",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "apps.audit.middleware.RequestAuditContextMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    }
]
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"


def database_config() -> dict:
    value = os.getenv("DATABASE_URL", "").strip()
    postgres_host = os.getenv("POSTGRES_HOST", "").strip()

    if not value and postgres_host:
        return {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": os.getenv("POSTGRES_DB", "ust_license"),
            "USER": os.getenv("POSTGRES_USER", "ust"),
            "PASSWORD": os.getenv("POSTGRES_PASSWORD", ""),
            "HOST": postgres_host,
            "PORT": os.getenv("POSTGRES_PORT", "5432"),
            "CONN_MAX_AGE": 60,
        }

    value = value or f"sqlite:///{BASE_DIR / 'db.sqlite3'}"
    parsed = urlparse(value)
    if parsed.scheme == "sqlite":
        if value.startswith("sqlite:////"):
            db_name = "/" + unquote(value.removeprefix("sqlite:////"))
        else:
            relative_name = unquote(value.removeprefix("sqlite:///")).lstrip("/")
            db_name = str(BASE_DIR / (relative_name or "db.sqlite3"))
        return {"ENGINE": "django.db.backends.sqlite3", "NAME": db_name}
    if parsed.scheme in {"postgres", "postgresql"}:
        return {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": unquote(parsed.path.lstrip("/")),
            "USER": unquote(parsed.username or ""),
            "PASSWORD": unquote(parsed.password or ""),
            "HOST": parsed.hostname or "",
            "PORT": parsed.port or 5432,
            "CONN_MAX_AGE": 60,
        }
    raise RuntimeError("DATABASE_URL must use sqlite, postgres, or postgresql.")


DATABASES = {"default": database_config()}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "zh-hans"
TIME_ZONE = "Asia/Shanghai"
USE_I18N = True
USE_TZ = True
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "media"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
# IP + 纯 HTTP 部署时需要显式设 DJANGO_SESSION_COOKIE_SECURE=false /
# DJANGO_CSRF_COOKIE_SECURE=false，否则浏览器在 http 下不会保存 secure cookie，
# 后台 admin 登录后会立即掉线。
SESSION_COOKIE_SECURE = env_bool("DJANGO_SESSION_COOKIE_SECURE", not DEBUG)
CSRF_COOKIE_SECURE = env_bool("DJANGO_CSRF_COOKIE_SECURE", not DEBUG)
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_SSL_REDIRECT = env_bool("DJANGO_SECURE_SSL_REDIRECT", not DEBUG)
SECURE_HSTS_SECONDS = int(os.getenv("DJANGO_SECURE_HSTS_SECONDS", "0" if DEBUG else "31536000"))
SECURE_HSTS_INCLUDE_SUBDOMAINS = not DEBUG
SECURE_HSTS_PRELOAD = not DEBUG
X_FRAME_OPTIONS = "DENY"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
        "rest_framework.authentication.BasicAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "EXCEPTION_HANDLER": "apps.api.exceptions.api_exception_handler",
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {"anon": "120/min", "user": "600/min", "activation": "20/min"},
}

SPECTACULAR_SETTINGS = {
    "TITLE": "UST License 与版本管理 API",
    "DESCRIPTION": "UST PC/安卓客户端、测试工具与后台管理端的版本化接口。",
    "VERSION": "1.1.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "ENUM_NAME_OVERRIDES": {
        "CustomerStatusEnum": ["active", "suspended", "closed"],
        "CustomerEyeTrackerStatusEnum": [
            ("active", "正常"),
            ("maintenance", "维护中"),
            ("retired", "已停用"),
        ],
        "LicenseStatusEnum": ["draft", "active", "suspended", "revoked", "expired"],
        "LicenseDeviceStatusEnum": ["active", "deactivated", "revoked"],
        "ReleaseStatusEnum": ["draft", "published", "withdrawn"],
        "ReleaseProductTypeEnum": [("pc", "PC 端"), ("android", "安卓端")],
        "ReleasePlatformEnum": [
            ("windows", "Windows"), ("macos", "macOS"),
            ("linux", "Linux"), ("android", "Android"),
        ],
        "TestToolPlatformEnum": [
            ("windows", "Windows"), ("macos", "macOS"), ("linux", "Linux"),
            ("android", "Android"), ("universal", "通用"),
        ],
    },
}

UNFOLD = {
    "SITE_TITLE": "UST 运营后台",
    "SITE_HEADER": "UST License 与版本管理",
    "SITE_SUBHEADER": "客户、授权、设备与版本发布",
    "SITE_SYMBOL": "admin_panel_settings",
    "SHOW_HISTORY": True,
    "SHOW_VIEW_ON_SITE": False,
    "DASHBOARD_CALLBACK": "apps.dashboard.separate_customer_product_dashboard",
    "SIDEBAR": {
        "show_search": True,
        "show_all_applications": False,
        "navigation": [
            {
                "title": "工作台",
                "separator": True,
                "items": [
                    {
                        "title": "运营控制台",
                        "icon": "dashboard",
                        "link": reverse_lazy("admin:index"),
                    },
                ],
            },
            {
                "title": "客户管理",
                "separator": True,
                "items": [
                    {
                        "title": "客户",
                        "icon": "domain",
                        "link": reverse_lazy("admin:customers_customer_changelist"),
                        "permission": admin_permission("customers.view_customer"),
                    },
                    {
                        "title": "客户眼动设备",
                        "icon": "visibility",
                        "link": reverse_lazy("admin:customers_customereyetracker_changelist"),
                        "permission": admin_permission("customers.view_customereyetracker"),
                    },
                ],
            },
            {
                "title": "产品管理",
                "separator": True,
                "items": [
                    {
                        "title": "产品能力模块",
                        "icon": "extension",
                        "link": reverse_lazy("admin:customers_productmodule_changelist"),
                        "permission": admin_permission("customers.view_productmodule"),
                    },
                    {
                        "title": "眼动设备类型",
                        "icon": "devices_other",
                        "link": reverse_lazy("admin:customers_eyetrackertype_changelist"),
                        "permission": admin_permission("customers.view_eyetrackertype"),
                    },
                ],
            },
            {
                "title": "License 管理",
                "separator": True,
                "items": [
                    {
                        "title": "License",
                        "icon": "license",
                        "link": reverse_lazy("admin:licensing_license_changelist"),
                        "permission": admin_permission("licensing.view_license"),
                    },
                    {
                        "title": "授权模块明细",
                        "icon": "fact_check",
                        "link": reverse_lazy("admin:licensing_licenseitem_changelist"),
                        "permission": admin_permission("licensing.view_licenseitem"),
                    },
                    {
                        "title": "激活设备",
                        "icon": "computer",
                        "link": reverse_lazy("admin:licensing_licensedevice_changelist"),
                        "permission": admin_permission("licensing.view_licensedevice"),
                    },
                ],
            },
            {
                "title": "版本管理",
                "separator": True,
                "items": [
                    {
                        "title": "软件版本",
                        "icon": "deployed_code",
                        "link": reverse_lazy("admin:releases_release_changelist"),
                        "permission": admin_permission("releases.view_release"),
                    },
                    {
                        "title": "测试工具",
                        "icon": "build",
                        "link": reverse_lazy("admin:releases_testtool_changelist"),
                        "permission": admin_permission("releases.view_testtool"),
                    },
                    {
                        "title": "下载记录",
                        "icon": "download",
                        "link": reverse_lazy("admin:releases_downloadevent_changelist"),
                        "permission": admin_permission("releases.view_downloadevent"),
                    },
                    {
                        "title": "测试工具下载记录",
                        "icon": "download_for_offline",
                        "link": reverse_lazy("admin:releases_testtooldownloadevent_changelist"),
                        "permission": admin_permission("releases.view_testtooldownloadevent"),
                    },
                ],
            },
            {
                "title": "系统管理",
                "separator": True,
                "items": [
                    {
                        "title": "操作审计",
                        "icon": "history",
                        "link": reverse_lazy("admin:audit_auditlog_changelist"),
                        "permission": admin_permission("audit.view_auditlog"),
                    },
                    {
                        "title": "用户",
                        "icon": "person",
                        "link": reverse_lazy("admin:auth_user_changelist"),
                        "permission": admin_permission("auth.view_user"),
                    },
                    {
                        "title": "角色与权限",
                        "icon": "group",
                        "link": reverse_lazy("admin:auth_group_changelist"),
                        "permission": admin_permission("auth.view_group"),
                    },
                ],
            },
        ],
    },
}

LICENSE_SIGNING_KEY_ID = os.getenv("LICENSE_SIGNING_KEY_ID", "ust-dev-01")
LICENSE_SIGNING_PRIVATE_KEY = os.getenv("LICENSE_SIGNING_PRIVATE_KEY", "")
LICENSE_PUBLIC_KEYS = json.loads(os.getenv("LICENSE_PUBLIC_KEYS", "{}"))
LICENSE_MAX_UPLOAD_BYTES = int(os.getenv("LICENSE_MAX_UPLOAD_BYTES", str(2 * 1024**3)))
DEVICE_SECRET_ENCRYPTION_KEY = os.getenv("DEVICE_SECRET_ENCRYPTION_KEY", "")

# 大文件下载走 nginx X-Accel-Redirect（sendfile 直发，绕开 gunicorn worker 超时）。
# 仅在 nginx 反代环境开启；本地 runserver/sqlite 下关闭，退回 FileResponse 流式下载。
DOWNLOAD_USE_X_ACCEL = env_bool("DJANGO_DOWNLOAD_X_ACCEL", False)
DOWNLOAD_X_ACCEL_PREFIX = os.getenv("DJANGO_DOWNLOAD_X_ACCEL_PREFIX", "/internal-download/").rstrip("/") + "/"

if not DEBUG and not DEVICE_SECRET_ENCRYPTION_KEY:
    raise RuntimeError("生产环境必须配置 DEVICE_SECRET_ENCRYPTION_KEY。")
