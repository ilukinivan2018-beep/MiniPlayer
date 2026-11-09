"""Пульт: плитки с действиями из deck.json.

Сервер выполняет только то, что записано в deck.json, — никаких произвольных
команд из запросов. Плитки можно менять, редактируя этот файл.
"""

import ctypes
import json
import os
import subprocess
import threading
from ctypes import wintypes

# Свои экземпляры библиотек: типы аргументов, заданные здесь, не влияют на другие модули
user32 = ctypes.WinDLL("user32")
dwmapi = ctypes.WinDLL("dwmapi")

LOCAL = os.environ.get("LOCALAPPDATA", "")
ROAMING = os.environ.get("APPDATA", "")
PF = os.environ.get("ProgramFiles", r"C:\Program Files")
PF86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")

# Программы, которые пульт ищет при первом запуске: в плитки попадут только установленные (максимум 5)
APP_CANDIDATES = [
    ("firefox", "Firefox", "globe", "#ff8a4c", [os.path.join(PF, "Mozilla Firefox", "firefox.exe"), os.path.join(PF86, "Mozilla Firefox", "firefox.exe")], []),
    ("chrome", "Chrome", "globe", "#6cc3ff", [os.path.join(PF, "Google", "Chrome", "Application", "chrome.exe"), os.path.join(LOCAL, "Google", "Chrome", "Application", "chrome.exe")], []),
    ("ybrowser", "Яндекс Браузер", "globe", "#ffcc33", [os.path.join(LOCAL, "Yandex", "YandexBrowser", "Application", "browser.exe")], []),
    ("ymusic", "Яндекс Музыка", "music", "#ffd84d", [os.path.join(LOCAL, "Programs", "YandexMusic", "Яндекс Музыка.exe")], []),
    ("spotify", "Spotify", "music", "#4ade80", [os.path.join(ROAMING, "Spotify", "Spotify.exe")], []),
    ("telegram", "Telegram", "send", "#4fb6ff", [os.path.join(ROAMING, "Telegram Desktop", "Telegram.exe")], []),
    ("discord", "Discord", "chat", "#8b9bff", [os.path.join(LOCAL, "Discord", "Update.exe")], ["--processStart", "Discord.exe"]),
    ("steam", "Steam", "gamepad", "#5fb4ff", [os.path.join(PF86, "Steam", "steam.exe"), os.path.join(PF, "Steam", "steam.exe")], []),
    ("obsidian", "Obsidian", "gem", "#b48cff", [os.path.join(LOCAL, "Programs", "Obsidian", "Obsidian.exe")], []),
    ("vscode", "VS Code", "code", "#4aa8ff", [os.path.join(LOCAL, "Programs", "Microsoft VS Code", "Code.exe")], []),
]


def default_tiles():
    tiles = []
    for tid, label, icon, tint, paths, args in APP_CANDIDATES:
        path = next((p for p in paths if p and os.path.exists(p)), None)
        if path and len(tiles) < 5:
            action = {"type": "run", "path": path}
            if args:
                action["args"] = args
            tiles.append({"id": tid, "label": label, "icon": icon, "tint": tint, "action": action})
    return tiles + SYSTEM_TILES


SYSTEM_TILES = [
    {"id": "explorer", "label": "Проводник", "icon": "folder", "tint": "#f5c84c",
     "action": {"type": "run", "path": "explorer.exe"}},
    {"id": "minimize", "label": "Свернуть всё", "labelActive": "Вернуть окна", "icon": "minimize", "tint": "#6ee7b7",
     "action": {"type": "minimize"}},
    {"id": "screenshot", "label": "Скриншот", "icon": "scissors", "tint": "#f58ac0",
     "action": {"type": "keys", "keys": "win+shift+s"}},
    {"id": "taskmgr", "label": "Диспетчер задач", "icon": "activity", "tint": "#6cb6ff",
     "action": {"type": "run", "path": "taskmgr.exe"}},
    {"id": "mic", "label": "Микрофон", "labelActive": "Микрофон выкл", "icon": "mic", "tint": "#4ade80",
     "action": {"type": "mic"}},
    {"id": "viz", "label": "Визуализатор", "icon": "waves", "tint": "#a99bff",
     "action": {"type": "ui", "name": "viz"}},
    {"id": "lock", "label": "Заблокировать", "icon": "lock", "tint": "#f87171", "confirm": True,
     "action": {"type": "lock"}},
]

VK = {
    "win": 0x5B, "ctrl": 0x11, "shift": 0x10, "alt": 0x12, "esc": 0x1B, "tab": 0x09, "enter": 0x0D,
    "space": 0x20, "printscreen": 0x2C, "delete": 0x2E, "home": 0x24, "end": 0x23,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
}
VK.update({chr(c).lower(): c for c in range(0x41, 0x5B)})
VK.update({str(d): 0x30 + d for d in range(10)})
VK.update({f"f{i}": 0x6F + i for i in range(1, 13)})


