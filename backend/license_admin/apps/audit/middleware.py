import re
import uuid

from apps.audit.context import AuditContext, current_audit_context


REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")


def client_ip(request) -> str | None:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip() or None
    return request.META.get("REMOTE_ADDR") or None


class RequestAuditContextMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        supplied = request.headers.get("X-Request-ID", "")
        request_id = supplied if REQUEST_ID_PATTERN.fullmatch(supplied) else str(uuid.uuid4())
        request.request_id = request_id
        token = current_audit_context.set(
            AuditContext(request_id=request_id, ip_address=client_ip(request), actor=getattr(request, "user", None))
        )
        try:
            response = self.get_response(request)
            response["X-Request-ID"] = request_id
            return response
        finally:
            current_audit_context.reset(token)
