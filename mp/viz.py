"""Спектр звука, который реально играет в Windows (WASAPI loopback), для визуализатора.

Захват включается только пока визуализатор открыт на экране — в остальное
время процессор не тратится.
"""

import threading
import time
import warnings

import numpy as np

# при загруженном процессоре захват иногда пропускает кусочек — для картинки это неважно
warnings.filterwarnings("ignore", message="data discontinuity")

BANDS = 40
RATE = 48000
FFT = 2048
HOP = 1024
DB_RANGE = 48.0


class Viz:
    def __init__(self):
        self.lock = threading.Lock()
        self.bands = [0.0] * BANDS
        self.seq = 0
        self.clients = 0
        self.thread = None

    def subscribe(self):
        with self.lock:
            self.clients += 1
            if self.thread is None:
                self.thread = threading.Thread(target=self._run, daemon=True, name="viz")
                self.thread.start()

    def unsubscribe(self):
        with self.lock:
            self.clients = max(0, self.clients - 1)

    def frame(self):
        with self.lock:
            return self.bands, self.seq

    def _active(self) -> bool:
        with self.lock:
            if self.clients > 0:
                return True
            self.thread = None
            self.bands = [0.0] * BANDS
            return False

    def _run(self):
        import soundcard as sc

        freqs = np.fft.rfftfreq(FFT, 1 / RATE)
        edges = np.logspace(np.log10(45), np.log10(15000), BANDS + 1)
        centers = np.sqrt(edges[:-1] * edges[1:])
        tilt = (centers / centers[0]) ** 0.28  # у высоких частот энергии меньше — слегка подтягиваем
        # матрица «частотные корзины → полоски»: весь расчёт полосок одним умножением
        weights = np.zeros((BANDS, len(freqs)), np.float32)
        for i in range(BANDS):
            a = int(np.searchsorted(freqs, edges[i]))
            b = max(int(np.searchsorted(freqs, edges[i + 1])), a + 1)
            weights[i, a:b] = tilt[i] / (b - a)
        window = np.hanning(FFT).astype(np.float32)
        buf = np.zeros(FFT, np.float32)
        level = np.zeros(BANDS, np.float32)
        peak = 1e-3

        while self._active():
            try:
                spk = sc.default_speaker()
                mic = sc.get_microphone(id=str(spk.name), include_loopback=True)
                with mic.recorder(samplerate=RATE, blocksize=HOP) as rec:
                    started = time.monotonic()
                    # раз в минуту переоткрываем — вдруг сменилось устройство вывода
                    while time.monotonic() - started < 60:
                        with self.lock:
                            if self.clients <= 0:
                                break
                        data = rec.record(numframes=HOP)
                        mono = data.mean(axis=1) if data.ndim > 1 else data
                        mono = mono.astype(np.float32)[-FFT:]
                        n = len(mono)
                        buf = np.roll(buf, -n)
                        buf[-n:] = mono
                        if float(np.abs(mono).max(initial=0)) < 1e-4:  # тишина
                            level *= 0.8
                        else:
                            spec = np.abs(np.fft.rfft(buf * window)).astype(np.float32)
                            vals = weights @ spec
                            peak = max(float(vals.max()), peak * 0.996, 1e-6)  # медленно подстраиваемся под громкость
                            db = 20 * np.log10(vals / peak + 1e-9)
                            norm = np.clip((db + DB_RANGE) / DB_RANGE, 0, 1)
                            level = np.maximum(norm, level * 0.82)  # быстро вверх, плавно вниз
                        with self.lock:
                            self.bands = [round(float(x), 3) for x in level]
                            self.seq += 1
            except Exception:
                time.sleep(1.5)
