"""System mouse cursor for screen recordings (Windows only).

Screen capture (MSS/DXGI) never includes the cursor, so the recorder reads its
position for the gaze CSV and paints the real cursor image into each frame.
Every call is best effort: a failure returns None or leaves the frame as-is and
never stops a recording.
"""

import ctypes
import os
from ctypes import wintypes

import numpy as np

_CURSOR_SHOWING = 0x1
_DI_NORMAL = 0x3
_BI_RGB = 0
_DIB_RGB_COLORS = 0
_MAX_CURSOR_SIDE = 256


class _CURSORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("hCursor", wintypes.HANDLE), ("ptScreenPos", wintypes.POINT)]


class _ICONINFO(ctypes.Structure):
    _fields_ = [("fIcon", wintypes.BOOL), ("xHotspot", wintypes.DWORD), ("yHotspot", wintypes.DWORD),
                ("hbmMask", wintypes.HBITMAP), ("hbmColor", wintypes.HBITMAP)]


class _BITMAP(ctypes.Structure):
    _fields_ = [("bmType", wintypes.LONG), ("bmWidth", wintypes.LONG), ("bmHeight", wintypes.LONG),
                ("bmWidthBytes", wintypes.LONG), ("bmPlanes", wintypes.WORD), ("bmBitsPixel", wintypes.WORD),
                ("bmBits", ctypes.c_void_p)]


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


def _load_win32():
    if os.name != "nt":
        return None, None
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    except OSError:
        return None, None
    # Monitor bounds from MSS are physical pixels and the cursor must use the
    # same space. This module deliberately does not change DPI awareness: doing
    # it at import would switch the whole backend (and the eye tracker SDK)
    # before the first calibration. MSS makes the process per-monitor aware when
    # the recorder opens it, and both callers only run after that.
    user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    user32.GetCursorInfo.argtypes = [ctypes.POINTER(_CURSORINFO)]
    user32.GetIconInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ICONINFO)]
    user32.DrawIconEx.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.HANDLE, ctypes.c_int,
                                  ctypes.c_int, wintypes.UINT, wintypes.HBRUSH, wintypes.UINT]
    gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi32.CreateCompatibleDC.restype = wintypes.HDC
    gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.POINTER(_BITMAPINFOHEADER), wintypes.UINT,
                                       ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
    gdi32.CreateDIBSection.restype = wintypes.HBITMAP
    gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi32.SelectObject.restype = wintypes.HGDIOBJ
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    gdi32.GetObjectW.argtypes = [wintypes.HGDIOBJ, ctypes.c_int, ctypes.c_void_p]
    return user32, gdi32


_user32, _gdi32 = _load_win32()


def cursor_position():
    """Physical screen pixel position of the cursor, or None."""
    if _user32 is None:
        return None
    point = wintypes.POINT()
    if not _user32.GetCursorPos(ctypes.byref(point)):
        return None
    return point.x, point.y


def normalized_cursor(monitor):
    """Cursor as 0..1 of the captured monitor (same space as the gaze columns), or None off-screen."""
    position = cursor_position() if monitor else None
    if position is None:
        return None
    width, height = monitor.get("width") or 0, monitor.get("height") or 0
    if width <= 0 or height <= 0:
        return None
    x = (position[0] - monitor["left"]) / width
    y = (position[1] - monitor["top"]) / height
    if not (0.0 <= x < 1.0 and 0.0 <= y < 1.0):
        return None
    return x, y


