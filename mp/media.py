"""Что играет в Windows: системный медиа-центр (SMTC).

Тот же источник, что и всплывашка громкости Windows, поэтому работает
с Яндекс Музыкой, браузерами, Spotify и т.д.
"""

import asyncio
import datetime as dt
import hashlib
import os
import threading
import time

from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
)
from winrt.windows.storage.streams import Buffer, InputStreamOptions

POLL_SEC = 0.5
STATUS_NAMES = {0: "closed", 1: "opened", 2: "changing", 3: "stopped", 4: "playing", 5: "paused"}
APP_NAMES = [
    ("yandex.music", "Яндекс Музыка"), ("yandexmusic", "Яндекс Музыка"), ("music.yandex", "Яндекс Музыка"),
    ("spotify", "Spotify"), ("msedge", "Microsoft Edge"), ("chrome", "Google Chrome"),
    ("firefox", "Firefox"), ("opera", "Opera"), ("yandex", "Яндекс"), ("zunemusic", "Медиаплеер"),
    ("telegram", "Telegram"), ("vlc", "VLC"), ("aimp", "AIMP"),
]


def app_name(app_id: str) -> str:
    low = (app_id or "").lower()
    for key, name in APP_NAMES:
        if key in low:
            return name
    base = os.path.basename(app_id or "").replace(".exe", "")
    return base or "Плеер"


def _sec(td) -> float:
    try:
        return max(0.0, td.total_seconds())
    except Exception:
        return 0.0


class Media:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"active": False}
        self.art = {"data": None, "type": "image/jpeg", "ver": "0"}
        self.loop = asyncio.new_event_loop()
        self.manager = None

    # ---------- публичное ----------
    def start(self):
        def run():
            asyncio.set_event_loop(self.loop)
            self.loop.run_until_complete(self._poll())
        threading.Thread(target=run, daemon=True, name="media").start()

    def snapshot(self) -> dict:
        with self.lock:
            out = dict(self.state)
            out["art"] = self.art["ver"]
        return out

    def art_image(self):
        with self.lock:
            return self.art["data"], self.art["type"]

    def command(self, name: str, value=None, wait: bool = True):
        fut = asyncio.run_coroutine_threadsafe(self._command(name, value), self.loop)
        if not wait:
            return None
        try:
            return fut.result(timeout=3)
        except Exception:
            return False

    # ---------- внутреннее ----------
    async def _read_thumb(self, ref):
        if ref is None:
            return None, None
        stream = await ref.open_read_async()
        size = int(stream.size or 0)
        if size <= 0 or size > 15_000_000:
            return None, None
        buf = Buffer(size)
        res = await stream.read_async(buf, size, InputStreamOptions.READ_AHEAD)
        data = bytes(memoryview(res))
        return (data or None), (stream.content_type or "image/jpeg")

    async def _poll(self):
        self.manager = await SessionManager.request_async()
        last_key, last_thumb = None, 0.0
        while True:
            try:
                s = self.manager.get_current_session()
                if s is None:
                    with self.lock:
                        self.state = {"active": False}
                        self.art.update({"data": None, "ver": "0"})
                    last_key = None
                else:
                    info = s.get_playback_info()
                    ctrl = info.controls
                    tl = s.get_timeline_properties()
                    props = await s.try_get_media_properties_async()
                    status = STATUS_NAMES.get(int(info.playback_status), "unknown")

                    start = _sec(tl.start_time)
                    duration = max(0.0, _sec(tl.end_time) - start)
                    pos = _sec(tl.position) - start
                    # многие плееры обновляют позицию редко — досчитываем по времени
                    try:
                        upd = tl.last_updated_time
                        if status == "playing" and upd and upd.year > 2000:
                            if upd.tzinfo is None:
                                upd = upd.replace(tzinfo=dt.timezone.utc)
                            pos += max(0.0, (dt.datetime.now(dt.timezone.utc) - upd).total_seconds())
                    except Exception:
                        pass
                    if duration > 0:
                        pos = min(pos, duration)

                    app_id = s.source_app_user_model_id or ""
                    key = (app_id, props.title, props.artist, props.album_title)
                    now = time.monotonic()
                    # обложка часто приходит позже названия — перепроверяем раз в 2 с
                    if key != last_key or now - last_thumb > 2.0:
                        last_thumb = now
                        try:
                            data, ctype = await self._read_thumb(props.thumbnail)
                        except Exception:
                            data, ctype = None, None
                        ver = hashlib.md5(data).hexdigest()[:12] if data else "0"
                        with self.lock:
                            if ver != self.art["ver"]:
                                self.art = {"data": data, "type": ctype or "image/jpeg", "ver": ver}
                        last_key = key

                    with self.lock:
                        self.state = {
                            "active": True,
                            "app": app_name(app_id),
                            "appId": app_id,
                            "title": props.title or "",
                            "artist": props.artist or props.album_artist or "",
                            "album": props.album_title or "",
                            "status": status,
                            "position": round(pos, 2),
                            "duration": round(duration, 2),
                            "canToggle": bool(ctrl.is_play_pause_toggle_enabled or ctrl.is_play_enabled or ctrl.is_pause_enabled),
                            "canNext": bool(ctrl.is_next_enabled),
                            "canPrev": bool(ctrl.is_previous_enabled),
                            "canSeek": bool(ctrl.is_playback_position_enabled) and duration > 0,
                        }
            except Exception as e:  # плеер закрылся посреди опроса и т.п.
                with self.lock:
                    self.state["error"] = str(e)[:200]
            await asyncio.sleep(POLL_SEC)

    async def _command(self, name, value=None) -> bool:
        s = self.manager.get_current_session() if self.manager else None
        if s is None:
            return False
        if name == "toggle":
            return bool(await s.try_toggle_play_pause_async())
        if name == "next":
            return bool(await s.try_skip_next_async())
        if name == "prev":
            return bool(await s.try_skip_previous_async())
        if name == "seek" and value is not None:
            start = _sec(s.get_timeline_properties().start_time)
            return bool(await s.try_change_playback_position_async(int((start + max(0.0, value)) * 10_000_000)))
        return False
