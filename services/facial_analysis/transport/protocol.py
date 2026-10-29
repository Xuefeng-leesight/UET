"""Pure parsing helpers for the facial analysis WebSocket service."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Sequence


@dataclass(frozen=True)
class FacialServicePorts:
    image: int = 9011
    data: int = 9012
    command: int = 9013


def parse_command_request(message: str) -> dict[str, Any] | None:
    try:
        value = json.loads(message)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("type") != "req_cmd":
        return None
    command_id = value.get("id")
    if not isinstance(command_id, str) or not command_id.strip():
        return None
    args = value.get("args", {})
    if not isinstance(args, dict):
        args = {}
    return {**value, "id": command_id.strip(), "args": args}


def parse_service_ports(argv: Sequence[str]) -> FacialServicePorts:
    values = [9011, 9012, 9013]
    for index, raw in enumerate(argv[:3]):
        port = int(raw)
        if not 1 <= port <= 65535:
            raise ValueError(f"port out of range: {port}")
        values[index] = port
    if len(set(values)) != len(values):
        raise ValueError("facial service ports must be distinct")
    return FacialServicePorts(image=values[0], data=values[1], command=values[2])
