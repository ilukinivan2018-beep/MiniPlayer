"""Тексты песен из бесплатной базы LRCLIB (lrclib.net), с синхронизацией по времени.

Найденные тексты кешируются в cache/lyrics.json, чтобы не спрашивать сервис повторно.
"""

import json
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://lrclib.net/api"
UA = "MiniPlayer/1.0 (personal desktop widget)"
NOT_FOUND_TTL = 24 * 3600
ERROR_TTL = 60

JUNK = re.compile(
    r"\s*[\(\[【]([^\)\]】]*?)(official|video|audio|lyric|клип|премьера|mv\b|visuali[sz]er|hd\b|4k|remaster|текст|live|караоке)[^\)\]】]*[\)\]】]",
    re.I,
)
FEAT = re.compile(r"\s*[\(\[]?\s*(feat\.?|ft\.?|при уч\.?|при участии)\s[^\)\]]*[\)\]]?", re.I)
LRC_TAG = re.compile(r"\[(\d+):(\d+(?:[.:]\d+)?)\]")


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").lower().replace("ё", "е")
    return re.sub(r"[^\w]+", " ", s).strip()


def clean(title: str, artist: str):
    t = JUNK.sub("", title or "").strip()
    a = re.sub(r"\s*-\s*Topic$", "", (artist or "").strip(), flags=re.I)
    # «Исполнитель - Название» в заголовке (YouTube, VK)
    if " - " in t and (not a or _norm(t).startswith(_norm(a))):
        left, right = t.split(" - ", 1)
        if not a or _norm(left) == _norm(a) or not _norm(a):
            a, t = left.strip(), right.strip()
    t = re.sub(r"\s+", " ", t).strip(" -–—|")
    return t, a


def parse_lrc(text: str):
    out = []
    for raw in (text or "").splitlines():
        stamps = LRC_TAG.findall(raw)
        if not stamps:
            continue
        line = LRC_TAG.sub("", raw).strip()
        for m, s in stamps:
            out.append([round(int(m) * 60 + float(s.replace(":", ".")), 2), line])
    out.sort(key=lambda x: x[0])
    return out


class Lyrics:
    def __init__(self, cache_dir: str):
        self.path = os.path.join(cache_dir, "lyrics.json")
        os.makedirs(cache_dir, exist_ok=True)
        self.lock = threading.Lock()
        self.inflight = {}
        try:
            with open(self.path, encoding="utf-8") as f:
                self.cache = json.load(f)
        except (OSError, ValueError):
            self.cache = {}

    def _save(self):
        try:
            if len(self.cache) > 600:  # старые записи выкидываем
                for k in sorted(self.cache, key=lambda k: self.cache[k].get("at", 0))[:200]:
                    self.cache.pop(k, None)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.cache, f, ensure_ascii=False)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def get(self, title: str, artist: str, album: str = "", duration: float = 0) -> dict:
        t, a = clean(title, artist)
        if not t:
            return {"status": "none"}
        key = f"{_norm(a)}|{_norm(t)}|{int(round((duration or 0) / 3))}"
        now = time.time()
        with self.lock:
            hit = self.cache.get(key)
            if hit:
                ttl = {"none": NOT_FOUND_TTL, "error": ERROR_TTL}.get(hit["status"])
                if ttl is None or now - hit.get("at", 0) < ttl:
                    return hit
            ev = self.inflight.get(key)
            owner = ev is None
            if owner:
                ev = self.inflight[key] = threading.Event()
        if not owner:  # такой же запрос уже идёт — ждём его
            ev.wait(15)
            with self.lock:
                return self.cache.get(key, {"status": "error"})
        try:
            res = self._fetch(t, a, album, duration)
        except Exception:
            res = {"status": "error"}
        res["at"] = now
        with self.lock:
            self.cache[key] = res
            self.inflight.pop(key, None)
            if res["status"] != "error":
                self._save()
        ev.set()
        return res

    # ---------- запросы к LRCLIB ----------
    def _req(self, path: str, params: dict):
        url = f"{BASE}/{path}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def _pick(self, items, t, a, duration):
        best, best_score = None, -1e9
        for it in items or []:
            score = 0.0
            if it.get("syncedLyrics"):
                score += 30
            elif it.get("plainLyrics"):
                score += 10
            elif it.get("instrumental"):
                score += 5
            else:
                continue
            if duration and it.get("duration"):
                diff = abs(float(it["duration"]) - duration)
                score += 25 if diff <= 2 else 12 if diff <= 6 else -min(diff, 60)
            if _norm(it.get("trackName")) == _norm(t):
                score += 15
            if a and _norm(a) in _norm(it.get("artistName")):
                score += 15
            if score > best_score:
                best, best_score = it, score
        return best

    def _fetch(self, t, a, album, duration):
        found = None
        if a:
            params = {"track_name": t, "artist_name": a}
            if album:
                params["album_name"] = album
            if duration:
                params["duration"] = int(round(duration))
            found = self._req("get", params)
            if not found:
                found = self._pick(self._req("search", {"track_name": t, "artist_name": a}), t, a, duration)
        if not found:
            t2 = FEAT.sub("", t).strip()
            found = self._pick(self._req("search", {"q": f"{a} {t2}".strip()}), t2, a, duration)
        if not found:
            return {"status": "none", "track": t, "artist": a}
        base = {"track": found.get("trackName") or t, "artist": found.get("artistName") or a}
        if found.get("syncedLyrics"):
            lines = parse_lrc(found["syncedLyrics"])
            if lines:
                return {"status": "synced", "lines": lines, **base}
        if found.get("plainLyrics"):
            return {"status": "plain", "plain": found["plainLyrics"], **base}
        if found.get("instrumental"):
            return {"status": "instrumental", **base}
        return {"status": "none", **base}
