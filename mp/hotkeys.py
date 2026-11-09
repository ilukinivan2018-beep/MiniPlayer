"""Глобальные клавиши: Ctrl+Alt+стрелки работают из любой программы, пока открыт плеер."""

import ctypes
import threading
import time
from ctypes import wintypes

VOLUME_STEP = 0.04


class Hotkeys:
    def __init__(self, media, audio):
        self.media = media
        self.audio = audio
        self.label = None

    def start(self):
        threading.Thread(target=self._worker, daemon=True, name="hotkeys").start()

    def _worker(self):
        user32 = ctypes.windll.user32
        MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_NOREPEAT = 0x1, 0x2, 0x4, 0x4000
        WM_HOTKEY = 0x0312
        # id: (код клавиши, действие, без автоповтора)
        keys = {1: (0x25, "prev", True), 2: (0x27, "next", True), 3: (0x26, "up", False), 4: (0x28, "down", False)}

        for mods, label in ((MOD_CONTROL | MOD_ALT, "Ctrl+Alt"), (MOD_CONTROL | MOD_ALT | MOD_SHIFT, "Ctrl+Shift+Alt")):
            done = []
            for hid, (vk, _, norep) in keys.items():
                if user32.RegisterHotKey(None, hid, mods | (MOD_NOREPEAT if norep else 0), vk):
                    done.append(hid)
                else:
                    break
            if len(done) == len(keys):
                self.label = label
                break
            for hid in done:
                user32.UnregisterHotKey(None, hid)
        if not self.label:
            return  # всё занято другими программами

        msg = wintypes.MSG()
        last_vol = 0.0
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message != WM_HOTKEY or msg.wParam not in keys:
                continue
            action = keys[msg.wParam][1]
            if action in ("prev", "next"):
                self.media.command(action, wait=False)
            else:
                now = time.monotonic()
                if now - last_vol < 0.06:  # зажатая клавиша не должна мгновенно улетать в 0 или 100
                    continue
                last_vol = now
                self.audio.cmd("delta", VOLUME_STEP if action == "up" else -VOLUME_STEP, wait=False)
