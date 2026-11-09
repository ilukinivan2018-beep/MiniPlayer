"""Загрузка видеокарты, процессора, памяти и сети.

Опрос раз в секунду, история за последние 2 минуты — чтобы графики
появлялись сразу, как только открыл страницу.
"""

import collections
import threading
import time

import psutil

HISTORY = 120
KEYS = ("gpu", "vram", "temp", "cpu", "ram", "down", "up")


class SysMon:
    def __init__(self):
        self.lock = threading.Lock()
        self.cur = {}
        self.top = []
        self.hist = {k: collections.deque(maxlen=HISTORY) for k in KEYS}
        self.nv = None
        self.handle = None
        self.gpu_name = None

    def start(self):
        threading.Thread(target=self._loop, daemon=True, name="sysmon").start()

    def snapshot(self, with_history: bool = False) -> dict:
        with self.lock:
            out = {"cur": dict(self.cur), "top": list(self.top)}
            if with_history:
                out["hist"] = {k: list(v) for k, v in self.hist.items()}
        return out

    # ---------- видеокарта (NVIDIA через NVML) ----------
    def _gpu_init(self):
        try:
            import pynvml as n
            n.nvmlInit()
            self.handle = n.nvmlDeviceGetHandleByIndex(0)
            name = n.nvmlDeviceGetName(self.handle)
            self.gpu_name = name.decode() if isinstance(name, bytes) else str(name)
            self.nv = n
        except Exception:
            self.nv = None

    def _gpu(self):
        n, h = self.nv, self.handle
        if n is None:
            return None
        d = {"name": self.gpu_name}

        def safe(key, fn):
            try:
                d[key] = fn()
            except Exception:
                d[key] = None

        safe("util", lambda: n.nvmlDeviceGetUtilizationRates(h).gpu)
        mem = None
        try:
            mem = n.nvmlDeviceGetMemoryInfo(h)
        except Exception:
            pass
        d["memUsed"] = round(mem.used / 2**30, 2) if mem else None
        d["memTotal"] = round(mem.total / 2**30, 2) if mem else None
        safe("temp", lambda: n.nvmlDeviceGetTemperature(h, n.NVML_TEMPERATURE_GPU))
        safe("power", lambda: round(n.nvmlDeviceGetPowerUsage(h) / 1000))
        safe("powerLimit", lambda: round(n.nvmlDeviceGetEnforcedPowerLimit(h) / 1000))
        safe("fan", lambda: n.nvmlDeviceGetFanSpeed(h))
        safe("clock", lambda: n.nvmlDeviceGetClockInfo(h, n.NVML_CLOCK_GRAPHICS))
        return d

    # ---------- кто грузит процессор ----------
    def _top(self, cores: int):
        usage = collections.Counter()
        for p in psutil.process_iter(["name"]):
            try:
                name = p.info["name"] or "?"
                if name in ("System Idle Process", "Idle"):
                    continue
                usage[name.removesuffix(".exe")] += p.cpu_percent(None)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return [{"name": n, "cpu": round(c / cores)} for n, c in usage.most_common(4) if c / cores >= 1]

    def _loop(self):
        self._gpu_init()
        cores = psutil.cpu_count() or 1
        psutil.cpu_percent(None)
        self._top(cores)  # первый вызов только запоминает счётчики
        last_net, last_t = psutil.net_io_counters(), time.monotonic()
        tick = 0
        while True:
            time.sleep(1.0)
            try:
                now = time.monotonic()
                span = max(0.2, now - last_t)
                gpu = self._gpu()
                cpu = psutil.cpu_percent(None)
                vm = psutil.virtual_memory()
                net = psutil.net_io_counters()
                down = max(0, net.bytes_recv - last_net.bytes_recv) / span
                up = max(0, net.bytes_sent - last_net.bytes_sent) / span
                last_net, last_t = net, now
                top = self._top(cores) if tick % 3 == 0 else None
                tick += 1

                cur = {
                    "gpu": gpu,
                    "cpu": round(cpu),
                    "cores": cores,
                    "ramUsed": round(vm.used / 2**30, 1),
                    "ramTotal": round(vm.total / 2**30, 1),
                    "ram": round(vm.percent),
                    "down": round(down),
                    "up": round(up),
                }
                with self.lock:
                    self.cur = cur
                    if top is not None:
                        self.top = top
                    h = self.hist
                    h["gpu"].append(gpu.get("util") if gpu else None)
                    vram = round(100 * gpu["memUsed"] / gpu["memTotal"]) if gpu and gpu.get("memTotal") else None
                    h["vram"].append(vram)
                    h["temp"].append(gpu.get("temp") if gpu else None)
                    h["cpu"].append(cur["cpu"])
                    h["ram"].append(cur["ram"])
                    h["down"].append(cur["down"])
                    h["up"].append(cur["up"])
            except Exception:
                pass
