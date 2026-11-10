"""Read parent liveness pipes without holding Windows CRT descriptor locks.

NumPy/OpenBLAS DLL loading can deadlock against a background Python stdin read
on Windows (numpy/numpy#24290). Even a raw blocking ReadFile left NumPy stuck
on the target machine. Peek first and only read available bytes; the monitor
must be the sole reader of this pipe so another thread cannot consume them.
The caller owns the stream; this reader never closes or duplicates its handle.
Use only for the control pipe, after any initial worker task has been consumed.
"""
import sys
import time


def parent_pipe_reader(stream):
    if sys.platform != 'win32':
        return stream.read
    import ctypes
    from ctypes import wintypes
    import msvcrt

    handle = wintypes.HANDLE(msvcrt.get_osfhandle(stream.fileno()))
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    read_file = kernel.ReadFile
    read_file.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                          ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
    read_file.restype = wintypes.BOOL
    peek = kernel.PeekNamedPipe
    peek.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                     ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
                     ctypes.POINTER(wintypes.DWORD)]
    peek.restype = wintypes.BOOL

    def read(size):
        available = wintypes.DWORD()
        while True:
            if not peek(handle, None, 0, None, ctypes.byref(available), None):
                error = ctypes.get_last_error()
                if error == 109:
                    return b''
                raise ctypes.WinError(error)
            if available.value:
                break
            time.sleep(.02)
        size = min(size, available.value)
        buffer = ctypes.create_string_buffer(size)
        count = wintypes.DWORD()
        if not read_file(handle, buffer, size, ctypes.byref(count), None):
            error = ctypes.get_last_error()
            if error == 109:  # ERROR_BROKEN_PIPE: parent closed its write end.
                return b''
            raise ctypes.WinError(error)
        return buffer.raw[:count.value]
    return read


def wait_for_parent(read, *, shutdown_command=False):
    line = bytearray()
    while True:
        chunk = read(1)
        if not chunk:
            return
        if shutdown_command:
            if chunk == b'\n':
                if line.strip() == b'shutdown':
                    return
                line.clear()
            else:
                line.extend(chunk)
                if len(line) > 1024:
                    raise ValueError('Parent control command exceeds limit')
