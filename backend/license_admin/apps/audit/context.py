from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AuditContext:
    request_id: str = ""
    ip_address: str | None = None
    actor: Any = None


current_audit_context: ContextVar[AuditContext] = ContextVar(
    "current_audit_context", default=AuditContext()
)
