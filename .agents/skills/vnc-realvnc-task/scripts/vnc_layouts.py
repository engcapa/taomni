"""Keyboard-layout probes for VNC viewers on Windows (VNC-INPUT-003-A2).

Temporarily loads a layout for the viewer window under test, sends physical
keys with SendInput and restores the previous layout afterwards, unloading any
layout that was not installed before. Used by vnc_native_scenarios.py (Taomni)
and vnc_realvnc_probe.py (RealVNC) so both viewers get identical key strokes.
"""

from __future__ import annotations

import ctypes
import time
from contextlib import contextmanager
from ctypes import wintypes

from vnc_native import key_input, send_inputs

user32 = ctypes.windll.user32
user32.LoadKeyboardLayoutW.restype = wintypes.HANDLE
user32.GetKeyboardLayout.restype = wintypes.HANDLE
user32.GetKeyboardLayout.argtypes = [wintypes.DWORD]
user32.GetKeyboardLayoutList.argtypes = [ctypes.c_int, ctypes.POINTER(wintypes.HANDLE)]
user32.UnloadKeyboardLayout.argtypes = [wintypes.HANDLE]
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

WM_INPUTLANGCHANGEREQUEST = 0x0050
KLF_NOTELLSHELL = 0x00000080
VK_RMENU, VK_OEM_5, VK_Q, VK_E, VK_A = 0xA5, 0xDC, 0x51, 0x45, 0x41

GERMAN = "00000407"
CHINESE_PINYIN = "00000804"


def installed_layouts() -> list[int]:
    count = user32.GetKeyboardLayoutList(0, None)
    buf = (wintypes.HANDLE * count)()
    user32.GetKeyboardLayoutList(count, buf)
    return [h or 0 for h in buf]


class GUITHREADINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("flags", wintypes.DWORD), ("hwndActive", wintypes.HWND),
                ("hwndFocus", wintypes.HWND), ("hwndCapture", wintypes.HWND), ("hwndMenuOwner", wintypes.HWND),
                ("hwndMoveSize", wintypes.HWND), ("hwndCaret", wintypes.HWND), ("rcCaret", wintypes.RECT)]


def focus_window() -> int:
    """The window holding keyboard focus on the foreground thread (WebView2 hosts it in another process)."""
    info = GUITHREADINFO(cbSize=ctypes.sizeof(GUITHREADINFO))
    if user32.GetGUIThreadInfo(0, ctypes.byref(info)):
        return info.hwndFocus or 0
    return 0


def window_layout(hwnd: int) -> int:
    thread = user32.GetWindowThreadProcessId(hwnd, None)
    return user32.GetKeyboardLayout(thread) or 0


@contextmanager
def layout_for(hwnd: int, klid: str):
    before = installed_layouts()
    focus = focus_window() or hwnd
    targets = [hwnd] if focus == hwnd else [hwnd, focus]
    original = window_layout(focus)
    hkl = user32.LoadKeyboardLayoutW(klid, KLF_NOTELLSHELL) or 0
    try:
        for target in targets:
            user32.PostMessageW(target, WM_INPUTLANGCHANGEREQUEST, 0, hkl)
        time.sleep(0.6)
        yield {"requested": hex(hkl), "active": hex(window_layout(focus)), "focus_is_top": focus == hwnd}
    finally:
        for target in targets:
            user32.PostMessageW(target, WM_INPUTLANGCHANGEREQUEST, 0, original)
        time.sleep(0.4)
        if hkl and hkl not in before:
            user32.UnloadKeyboardLayout(hkl)


def altgr_q() -> None:
    send_inputs(key_input(VK_RMENU, extended=True), key_input(VK_Q), key_input(VK_Q, up=True),
                key_input(VK_RMENU, up=True, extended=True))


def dead_circumflex_e() -> None:
    send_inputs(key_input(VK_OEM_5), key_input(VK_OEM_5, up=True))
    time.sleep(0.1)
    send_inputs(key_input(VK_E), key_input(VK_E, up=True))


def plain_a() -> None:
    send_inputs(key_input(VK_A), key_input(VK_A, up=True))


PROBES = [
    # (label, layout, action, keysyms a correct viewer delivers)
    ("de-altgr-q", GERMAN, altgr_q, [(True, 0xfe03), (True, 0x40), (False, 0x40), (False, 0xfe03)]),
    ("de-dead-circumflex-e", GERMAN, dead_circumflex_e, [(True, 0xea), (False, 0xea)]),
    ("zh-pinyin-a", CHINESE_PINYIN, plain_a, [(True, 0x61), (False, 0x61)]),
]
