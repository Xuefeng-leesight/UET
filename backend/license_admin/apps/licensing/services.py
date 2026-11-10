from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone as datetime_timezone

from django.db import transaction
from django.utils import timezone

from apps.audit.services import write_audit_log
from apps.customers.models import Customer, CustomerEyeTracker
from apps.customers.secrets import decrypt_softdog_password
from apps.licensing.exceptions import LicenseServiceError
from apps.licensing.models import License, LicenseDevice, hash_machine_code
from apps.licensing.signing import sign_payload


@dataclass(frozen=True)
class ActivationResult:
    device: LicenseDevice
    envelope: dict
    created: bool


def iso_utc(value: datetime) -> str:
    return value.astimezone(datetime_timezone.utc).isoformat().replace("+00:00", "Z")


def validate_license(license_obj: License, now: datetime) -> None:
    if license_obj.customer.status != Customer.Status.ACTIVE:
        raise LicenseServiceError("CUSTOMER_INACTIVE", "客户状态不可用。", status_code=403)
    if license_obj.status != License.Status.ACTIVE:
        code = "LICENSE_REVOKED" if license_obj.status == License.Status.REVOKED else "LICENSE_INACTIVE"
        raise LicenseServiceError(code, "License 当前不可用。", status_code=403)
    if now < license_obj.starts_at:
        raise LicenseServiceError("LICENSE_NOT_STARTED", "License 尚未生效。", status_code=403)
    if now >= license_obj.expires_at:
        raise LicenseServiceError("LICENSE_EXPIRED", "License 已过期。", status_code=403)


def active_modules(license_obj: License, now: datetime) -> list[dict]:
    result = []
    for item in license_obj.items.select_related("module").all():
        if not item.module.is_active:
            continue
        expires_at = item.expires_at or license_obj.expires_at
        if expires_at <= now:
            continue
        result.append(
            {
                "code": item.module.code,
                "name": item.module.name,
                "expires_at": iso_utc(expires_at),
            }
        )
    return result


def license_payload(
    license_obj: License,
    device: LicenseDevice,
    now: datetime | None = None,
    *,
    activation_mode: str = "online",
) -> dict:
    issued_at = now or timezone.now()
    modules = active_modules(license_obj, issued_at)
    if not modules:
        raise LicenseServiceError("NO_ACTIVE_MODULES", "License 没有可用模块。", status_code=403)
    # 0 表示仅受总授权到期时间限制；在线和离线签发使用相同规则。
    # 保留正数宽限配置的既有行为，签名字段及客户端协议不变。
    offline_valid_until = license_obj.expires_at
    if license_obj.offline_grace_days > 0:
        offline_valid_until = min(
            license_obj.expires_at,
            issued_at + timedelta(days=license_obj.offline_grace_days),
        )
    return {
        "license_id": str(license_obj.id),
        "customer": {"id": str(license_obj.customer_id), "name": license_obj.customer.name},
        "device_id": str(device.id),
        "device_hash": device.machine_hash,
        "activation_mode": activation_mode,
        "issued_at": iso_utc(issued_at),
        "not_before": iso_utc(license_obj.starts_at),
        "expires_at": iso_utc(license_obj.expires_at),
        "offline_grace_days": license_obj.offline_grace_days,
        "offline_valid_until": iso_utc(offline_valid_until),
        "modules": modules,
    }


def _find_license_for_update(license_key: str) -> License:
    try:
        return (
            License.objects.select_for_update()
            .select_related("customer")
            .prefetch_related("items__module")
            .get(license_key=license_key.strip().upper())
        )
    except License.DoesNotExist as exc:
        raise LicenseServiceError("LICENSE_NOT_FOUND", "授权号不存在。", status_code=404) from exc


