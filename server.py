"""Мини-плеер для экрана телефона: плеер, тексты песен, монитор системы и пульт.

Запуск:  pythonw server.py --open   (ярлык «Мини-плеер» на рабочем столе)
Слушает только 127.0.0.1 и принимает команды только от своей страницы.
Сам завершается, если окно плеера закрыто дольше IDLE_EXIT секунд.
"""

import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

HOST = "127.0.0.1"
PORT = int(os.environ.get("MINIPLAYER_PORT", "8765"))
IDLE_EXIT = 90
WEB = os.path.join(HERE, "web")
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
ORIGINS = {f"http://{h}" for h in ALLOWED_HOSTS}
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"}

# модули создаются в main() — сторожу они не нужны
media = audio = hotkeys = sysmon = lyrics = viz = deck = None
last_hit = time.monotonic()


def build():
    global media, audio, hotkeys, sysmon, lyrics, viz, deck
    from mp.audio import Audio
    from mp.deck import Deck
    from mp.hotkeys import Hotkeys
    from mp.lyrics import Lyrics
    from mp.media import Media
    from mp.sysmon import SysMon
    from mp.viz import Viz

    media = Media()
    audio = Audio()
    hotkeys = Hotkeys(media, audio)
    sysmon = SysMon()
    lyrics = Lyrics(os.path.join(HERE, "cache"))
    viz = Viz()
    deck = Deck(os.path.join(HERE, "deck.json"), audio)


def ui_version() -> str:
    """Меняется при любом изменении файлов страницы — окно плеера тогда перезагрузится само."""
    try:
        return str(int(max(os.path.getmtime(os.path.join(WEB, f)) for f in os.listdir(WEB))))
    except (OSError, ValueError):
        return "0"


