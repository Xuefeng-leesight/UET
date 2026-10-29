from django.core.exceptions import ImproperlyConfigured
from rest_framework.response import Response
from rest_framework.views import exception_handler

from apps.licensing.exceptions import LicenseServiceError


def api_exception_handler(exc, context):
    request = context.get("request")
    request_id = getattr(request, "request_id", "")
    if isinstance(exc, LicenseServiceError):
        return Response(
            {
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "request_id": request_id,
                    "details": exc.details,
                }
            },
            status=exc.status_code,
        )
    if isinstance(exc, ImproperlyConfigured):
        return Response(
            {
                "error": {
                    "code": "SERVICE_NOT_CONFIGURED",
                    "message": "服务端签名能力尚未配置。",
                    "request_id": request_id,
                    "details": {},
                }
            },
            status=503,
        )
    response = exception_handler(exc, context)
    if response is None:
        return None
    code = getattr(exc, "default_code", "REQUEST_FAILED")
    if not isinstance(code, str):
        code = "REQUEST_FAILED"
    response.data = {
        "error": {
            "code": code.upper(),
            "message": "请求未通过校验。" if response.status_code == 400 else "请求失败。",
            "request_id": request_id,
            "details": response.data,
        }
    }
    return response
