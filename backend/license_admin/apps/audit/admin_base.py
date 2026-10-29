from apps.audit.services import write_audit_log


class AuditModelAdminMixin:
    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        write_audit_log(action="admin.updated" if change else "admin.created", instance=obj)

    def delete_model(self, request, obj):
        write_audit_log(action="admin.deleted", instance=obj)
        super().delete_model(request, obj)
