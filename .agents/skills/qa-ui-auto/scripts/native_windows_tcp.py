"""Observe Windows TCP listeners through IP Helper, without starting PowerShell."""
from __future__ import annotations

import ctypes
import socket
import struct

_DWORD = ctypes.c_uint32
_INSUFFICIENT_BUFFER = 122
_LISTENER_TABLE = 3  # TCP_TABLE_OWNER_PID_LISTENER
_LISTEN = 2
_IPV4_ROW = struct.Struct("=IIIIII")
_IPV6_ROW = struct.Struct("=16sII16sIIII")


def _read_table(family: int) -> bytes:
    get_table = ctypes.WinDLL("iphlpapi", use_last_error=True).GetExtendedTcpTable
    get_table.argtypes = [ctypes.c_void_p, ctypes.POINTER(_DWORD), ctypes.c_int32,
                          _DWORD, _DWORD, _DWORD]
    get_table.restype = _DWORD
    size = _DWORD()
    result = get_table(None, ctypes.byref(size), False, family, _LISTENER_TABLE, 0)
    for _ in range(4):
        if result != _INSUFFICIENT_BUFFER:
            raise OSError(result, "GetExtendedTcpTable did not return a listener table")
        if not 4 <= size.value <= 64 * 1024 * 1024:
            raise RuntimeError("Windows TCP listener table has an invalid buffer size")
        buffer = ctypes.create_string_buffer(size.value)
        result = get_table(buffer, ctypes.byref(size), False, family, _LISTENER_TABLE, 0)
        if result == 0:
            if not 4 <= size.value <= len(buffer):
                raise RuntimeError("Windows TCP listener table returned an invalid size")
            return buffer.raw[:size.value]
    raise OSError(result, "Windows TCP listener table kept growing during observation")


def _decode_table(data: bytes, family: int, ports: tuple[int, ...]) -> list[dict]:
    row = _IPV4_ROW if family == socket.AF_INET else _IPV6_ROW
    if len(data) < 4:
        raise RuntimeError("Windows TCP listener table is truncated")
    count = struct.unpack_from("=I", data)[0]
    if 4 + count * row.size > len(data):
        raise RuntimeError("Windows TCP listener rows are truncated")
    listeners = []
    for index in range(count):
        fields = row.unpack_from(data, 4 + index * row.size)
        if family == socket.AF_INET:
            state, address, port, _, _, pid = fields
            address = struct.pack("=I", address)
            scope = 0
        else:
            address, scope, port, _, _, _, state, pid = fields
        if state != _LISTEN:
            raise RuntimeError("Windows listener table contains a non-listening row")
        port = socket.ntohs(port & 0xffff)
        if port not in ports:
            continue
        address = socket.inet_ntop(family, address)
        if scope:
            address += f"%{scope}"
        listeners.append({"LocalAddress": address, "LocalPort": port, "OwningProcess": pid})
    return listeners


def windows_listeners(ports: tuple[int, ...]) -> list[dict]:
    return [listener for family in (socket.AF_INET, socket.AF_INET6)
            for listener in _decode_table(_read_table(family), family, ports)]