@transaction.atomic
def activate_license(
    *,
    license_key: str,
    machine_code: str,
    device_name: str = "",
    client_version: str = "",
    platform: str = "",
    ip_address: str | None = None,
) -> ActivationResult:
    now = timezone.now()
    license_obj = _find_license_for_update(license_key)
    validate_license(license_obj, now)
    if not license_obj.allow_online_activation:
        raise LicenseServiceError("ONLINE_ACTIVATION_DISABLED", "此 License 不允许在线激活。", status_code=403)

    machine_hash = hash_machine_code(machine_code)
    device = LicenseDevice.objects.filter(license=license_obj, machine_hash=machine_hash).first()
    created = False
    if device is not None and device.status == LicenseDevice.Status.REVOKED:
        raise LicenseServiceError("DEVICE_REVOKED", "此设备已被吊销。", status_code=403)
    if device is None:
        active_count = LicenseDevice.objects.filter(
            license=license_obj, status=LicenseDevice.Status.ACTIVE
        ).count()
        if active_count >= license_obj.max_devices:
            raise LicenseServiceError(
                "DEVICE_LIMIT_REACHED",
                "已达到设备激活上限。",
                status_code=409,
                details={"max_devices": license_obj.max_devices, "active_devices": active_count},
            )
        device = LicenseDevice.objects.create(
            license=license_obj,
            machine_hash=machine_hash,
            platform=platform,
            device_name=device_name[:120],
            client_version=client_version[:40],
            last_ip=ip_address,
        )
        created = True
    else:
        if device.status == LicenseDevice.Status.DEACTIVATED:
            active_count = LicenseDevice.objects.filter(
                license=license_obj, status=LicenseDevice.Status.ACTIVE
            ).exclude(pk=device.pk).count()
            if active_count >= license_obj.max_devices:
                raise LicenseServiceError("DEVICE_LIMIT_REACHED", "已达到设备激活上限。", status_code=409)
            device.status = LicenseDevice.Status.ACTIVE
            device.deactivated_at = None
        device.device_name = device_name[:120] or device.device_name
        device.client_version = client_version[:40]
        if platform:
            device.platform = platform
        device.last_ip = ip_address
        device.last_seen_at = now
        device.save(
            update_fields=[
                "status", "deactivated_at", "device_name", "platform", "client_version", "last_ip", "last_seen_at", "updated_at"
            ]
        )

    envelope = sign_payload(license_payload(license_obj, device, now, activation_mode="online"))
    write_audit_log(
        action="device.activated" if created else "device.refreshed",
        instance=device,
        detail={"license_id": str(license_obj.id), "machine_hint": device.machine_hint},
    )
    return ActivationResult(device=device, envelope=envelope, created=created)


@transaction.atomic
def refresh_license(
    *, license_key: str, machine_code: str, client_version: str = "", platform: str = "", ip_address: str | None = None
) -> ActivationResult:
    now = timezone.now()
    license_obj = _find_license_for_update(license_key)
    validate_license(license_obj, now)
    machine_hash = hash_machine_code(machine_code)
    try:
        device = LicenseDevice.objects.get(license=license_obj, machine_hash=machine_hash)
    except LicenseDevice.DoesNotExist as exc:
        raise LicenseServiceError("DEVICE_NOT_ACTIVATED", "此设备尚未激活。", status_code=404) from exc
    if device.status != LicenseDevice.Status.ACTIVE:
        raise LicenseServiceError("DEVICE_INACTIVE", "设备激活状态不可用。", status_code=403)
    device.last_seen_at = now
    device.last_ip = ip_address
    device.client_version = client_version[:40]
    if platform:
        device.platform = platform
    device.save(update_fields=["last_seen_at", "last_ip", "client_version", "platform", "updated_at"])
    return ActivationResult(
        device=device,
        envelope=sign_payload(license_payload(license_obj, device, now, activation_mode="online")),
        created=False,
    )


@transaction.atomic
def deactivate_license(*, license_key: str, machine_code: str) -> LicenseDevice:
    license_obj = _find_license_for_update(license_key)
    machine_hash = hash_machine_code(machine_code)
    try:
        device = LicenseDevice.objects.get(license=license_obj, machine_hash=machine_hash)
    except LicenseDevice.DoesNotExist as exc:
        raise LicenseServiceError("DEVICE_NOT_ACTIVATED", "此设备尚未激活。", status_code=404) from exc
    if device.status == LicenseDevice.Status.REVOKED:
        raise LicenseServiceError("DEVICE_REVOKED", "吊销设备不能由客户端解绑。", status_code=403)
    device.status = LicenseDevice.Status.DEACTIVATED
    device.deactivated_at = timezone.now()
    device.save(update_fields=["status", "deactivated_at", "updated_at"])
    write_audit_log(action="device.deactivated", instance=device, detail={"machine_hint": device.machine_hint})
    return device


