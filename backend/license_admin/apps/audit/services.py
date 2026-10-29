from typing import Any

from apps.audit.context import current_audit_context
from apps.audit.models import AuditLog


def write_audit_log(
    *,
    action: str,
    instance: Any | None = None,
    object_type: str = "",
    object_id: str = "",
    object_repr: str = "",
    detail: dict | None = None,
    actor: Any | None = None,
) -> AuditLog:
    context = current_audit_context.get()
    selected_actor = actor if getattr(actor, "is_authenticated", False) else context.actor
    selected_actor = selected_actor if getattr(selected_actor, "is_authenticated", False) else None
    if instance is not None:
        object_type = instance._meta.label
        object_id = str(instance.pk or "")
        object_repr = str(instance)[:300]
    return AuditLog.objects.create(
        actor=selected_actor,
        action=action,
        object_type=object_type,
        object_id=object_id,
        object_repr=object_repr,
        detail=detail or {},
        request_id=context.request_id,
        ip_address=context.ip_address,
    )
