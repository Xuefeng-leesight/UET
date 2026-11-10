"""HRT TCP 眼动数据流解析。"""

from __future__ import annotations

import json
from dataclasses import dataclass

MAGIC = b"<|"
HEADER_SIZE = 8
FIELD_COUNT = 15
MAX_BODY_BYTES = 999_999


@dataclass(frozen=True)
class EyeFrame:
    body_text: str
    body_bytes: int
    fields: list[object]


def parse_tcp_frames(buffer: bytes) -> tuple[list[EyeFrame], bytes, list[str]]:
    """解析任意 TCP 数据块，支持半包、粘包和异常前缀恢复。"""
    frames: list[EyeFrame] = []
    warnings: list[str] = []

    while buffer:
        if len(buffer) < 2:
            break
        if not buffer.startswith(MAGIC):
            magic_index = buffer.find(MAGIC)
            if magic_index < 0:
                keep = buffer[-1:] if buffer.endswith(b"<") else b""
                warnings.append(f"丢弃 {len(buffer) - len(keep)} 字节无效前缀")
                buffer = keep
                break
            warnings.append(f"丢弃 {magic_index} 字节无效前缀")
            buffer = buffer[magic_index:]
        if len(buffer) < HEADER_SIZE:
            break

        length_bytes = buffer[2:HEADER_SIZE]
        if not length_bytes.isdigit():
            warnings.append(f"无效长度字段：{length_bytes!r}")
            buffer = buffer[2:]
            continue
        body_length = int(length_bytes)
        if body_length > MAX_BODY_BYTES:
            warnings.append(f"包体长度超过限制：{body_length}")
            buffer = buffer[HEADER_SIZE:]
            continue
        frame_length = HEADER_SIZE + body_length
        if len(buffer) < frame_length:
            break

        body = buffer[HEADER_SIZE:frame_length]
        buffer = buffer[frame_length:]
        try:
            body_text = body.decode("utf-8")
            fields = json.loads(body_text)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            warnings.append(f"包体解码失败：{error}")
            continue
        if not isinstance(fields, list) or len(fields) != FIELD_COUNT:
            warnings.append(
                f"包体字段数量错误：期望 {FIELD_COUNT}，实际 "
                f"{len(fields) if isinstance(fields, list) else '非数组'}"
            )
            continue
        frames.append(EyeFrame(body_text=body_text, body_bytes=body_length, fields=fields))

    return frames, buffer, warnings
