"""Firefox native-messaging host for revealing local paths in File Explorer."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
import struct
import sys
from typing import BinaryIO, Callable

MAX_MESSAGE_BYTES = 1024 * 1024
COINIT_APARTMENTTHREADED = 0x2
COINIT_DISABLE_OLE1DDE = 0x4
SW_SHOWNORMAL = 1


class NativeHostError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def read_message(stream: BinaryIO) -> dict | None:
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise NativeHostError("invalid_frame", "Incomplete native-message header")
    (message_length,) = struct.unpack("<I", header)
    if message_length == 0 or message_length > MAX_MESSAGE_BYTES:
        raise NativeHostError("invalid_frame", "Invalid native-message length")
    payload = stream.read(message_length)
    if len(payload) != message_length:
        raise NativeHostError("invalid_frame", "Incomplete native-message payload")
    try:
        message = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise NativeHostError("invalid_json", "Native message is not valid UTF-8 JSON") from exc
    if not isinstance(message, dict):
        raise NativeHostError("invalid_request", "Native message must be a JSON object")
    return message


def write_message(stream: BinaryIO, message: dict) -> None:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stream.write(struct.pack("<I", len(payload)))
    stream.write(payload)
    stream.flush()


def _raise_for_hresult(result: int, operation: str) -> None:
    if result != 0:
        unsigned = ctypes.c_ulong(result).value
        raise NativeHostError("explorer_failed", f"{operation} failed (HRESULT 0x{unsigned:08X})")


def reveal_path(raw_path: str) -> str:
    if os.name != "nt":
        raise NativeHostError("unsupported_platform", "File Explorer reveal is only supported on Windows")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise NativeHostError("path_required", "An absolute path is required")
    path = os.path.normpath(raw_path.strip())
    if not os.path.isabs(path):
        raise NativeHostError("path_not_absolute", "The supplied path must be absolute")
    if not os.path.exists(path):
        raise NativeHostError("path_not_found", "The supplied path does not exist")

    shell32 = ctypes.windll.shell32
    if os.path.isdir(path):
        shell32.ShellExecuteW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                          wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_int]
        shell32.ShellExecuteW.restype = ctypes.c_void_p
        result_value = int(shell32.ShellExecuteW(None, "open", path, None, None, SW_SHOWNORMAL) or 0)
        if result_value <= 32:
            raise NativeHostError("explorer_failed", f"Explorer failed to open the folder (code {result_value})")
        return path

    ole32 = ctypes.windll.ole32
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole32.CoInitializeEx.restype = ctypes.c_long
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    shell32.SHParseDisplayName.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p,
                                           ctypes.POINTER(ctypes.c_void_p), wintypes.DWORD,
                                           ctypes.POINTER(wintypes.DWORD)]
    shell32.SHParseDisplayName.restype = ctypes.c_long
    shell32.SHOpenFolderAndSelectItems.argtypes = [ctypes.c_void_p, wintypes.UINT,
                                                   ctypes.c_void_p, wintypes.DWORD]
    shell32.SHOpenFolderAndSelectItems.restype = ctypes.c_long

    initialize_result = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
    if initialize_result not in (0, 1):
        _raise_for_hresult(initialize_result, "COM initialization")
    pidl = ctypes.c_void_p()
    attributes = wintypes.DWORD()
    try:
        _raise_for_hresult(
            shell32.SHParseDisplayName(path, None, ctypes.byref(pidl), 0, ctypes.byref(attributes)),
            "Path resolution",
        )
        _raise_for_hresult(shell32.SHOpenFolderAndSelectItems(pidl, 0, None, 0), "Explorer selection")
    finally:
        if pidl.value:
            ole32.CoTaskMemFree(pidl)
        ole32.CoUninitialize()
    return path


def handle_message(message: dict, revealer: Callable[[str], str] | None = None) -> dict:
    action = message.get("action")
    is_legacy_reveal = action is None and "folderPath" in message
    if action != "reveal" and not is_legacy_reveal:
        raise NativeHostError("unsupported_action", "Unsupported native-host action")
    requested_path = message.get("path") if action == "reveal" else message.get("folderPath")
    path = (revealer or reveal_path)(requested_path)
    return {"ok": True, "status": "revealed", "path": path}


def main(stdin: BinaryIO | None = None, stdout: BinaryIO | None = None) -> int:
    input_stream = stdin or sys.stdin.buffer
    output_stream = stdout or sys.stdout.buffer
    try:
        message = read_message(input_stream)
        if message is None:
            return 0
        response = handle_message(message)
    except NativeHostError as exc:
        response = {"ok": False, "status": "error", "code": exc.code, "error": str(exc)}
    except Exception:
        response = {"ok": False, "status": "error", "code": "internal_error",
                    "error": "The native host could not complete the request"}
    write_message(output_stream, response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
