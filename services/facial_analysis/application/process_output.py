from __future__ import annotations


def decode_process_output(value: bytes | str | None) -> str:
    """Decode subprocess diagnostics without trusting the Windows code page.

    Packaged FFmpeg builds may emit UTF-8 even when Python reports GBK/CP936.
    Diagnostic text must never make successful media finalization fail, so try
    known encodings first and replace only undecodable bytes as a last resort.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    for encoding in ("utf-8", "gb18030"):
        try:
            return value.decode(encoding)
        except UnicodeDecodeError:
            continue
    return value.decode("utf-8", errors="replace")