@transaction.atomic
def save_device_machine_code(
    *,
    license_obj: License,
    machine_code: str,
    device_name: str = "",
) -> LicenseDevice:
    """保存（或更新）一台设备的机器码，但不签发离线 License。

    用于运营先录入客户机器码、之后再单独签发的场景。机器码会持久化到
    LicenseDevice.machine_code，重新打开详情页仍可见。
    """
    locked = (
        License.objects.select_for_update()
        .select_related("customer")
        .get(pk=license_obj.pk)
    )
    now = timezone.now()
    validate_license(locked, now)

    machine_hash = hash_machine_code(machine_code)
    device, created = LicenseDevice.objects.get_or_create(
        license=locked,
        machine_hash=machine_hash,
        defaults={"device_name": device_name[:120], "last_seen_at": now},
    )
    if device.status == LicenseDevice.Status.REVOKED:
        raise LicenseServiceError("DEVICE_REVOKED", "此设备已被吊销。", status_code=403)
    if created:
        # 新建设备（默认 status=ACTIVE）后，判断除自己外是否已达上限。
        active_count = LicenseDevice.objects.filter(
            license=locked, status=LicenseDevice.Status.ACTIVE
        ).exclude(pk=device.pk).count()
        if active_count >= locked.max_devices:
            device.delete()
            raise LicenseServiceError("DEVICE_LIMIT_REACHED", "已达到设备激活上限。", status_code=409)

    device.machine_code = machine_code
    if device_name:
        device.device_name = device_name[:120]
    device.last_seen_at = now
    device.save(update_fields=["machine_code", "device_name", "last_seen_at", "updated_at"])

    write_audit_log(
        action="device.machine_code_saved",
        instance=device,
        detail={"machine_hint": device.machine_hint},
    )
    return device


@transaction.atomic
def issue_offline_license(*, license_obj: License, machine_code: str, device_name: str = "", platform: str = "") -> ActivationResult:
    locked = (
        License.objects.select_for_update()
        .select_related("customer")
        .prefetch_related("items__module")
        .get(pk=license_obj.pk)
    )
    now = timezone.now()
    validate_license(locked, now)
    if not locked.allow_offline_activation:
        raise LicenseServiceError("OFFLINE_ACTIVATION_DISABLED", "此 License 不允许离线授权。", status_code=403)
    machine_hash = hash_machine_code(machine_code)
    device, created = LicenseDevice.objects.get_or_create(
        license=locked,
        machine_hash=machine_hash,
        defaults={"platform": platform, "device_name": device_name[:120], "last_seen_at": now},
    )
    if device.status == LicenseDevice.Status.REVOKED:
        raise LicenseServiceError("DEVICE_REVOKED", "此设备已被吊销。", status_code=403)
    if created and locked.active_device_count > locked.max_devices:
        device.delete()
        raise LicenseServiceError("DEVICE_LIMIT_REACHED", "已达到设备激活上限。", status_code=409)
    if device.status == LicenseDevice.Status.DEACTIVATED:
        active_count = LicenseDevice.objects.filter(
            license=locked, status=LicenseDevice.Status.ACTIVE
        ).exclude(pk=device.pk).count()
        if active_count >= locked.max_devices:
            raise LicenseServiceError("DEVICE_LIMIT_REACHED", "已达到设备激活上限。", status_code=409)
        device.status = LicenseDevice.Status.ACTIVE
        device.deactivated_at = None
        device.save(update_fields=["status", "deactivated_at", "updated_at"])
    envelope = sign_payload(license_payload(locked, device, now, activation_mode="offline"))
    device.machine_code = machine_code
    if device_name:
        device.device_name = device_name[:120]
    device.offline_envelope = envelope
    device.save(update_fields=["machine_code", "device_name", "offline_envelope", "updated_at"])
    write_audit_log(action="license.offline_issued", instance=locked, detail={"machine_hint": device.machine_hint})
    return ActivationResult(device=device, envelope=envelope, created=created)


