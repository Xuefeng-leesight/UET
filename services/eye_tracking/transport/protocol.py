"""Pure WebSocket command parsing and recording lifecycle responses."""

from __future__ import annotations

import json
from typing import Any


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


def recording_stop_response(stop_result: dict[str, Any], last_result: dict[str, Any]) -> dict[str, Any]:
    accepted = bool(stop_result.get("accepted"))
    status = "finalizing" if accepted else ("finalized" if last_result else "idle")
    return {
        "type": "rsp_cmd",
        "id": "stop_recording",
        "error": 0,
        "msg": "finalizing" if accepted else ("finalized" if last_result else "already stopped"),
        "status": status,
        "result": last_result,
        "recording_id": stop_result.get("recording_id", ""),
        "video_path": stop_result.get("video_path", ""),
        "csv_path": stop_result.get("csv_path", ""),
    }


def recording_status_response(*, finalizing: bool, recording: bool, last_result: dict[str, Any]) -> dict[str, Any]:
    status = "finalizing" if finalizing else ("recording" if recording else ("finalized" if last_result else "idle"))
    return {
        "type": "rsp_cmd",
        "id": "get_recording_status",
        "error": 0,
        "msg": "ok",
        "status": status,
        "result": last_result,
    }
