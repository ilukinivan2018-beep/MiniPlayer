"""Громкость динамиков и микрофон Windows (Core Audio через pycaw).

Всё в одном потоке: COM не любит, когда его дёргают из разных потоков.
"""

import gc
import queue
import sys
import threading
import time

REFRESH_SEC = 10  # как часто перепроверяем устройство (вдруг воткнули наушники)


class Audio:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"volume": None, "muted": False, "mic_muted": None}
        self.q = queue.Queue()

    def start(self):
        threading.Thread(target=self._worker, daemon=True, name="audio").start()

    def snapshot(self) -> dict:
        with self.lock:
            return dict(self.state)

    def cmd(self, kind: str, value: float = 0.0, wait: bool = True) -> dict:
        """kind: set | delta | mute | mic_mute. Для mute/mic_mute: value < 0 — переключить, 1/0 — вкл/выкл «без звука»."""
        done = threading.Event() if wait else None
        self.q.put((kind, value, done))
        if done:
            done.wait(1.5)
        return self.snapshot()

    def _worker(self):
        # Многопоточный режим COM: тогда объекты звука можно безопасно освобождать из любого потока.
        # В однопоточном режиме сборщик мусора мог освободить их из чужого потока — это роняло процесс.
        sys.coinit_flags = 0  # COINIT_MULTITHREADED, должно стоять до первого импорта comtypes
        import comtypes
        from pycaw.pycaw import AudioUtilities

        try:
            comtypes.CoInitializeEx(0)
        except OSError:
            pass  # уже инициализирован при импорте

        def endpoint(dev):
            if dev is None:
                return None
            ev = getattr(dev, "EndpointVolume", None)
            if ev is None:  # старые версии pycaw
                from ctypes import POINTER, cast
                from comtypes import CLSCTX_ALL
                from pycaw.pycaw import IAudioEndpointVolume
                ev = cast(dev.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None), POINTER(IAudioEndpointVolume))
            return ev

        def target(ev, value):
            return (0 if ev.GetMute() else 1) if value < 0 else (1 if value >= 0.5 else 0)

        spk = mic = None
        got_at = 0.0
        while True:
            try:
                job = self.q.get(timeout=0.4)
            except queue.Empty:
                job = None
            try:
                if spk is None or time.monotonic() - got_at > REFRESH_SEC:
                    spk = mic = None
                    gc.collect()  # старые COM-объекты освобождаем здесь, в своём потоке
                    spk = endpoint(AudioUtilities.GetSpeakers())
                    try:
                        mic = endpoint(AudioUtilities.GetMicrophone())
                    except Exception:
                        mic = None
                    got_at = time.monotonic()
                if job:
                    kind, value, _ = job
                    if kind in ("set", "delta"):
                        cur = spk.GetMasterVolumeLevelScalar()
                        new = min(1.0, max(0.0, value if kind == "set" else cur + value))
                        spk.SetMasterVolumeLevelScalar(new, None)
                        if ((kind == "set" and new > 0) or (kind == "delta" and value > 0)) and spk.GetMute():
                            spk.SetMute(0, None)
                    elif kind == "mute":
                        spk.SetMute(target(spk, value), None)
                    elif kind == "mic_mute" and mic is not None:
                        mic.SetMute(target(mic, value), None)
                vol = float(spk.GetMasterVolumeLevelScalar())
                muted = bool(spk.GetMute())
                mic_muted = None
                if mic is not None:
                    try:
                        mic_muted = bool(mic.GetMute())
                    except Exception:
                        mic = None
                with self.lock:
                    self.state = {"volume": round(vol, 3), "muted": muted, "mic_muted": mic_muted}
            except Exception:
                spk = None
                with self.lock:
                    self.state["volume"] = None
            finally:
                if job and job[2] is not None:
                    job[2].set()