def normalize_device_type_code(value: str) -> str:
    """把客户端设备型号（Pro/A8/aSeeGlassesPlus）映射为后台 EyeTrackerType.code。"""
    normalized = value.strip().lower()
    if normalized in ("a8", "asee_a8", "asee-a8"):
        return "a8"
    if normalized in ("pro", "pro200", "desktop"):
        return "pro"
    if normalized in ("aseeglassesplus", "asee_glasses_plus", "asee-glasses-plus", "glassesplus"):
        return "asee-glasses-plus"
    return ""


def fetch_softdog_password(
    *,
    license_key: str,
    machine_code: str,
    device_model: str,
    serial_number: str = "",
) -> dict:
    """根据已激活的 License + 机器码 + 设备型号，下发该设备的 softdog 密码明文。

    设备型号（Pro/A8/aSeeGlassesPlus）映射为后台设备类型编码，匹配该客户名下
    对应型号的 active 设备；serial_number 可选，用于同型号多台时精确匹配。
    仅当设备已录入密码（softdog_password_ciphertext 非空）时返回明文，否则
    configured=False，由客户端回退到本地配置或人工输入。
    """
    now = timezone.now()
    try:
        license_obj = License.objects.select_related("customer").get(
            license_key=license_key.strip().upper()
        )
    except License.DoesNotExist as exc:
        raise LicenseServiceError("LICENSE_NOT_FOUND", "授权号不存在。", status_code=404) from exc
    validate_license(license_obj, now)

    machine_hash = hash_machine_code(machine_code)
    device = LicenseDevice.objects.filter(
        license=license_obj,
        machine_hash=machine_hash,
        status=LicenseDevice.Status.ACTIVE,
    ).first()
    if device is None:
        raise LicenseServiceError("DEVICE_NOT_ACTIVATED", "此设备尚未激活。", status_code=404)

    type_code = normalize_device_type_code(device_model)
    if not type_code:
        raise LicenseServiceError("INVALID_DEVICE_TYPE", "无效的设备类型。", status_code=400)

    eye_trackers = CustomerEyeTracker.objects.filter(
        customer_id=license_obj.customer_id,
        device_type__code=type_code,
        status=CustomerEyeTracker.Status.ACTIVE,
    )
    if serial_number.strip():
        eye_trackers = eye_trackers.filter(serial_number=serial_number.strip())

    eye_tracker = eye_trackers.first()
    if eye_tracker is None:
        raise LicenseServiceError("EYE_TRACKER_NOT_FOUND", "未找到匹配的眼动设备。", status_code=404)

    if not eye_tracker.softdog_password_ciphertext:
        return {"configured": False, "password": None}

    password = decrypt_softdog_password(eye_tracker.softdog_password_ciphertext)
    write_audit_log(
        action="softdog_password.provisioned",
        instance=eye_tracker,
        detail={"license_id": str(license_obj.id), "machine_hint": device.machine_hint},
    )
    return {"configured": True, "password": password}


def check_license_status(*, license_id: str, machine_code: str) -> dict:
    """联网自检：按 license_id + machine_code 判断该设备是否仍被授权。

    用于离线 License 联网时校验后台状态——后台删除/解绑/吊销 License 后，
    能联网的机器立即发现并锁定。返回 {"valid": bool, "code": str}，不抛错。
    """
    from django.core.exceptions import ValidationError

    # license_id 可能不是合法 UUID，filter 对 UUIDField 仍会抛 ValidationError，需兜底。
    try:
        license_obj = License.objects.filter(pk=license_id).select_related("customer").first()
    except ValidationError:
        license_obj = None
    if license_obj is None:
        return {"valid": False, "code": "LICENSE_NOT_FOUND"}

    now = timezone.now()
    try:
        validate_license(license_obj, now)
    except LicenseServiceError as exc:
        return {"valid": False, "code": exc.code}

    machine_hash = hash_machine_code(machine_code)
    device = LicenseDevice.objects.filter(license=license_obj, machine_hash=machine_hash).first()
    if device is None:
        return {"valid": False, "code": "DEVICE_NOT_ACTIVATED"}
    if device.status != LicenseDevice.Status.ACTIVE:
        code = "DEVICE_REVOKED" if device.status == LicenseDevice.Status.REVOKED else "DEVICE_INACTIVE"
        return {"valid": False, "code": code}
    return {"valid": True, "code": ""}