class Handler(BaseHTTPRequestHandler):
    server_version = "MiniPlayer"

    def log_message(self, *args):
        pass

    # ---------- ответы ----------
    def _send(self, code, body: bytes, ctype: str, cache: str = "no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _host_ok(self) -> bool:
        # защита от DNS rebinding: отвечаем только на свой адрес
        return self.headers.get("Host", "") in ALLOWED_HOSTS

    # ---------- GET ----------
    def do_GET(self):
        global last_hit
        if not self._host_ok():
            return self._send(403, b"", "text/plain")
        url = urlparse(self.path)
        path, q = url.path, parse_qs(url.query)

        if path == "/api/state":
            last_hit = time.monotonic()
            out = media.snapshot()
            out.update(audio.snapshot())
            out["hotkeys"] = hotkeys.label
            out["ui"] = ui_version()
            return self._json(out)
        if path == "/art":
            data, ctype = media.art_image()
            return self._send(200, data, ctype, "max-age=86400") if data else self._send(404, b"", "text/plain")
        if path == "/api/sys":
            return self._json(sysmon.snapshot(with_history="hist" in q))
        if path == "/api/lyrics":
            arg = lambda k: q.get(k, [""])[0]  # noqa: E731
            try:
                dur = float(arg("duration") or 0)
            except ValueError:
                dur = 0
            return self._json(lyrics.get(arg("title"), arg("artist"), arg("album"), dur))
        if path == "/api/deck":
            return self._json(deck.public())
        if path == "/api/viz":
            return self._stream_viz()

        # статика страницы
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.normpath(os.path.join(WEB, name))
        if not full.startswith(WEB + os.sep) or not os.path.isfile(full):
            return self._send(404, b"not found", "text/plain")
        with open(full, "rb") as f:
            self._send(200, f.read(), TYPES.get(os.path.splitext(full)[1], "application/octet-stream"))

    def _stream_viz(self):
        """Server-Sent Events: ~30 кадров спектра в секунду по одному соединению."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        viz.subscribe()
        try:
            last = -1
            while True:
                bands, seq = viz.frame()
                if seq != last:
                    last = seq
                    self.wfile.write(b"data:" + json.dumps(bands, separators=(",", ":")).encode() + b"\n\n")
                    self.wfile.flush()
                time.sleep(1 / 30)
        except OSError:
            pass
        finally:
            viz.unsubscribe()

    # ---------- POST ----------
    def do_POST(self):
        # команды принимаем только от своей страницы: свой Host, свой Origin и наш заголовок
        origin = self.headers.get("Origin")
        if not self._host_ok() or (origin and origin not in ORIGINS) or self.headers.get("X-MP") != "1":
            return self._send(403, b"", "text/plain")
        url = urlparse(self.path)
        name = url.path.removeprefix("/api/")
        if name == "log":  # ошибки со страницы — в logs/client.log, чтобы было видно, что пошло не так
            size = min(int(self.headers.get("Content-Length") or 0), 4000)
            text = self.rfile.read(size).decode("utf-8", "replace").replace("\n", " | ")
            client_log(text)
            return self._json({"ok": True})
        q = parse_qs(url.query)
        num = lambda k, d=0.0: float(q.get(k, [d])[0])  # noqa: E731
        try:
            if name in ("toggle", "next", "prev"):
                return self._json({"ok": bool(media.command(name))})
            if name == "seek":
                return self._json({"ok": bool(media.command("seek", num("t")))})
            if name == "volume":
                st = audio.cmd("set", num("v")) if "v" in q else audio.cmd("delta", num("delta"))
                return self._json({"ok": st.get("volume") is not None, **st})
            if name == "mute":
                st = audio.cmd("mute", num("on", -1.0))
                return self._json({"ok": st.get("volume") is not None, **st})
            if name == "deck":
                return self._json(deck.run(q.get("id", [""])[0]))
        except ValueError:
            return self._json({"ok": False}, 400)
        self._send(404, b"", "text/plain")


# ---------- окно на экране телефона ----------
def monitors():
    """Список мониторов: (x, y, w, h, primary)."""
    import ctypes
    from ctypes import wintypes

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                    ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

    user32 = ctypes.windll.user32
    found = []
    proc_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC,
                                   ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)

    def cb(hmon, hdc, rect, data):
        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            r = mi.rcMonitor
            found.append((r.left, r.top, r.right - r.left, r.bottom - r.top, bool(mi.dwFlags & 1)))
        return True

    user32.EnumDisplayMonitors(None, None, proc_type(cb), 0)
    return found


def find_browser():
    for path in (
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
    ):
        if os.path.exists(path):
            return path
    return None


def open_window():
    """Открывает плеер отдельным окном во весь экран на втором мониторе (телефоне)."""
    browser = find_browser()
    if not browser:
        os.startfile(f"http://{HOST}:{PORT}/")
        return
    extra = [m for m in monitors() if not m[4]]
    args = [
        browser,
        f"--app=http://{HOST}:{PORT}/",
        "--user-data-dir=" + os.path.join(HERE, "browser-profile"),
        "--no-first-run", "--no-default-browser-check",
        "--disable-gpu",  # не трогаем видеопамять
    ]
    if extra:
        x, y, w, h, _ = extra[0]
        args += [f"--window-position={x},{y}", f"--window-size={w},{h}", "--start-fullscreen"]
    else:  # телефон не подключён — обычное окно на основном экране
        args += ["--window-size=900,420"]
    subprocess.Popen(args, close_fds=True)


def port_busy() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex((HOST, PORT)) == 0


def supervise():
    """Сторож: запускает сервер отдельным процессом и поднимает его заново, если тот упал.
    Штатный выход (окно плеера закрыли) — код 0, тогда сторож тоже завершается."""
    if port_busy():  # сервер уже работает — просто откроем окно
        if "--open" in sys.argv:
            open_window()
        return
    exe = os.path.join(HERE, ".venv", "Scripts", "pythonw.exe")
    if not os.path.exists(exe):
        exe = sys.executable
    extra = ["--keep"] if "--keep" in sys.argv else []
    first, crashes = True, []
    while True:
        cmd = [exe, os.path.abspath(__file__), "--child"] + extra + (["--open"] if first and "--open" in sys.argv else [])
        first = False
        code = subprocess.Popen(cmd, cwd=HERE).wait()
        if code == 0:
            return
        now = time.time()
        crashes = [t for t in crashes if now - t < 120] + [now]
        log(f"сервер упал (код {code & 0xFFFFFFFF:#010x}), перезапускаю")
        if len(crashes) > 5:  # падает без остановки — не крутимся вечно
            log("слишком много падений подряд, останавливаюсь")
            return
        time.sleep(1)


_client_log_lock = threading.Lock()


def client_log(text: str):
    try:
        os.makedirs(os.path.join(HERE, "logs"), exist_ok=True)
        path = os.path.join(HERE, "logs", "client.log")
        with _client_log_lock:
            if os.path.exists(path) and os.path.getsize(path) > 512_000:  # не даём журналу разрастись
                os.replace(path, path + ".old")
            with open(path, "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {text[:1000]}\n")
    except OSError:
        pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64  # браузер при загрузке открывает сразу много соединений


def log(text: str):
    try:
        os.makedirs(os.path.join(HERE, "logs"), exist_ok=True)
        with open(os.path.join(HERE, "logs", "supervisor.log"), "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {text}\n")
    except OSError:
        pass


def main():
    if port_busy():
        if "--open" in sys.argv:
            open_window()
        return
    # если процесс всё же упадёт в системной библиотеке — в журнал попадёт, где именно
    import faulthandler
    os.makedirs(os.path.join(HERE, "logs"), exist_ok=True)
    crash_log = open(os.path.join(HERE, "logs", "crash.log"), "a", encoding="utf-8")
    crash_log.write(f"\n=== старт {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
    crash_log.flush()
    faulthandler.enable(file=crash_log, all_threads=True)
    build()
    media.start()
    audio.start()
    hotkeys.start()
    sysmon.start()
    httpd = Server((HOST, PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    if "--open" in sys.argv:
        time.sleep(1.0)  # даём модулям запуститься, чтобы окно не грузилось в самую горячую секунду старта
        open_window()
    keep = "--keep" in sys.argv
    while True:
        time.sleep(5)
        if not keep and time.monotonic() - last_hit > IDLE_EXIT:
            httpd.shutdown()
            return


if __name__ == "__main__":
    if "--child" in sys.argv or "--no-supervisor" in sys.argv:
        main()
    else:
        supervise()
