from __future__ import annotations

import hashlib

from django.db.models import QuerySet
from django.utils import timezone
from packaging.version import InvalidVersion, Version

from apps.releases.models import Release


def rollout_includes(release: Release, machine_hash: str) -> bool:
    if release.rollout_percentage >= 100:
        return True
    if release.rollout_percentage <= 0 or not machine_hash:
        return False
    bucket = int(hashlib.sha256(f"{release.id}:{machine_hash}".encode()).hexdigest()[:8], 16) % 100
    return bucket < release.rollout_percentage


def latest_release(
    *,
    product_type: str = Release.ProductType.PC,
    platform: str,
    architecture: str,
    channel: str,
    current_version: str = "",
    machine_hash: str = "",
) -> tuple[Release | None, bool, bool]:
    candidates: QuerySet[Release] = Release.objects.filter(
        product_type=product_type,
        platform=platform,
        architecture=architecture,
        channel=channel,
        status=Release.Status.PUBLISHED,
        published_at__lte=timezone.now(),
    )
    try:
        installed = Version(current_version) if current_version else None
        invalid_current_version = False
    except InvalidVersion:
        installed = None
        invalid_current_version = True

    def mandatory(release: Release) -> bool:
        if release.force_update:
            return True
        if invalid_current_version:
            return True
        return bool(
            installed is not None
            and release.minimum_supported_version
            and installed < Version(release.minimum_supported_version)
        )

    included = [
        release for release in candidates if mandatory(release) or rollout_includes(release, machine_hash)
    ]
    if not included:
        return None, False, False
    release = max(included, key=lambda item: item.parsed_version)
    if not current_version:
        return release, True, release.force_update
    if invalid_current_version:
        return release, True, True
    assert installed is not None
    update_available = installed < release.parsed_version
    force_update = release.force_update and update_available
    if update_available and release.minimum_supported_version:
        force_update = force_update or installed < Version(release.minimum_supported_version)
    return release, update_available, force_update
