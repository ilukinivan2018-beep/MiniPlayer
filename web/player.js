/* Страница 1: плеер — обложка, цвета из обложки, кнопки, перемотка, громкость, клавиатура. */
(() => {
  const { $ } = MP;
  const body = document.body;
  const DEFAULT_ACCENT = '#a99bff';
  let artVer = null, coverFront = 'A', bgFront = 'A';

  /* ---------- время ---------- */
  const fmt = s => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  MP.fmt = fmt;
  function drawProgress(p) {
    const d = MP.duration(), f = d ? Math.min(1, Math.max(0, p / d)) : 0;
    $('fill').style.transform = `scaleX(${f})`;
    $('knob').style.left = (f * 100) + '%';
    $('cur').textContent = fmt(p);
  }
  setInterval(() => {
    if (!MP.seeking && body.dataset.mode === 'playing' && MP.page === 0) drawProgress(MP.position());
  }, 250);

  /* ---------- цвет из обложки ---------- */
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function analyze(img) {
    const N = 28, c = document.createElement('canvas');
    c.width = c.height = N;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, N, N);
    const d = x.getImageData(0, 0, N, N).data;
    let r = 0, g = 0, b = 0, w = 0, satSum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2], mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      const sat = mx ? (mx - mn) / mx : 0, wt = sat * sat * (mx / 255) + .015;
      satSum += sat; r += R * wt; g += G * wt; b += B * wt; w += wt;
    }
    const [h, s, l] = rgbToHsl(r / w, g / w, b / w);
    const accent = satSum / (N * N) < .1 ? '#ecebf3'
      : `hsl(${Math.round(h * 360)} ${Math.round(Math.max(s, .5) * 100)}% ${Math.round(Math.min(Math.max(l, .6), .74) * 100)}%)`;
    return { accent, bg: c.toDataURL('image/png') };
  }
  function setAccent(color) {
    const root = document.documentElement.style;
    root.setProperty('--accent', color);
    const probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = color; probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    root.setProperty('--on-accent', (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > .55 ? '#0b0b11' : '#ffffff');
    MP.accent = `rgb(${r}, ${g}, ${b})`;
    MP.emit('accent', MP.accent);
  }
  MP.accent = 'rgb(169, 155, 255)';

  let artTimer = 0;
  function showArt(ver) {
    const cover = $('cover');
    clearTimeout(artTimer);
    if (ver === '0') {
      // обложка новой песни часто приходит на секунду позже названия — не мигаем заглушкой
      artTimer = setTimeout(() => {
        if (artVer !== '0') return;
        cover.classList.remove('has-art');
        ['imgA', 'imgB', 'bgA', 'bgB'].forEach(id => $(id).classList.remove('show'));
        setAccent(DEFAULT_ACCENT);
        MP.emit('art', null);
      }, 2500);
      return;
    }
    const back = coverFront === 'A' ? 'B' : 'A', img = $('img' + back);
    img.onload = () => {
      if (artVer !== ver) return;
      let res = null;
      try { res = analyze(img); } catch (e) {}
      img.classList.add('show'); $('img' + coverFront).classList.remove('show');
      coverFront = back; cover.classList.add('has-art');
      if (res) {
        setAccent(res.accent);
        const bgBack = bgFront === 'A' ? 'B' : 'A';
        $('bg' + bgBack).style.backgroundImage = `url(${res.bg})`;
        $('bg' + bgBack).classList.add('show'); $('bg' + bgFront).classList.remove('show');
        bgFront = bgBack;
      }
      MP.emit('art', img.src);
    };
    img.src = '/art?v=' + encodeURIComponent(ver);
  }

  /* ---------- состояние ---------- */
  const setText = (id, text) => { const el = $(id); if (el.textContent !== text) el.textContent = text; };
  MP.setText = setText;

  MP.on('state', s => {
    applyVolume(s);
    if (body.dataset.mode !== 'playing') {
      setText('hintText', 'Включи музыку — она появится здесь');
      return;
    }
    setText('title', s.title || 'Без названия');
    setText('artist', s.artist || '');
    setText('album', s.album && s.album !== s.title ? s.album : '');
    setText('app', s.app || 'Плеер');
    document.title = s.title ? `${s.title} — ${s.artist}` : 'Мини-плеер';
    const d = MP.duration();
    $('progress').classList.toggle('no-duration', !d);
    $('bar').classList.toggle('seekable', !!s.canSeek);
    setText('dur', fmt(d));
    $('prev').disabled = !s.canPrev;
    $('next').disabled = !s.canNext;
    $('toggle').disabled = !s.canToggle;
    if (s.art !== artVer) { artVer = s.art; showArt(s.art); }
  });
  MP.on('offline', () => setText('hintText', 'Плеер не отвечает — запусти «Мини-плеер» заново'));

  /* ---------- кнопки ---------- */
  $('toggle').addEventListener('click', () => {
    MP.setStatus(MP.status() === 'playing' ? 'paused' : 'playing');
    MP.post('toggle');
  });
  $('next').addEventListener('click', () => MP.post('next'));
  $('prev').addEventListener('click', () => MP.post('prev'));
  $('lyrBtn').addEventListener('click', () => MP.goPage(1));

  // перемотка пальцем или мышью
  const bar = $('bar');
  const fracAt = e => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  bar.addEventListener('pointerdown', e => {
    if (!MP.state.canSeek || !MP.duration()) return;
    MP.seeking = true; bar.classList.add('dragging');
    bar.setPointerCapture(e.pointerId);
    drawProgress(fracAt(e) * MP.duration());
  });
  bar.addEventListener('pointermove', e => { if (MP.seeking) drawProgress(fracAt(e) * MP.duration()); });
  const endDrag = e => {
    if (!MP.seeking) return;
    MP.seeking = false; bar.classList.remove('dragging');
    const t = fracAt(e) * MP.duration();
    MP.setPosition(t); drawProgress(t);
    MP.post(`seek?t=${t.toFixed(2)}`);
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
  MP.seekTo = t => { if (!MP.state.canSeek) return; MP.setPosition(t); drawProgress(t); MP.post(`seek?t=${t.toFixed(2)}`); };

  /* ---------- громкость ---------- */
  const volEl = $('vol'), vbar = $('vbar');
  let vol = null, muted = false, volHoldUntil = 0, volDragging = false, volHideTimer = 0, lastVolSend = 0;
  let volOpenedByTap = 0;  // когда ползунок открыли тапом по кнопке (0 — выехал сам)
  const clamp01 = v => Math.min(1, Math.max(0, v));

  function drawVol(v, m) {
    const f = m ? 0 : v;
    $('vfill').style.transform = `scaleX(${f})`;
    $('vknob').style.left = (f * 100) + '%';
    $('volVal').textContent = Math.round(f * 100);
    volEl.dataset.level = (m || v < .005) ? 'mute' : v < .5 ? 'low' : 'high';
  }
  function openVol(autoHide = true) {
    if (!volEl.classList.contains('open')) volOpenedByTap = 0;
    volEl.classList.add('open');
    clearTimeout(volHideTimer);
    if (autoHide) volHideTimer = setTimeout(() => { if (!volDragging) volEl.classList.remove('open'); }, 3500);
  }
  function applyVolume(s) {
    if (typeof s.volume !== 'number') { volEl.hidden = true; return; }
    volEl.hidden = false;
    if (volDragging || performance.now() < volHoldUntil) return;
    // громкость поменяли снаружи (Ctrl+Alt+стрелки, клавиши ноутбука) — покажем ползунок
    const changed = vol !== null && (Math.abs(s.volume - vol) > .004 || !!s.muted !== muted);
    vol = s.volume; muted = !!s.muted;
    drawVol(vol, muted);
    if (changed && body.dataset.mode === 'playing' && MP.page === 0) openVol();
  }
  async function sendVol(q) {
    const j = await MP.post(q);
    if (typeof j.volume === 'number' && !volDragging) { vol = j.volume; muted = !!j.muted; drawVol(vol, muted); }
  }
  function nudgeVol(d) {
    if (vol === null) return;
    vol = clamp01(vol + d); if (d > 0) muted = false;
    drawVol(vol, muted);
    volHoldUntil = performance.now() + 1200;
    if (MP.page === 0) openVol();
    sendVol(`volume?delta=${d}`);
  }

  $('volBtn').addEventListener('click', () => {
    const now = performance.now();
    // первый тап только открывает ползунок; если он выехал сам — тоже просто «берём» его
    if (!volEl.classList.contains('open') || !volOpenedByTap) { openVol(); volOpenedByTap = now; return; }
    if (now - volOpenedByTap < 350) { openVol(); return; }  // случайный двойной тап
    muted = !muted; drawVol(vol ?? 0, muted);
    volHoldUntil = now + 1200;
    openVol();
    sendVol(`mute?on=${muted ? 1 : 0}`);  // явное состояние, а не «переключить»
  });

  const vfrac = e => { const r = vbar.querySelector('.track').getBoundingClientRect(); return clamp01((e.clientX - r.left) / r.width); };
  const setFromPointer = (e, force) => {
    vol = vfrac(e); muted = false; drawVol(vol, false);
    const now = performance.now();
    if (force || now - lastVolSend > 60) { lastVolSend = now; sendVol(`volume?v=${vol.toFixed(3)}`); }
  };
  vbar.addEventListener('pointerdown', e => {
    volDragging = true; vbar.classList.add('dragging'); openVol(false);
    vbar.setPointerCapture(e.pointerId); setFromPointer(e, true);
  });
  vbar.addEventListener('pointermove', e => { if (volDragging) setFromPointer(e); });
  const endVol = e => {
    if (!volDragging) return;
    setFromPointer(e, true);
    volDragging = false; vbar.classList.remove('dragging');
    volHoldUntil = performance.now() + 1200; openVol();
  };
  vbar.addEventListener('pointerup', endVol);
  vbar.addEventListener('pointercancel', endVol);
  volEl.addEventListener('wheel', e => { e.preventDefault(); nudgeVol(e.deltaY < 0 ? .04 : -.04); }, { passive: false });

  /* ---------- клавиатура: ←/→ трек, ↑/↓ громкость, пробел пауза ---------- */
  const flash = id => { const b = $(id); b.classList.add('pressed'); setTimeout(() => b.classList.remove('pressed'), 160); };
  let lastVolKey = 0;
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (e.repeat) return;
      const id = e.key === 'ArrowLeft' ? 'prev' : 'next';
      if (!$(id).disabled) { flash(id); MP.post(id); }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const now = performance.now();
      if (now - lastVolKey < 60) return;
      lastVolKey = now;
      nudgeVol(e.key === 'ArrowUp' ? .04 : -.04);
    } else if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) { flash('toggle'); $('toggle').click(); }
    }
  });
})();