def send_keys(combo: str) -> bool:
    codes = [VK.get(k.strip().lower()) for k in combo.split("+")]
    if not codes or None in codes:
        return False
    for c in codes:
        user32.keybd_event(c, 0, 0, 0)
    for c in reversed(codes):
        user32.keybd_event(c, 0, 2, 0)  # KEYEVENTF_KEYUP
    return True


def _allow_foreground():
    """Чтобы запущенная программа открылась поверх окон, а не мигала на панели задач."""
    user32.keybd_event(0x12, 0, 0, 0)
    user32.keybd_event(0x12, 0, 2, 0)
    user32.AllowSetForegroundWindow(-1)  # ASFW_ANY


# ---------- «Свернуть всё» только на основном мониторе (телефон не трогаем) ----------
class _MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


user32.MonitorFromWindow.restype = wintypes.HMONITOR
user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(_MONITORINFO)]
user32.GetWindow.restype = wintypes.HWND
user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
user32.ShowWindowAsync.argtypes = [wintypes.HWND, ctypes.c_int]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsIconic.argtypes = [wintypes.HWND]
user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.keybd_event.argtypes = [ctypes.c_ubyte, ctypes.c_ubyte, wintypes.DWORD, ctypes.c_size_t]
dwmapi.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
_SKIP_CLASSES = {"Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow"}


def _primary_windows():
    found = []
    proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _):
        try:
            if not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd) or user32.GetWindow(hwnd, 4):  # GW_OWNER
                return True
            if user32.GetWindowLongW(hwnd, -20) & 0x80 or user32.GetWindowTextLengthW(hwnd) == 0:  # WS_EX_TOOLWINDOW
                return True
            cls = ctypes.create_unicode_buffer(128)
            user32.GetClassNameW(hwnd, cls, 128)
            if cls.value in _SKIP_CLASSES:
                return True
            cloaked = wintypes.DWORD(0)
            dwmapi.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(cloaked), 4)  # DWMWA_CLOAKED
            if cloaked.value:
                return True
            mi = _MONITORINFO()
            mi.cbSize = ctypes.sizeof(_MONITORINFO)
            if user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd, 2), ctypes.byref(mi)) and mi.dwFlags & 1:
                found.append(hwnd)
        except Exception:
            pass
        return True

    user32.EnumWindows(proc(cb), 0)
    return found


class Deck:
    def __init__(self, path: str, audio):
        self.path = path
        self.audio = audio
        self.lock = threading.Lock()
        self.minimized = []
        if not os.path.exists(path):  # первый запуск — собираем плитки из установленных программ
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"tiles": default_tiles()}, f, ensure_ascii=False, indent=2)

    def _tiles(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                return json.load(f).get("tiles", [])
        except (OSError, ValueError):
            return SYSTEM_TILES

    def public(self) -> dict:
        """Описание плиток для страницы (без путей к программам)."""
        out = []
        for t in self._tiles():
            a = t.get("action", {})
            out.append({k: t.get(k) for k in ("id", "label", "labelActive", "icon", "tint", "confirm")}
                       | {"type": a.get("type"), "name": a.get("name")})
        with self.lock:
            minimized = bool(self.minimized)
        return {"tiles": out, "minimized": minimized}

    def run(self, tile_id: str) -> dict:
        tile = next((t for t in self._tiles() if t.get("id") == tile_id), None)
        if not tile:
            return {"ok": False}
        a = tile.get("action", {})
        kind = a.get("type")
        try:
            if kind == "run":
                _allow_foreground()
                args = subprocess.list2cmdline(a.get("args", []))
                os.startfile(a["path"], "open", args) if args else os.startfile(a["path"])
                return {"ok": True}
            if kind == "url":
                os.startfile(a["url"])
                return {"ok": True}
            if kind == "keys":
                return {"ok": send_keys(a.get("keys", ""))}
            if kind == "lock":
                return {"ok": bool(user32.LockWorkStation())}
            if kind == "mic":
                st = self.audio.cmd("mic_mute", -1.0)
                return {"ok": st.get("mic_muted") is not None, "active": bool(st.get("mic_muted"))}
            if kind == "mute":
                st = self.audio.cmd("mute", -1.0)
                return {"ok": True, "active": bool(st.get("muted"))}
            if kind == "minimize":
                with self.lock:
                    if self.minimized:  # второй тап — вернуть окна как были
                        for hwnd in reversed(self.minimized):
                            user32.ShowWindowAsync(hwnd, 9)  # SW_RESTORE
                        self.minimized = []
                        return {"ok": True, "active": False}
                    wins = _primary_windows()
                    for hwnd in wins:
                        user32.ShowWindowAsync(hwnd, 7)  # SW_SHOWMINNOACTIVE
                    self.minimized = wins
                    return {"ok": True, "active": bool(wins)}
        except Exception as e:
            return {"ok": False, "error": str(e)[:120]}
        return {"ok": False}