class CursorPainter:
    """Paints the visible system cursor into recorded frames, caching each cursor shape."""

    def __init__(self):
        self._cache = {}

    def _render(self, handle):
        """Return (bgr float32, alpha float32 0..1, hot_x, hot_y) for a cursor handle, or None."""
        info = _ICONINFO()
        if not _user32.GetIconInfo(handle, ctypes.byref(info)):
            return None
        try:
            bitmap = _BITMAP()
            source = info.hbmColor or info.hbmMask
            if not source or not _gdi32.GetObjectW(source, ctypes.sizeof(bitmap), ctypes.byref(bitmap)):
                return None
            width = bitmap.bmWidth
            # A monochrome cursor stacks its AND and XOR masks in one bitmap.
            height = bitmap.bmHeight if info.hbmColor else bitmap.bmHeight // 2
            if not (0 < width <= _MAX_CURSOR_SIDE and 0 < height <= _MAX_CURSOR_SIDE):
                return None
            # Drawing on black and on white recovers both colour and coverage,
            # which also handles monochrome and inverting cursors.
            black = self._draw_on(handle, width, height, 0x00)
            white = self._draw_on(handle, width, height, 0xFF)
            if black is None or white is None:
                return None
            alpha = 1.0 - (white - black).mean(axis=2, keepdims=True) / 255.0
            alpha = np.clip(alpha, 0.0, 1.0)
            color = np.where(alpha > 0.0, black / np.maximum(alpha, 1e-6), 0.0)
            return np.clip(color, 0.0, 255.0), alpha, int(info.xHotspot), int(info.yHotspot)
        finally:
            if info.hbmMask:
                _gdi32.DeleteObject(info.hbmMask)
            if info.hbmColor:
                _gdi32.DeleteObject(info.hbmColor)

    @staticmethod
    def _draw_on(handle, width, height, fill):
        header = _BITMAPINFOHEADER(ctypes.sizeof(_BITMAPINFOHEADER), width, -height, 1, 32, _BI_RGB, 0, 0, 0, 0, 0)
        dc = _gdi32.CreateCompatibleDC(None)
        if not dc:
            return None
        bits = ctypes.c_void_p()
        dib = _gdi32.CreateDIBSection(dc, ctypes.byref(header), _DIB_RGB_COLORS, ctypes.byref(bits), None, 0)
        try:
            if not dib or not bits.value:
                return None
            previous = _gdi32.SelectObject(dc, dib)
            size = width * height * 4
            ctypes.memset(bits, fill, size)
            drawn = _user32.DrawIconEx(dc, 0, 0, handle, width, height, 0, None, _DI_NORMAL)
            pixels = np.frombuffer(ctypes.string_at(bits, size), dtype=np.uint8).reshape(height, width, 4)
            _gdi32.SelectObject(dc, previous)
            if not drawn:
                return None
            return pixels[:, :, :3].astype(np.float32)
        finally:
            if dib:
                _gdi32.DeleteObject(dib)
            _gdi32.DeleteDC(dc)

    def paint(self, frame, monitor):
        """Blend the cursor into a BGR frame scaled from `monitor`; returns the frame to write."""
        if _user32 is None or not monitor:
            return frame
        try:
            info = _CURSORINFO(ctypes.sizeof(_CURSORINFO))
            if not _user32.GetCursorInfo(ctypes.byref(info)) or not (info.flags & _CURSOR_SHOWING) or not info.hCursor:
                return frame
            handle = info.hCursor
            if handle not in self._cache:
                if len(self._cache) > 64:
                    self._cache.clear()
                self._cache[handle] = self._render(handle)
            shape = self._cache[handle]
            if shape is None:
                return frame
            color, alpha, hot_x, hot_y = shape
            frame_h, frame_w = frame.shape[:2]
            scale_x = frame_w / monitor["width"]
            scale_y = frame_h / monitor["height"]
            if abs(scale_x - 1.0) > 0.01 or abs(scale_y - 1.0) > 0.01:
                import cv2
                size = (max(1, round(color.shape[1] * scale_x)), max(1, round(color.shape[0] * scale_y)))
                color = cv2.resize(color, size, interpolation=cv2.INTER_AREA)
                alpha = cv2.resize(alpha, size, interpolation=cv2.INTER_AREA)[:, :, None]
            left = round((info.ptScreenPos.x - monitor["left"] - hot_x) * scale_x)
            top = round((info.ptScreenPos.y - monitor["top"] - hot_y) * scale_y)
            x0, y0 = max(0, left), max(0, top)
            x1, y1 = min(frame_w, left + color.shape[1]), min(frame_h, top + color.shape[0])
            if x0 >= x1 or y0 >= y1:
                return frame
            # A DXGI grab is a view of the capture buffer that the next grab can
            # return again unchanged; painting into it would leave cursor trails.
            if not frame.flags.writeable or not frame.flags.owndata:
                frame = frame.copy()
            region = frame[y0:y1, x0:x1].astype(np.float32)
            a = alpha[y0 - top:y1 - top, x0 - left:x1 - left]
            c = color[y0 - top:y1 - top, x0 - left:x1 - left]
            frame[y0:y1, x0:x1] = (c * a + region * (1.0 - a)).astype(np.uint8)
        except Exception:
            pass
        return frame
