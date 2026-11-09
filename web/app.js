/* Ядро мини-плеера: опрос сервера, позиция трека, страницы со свайпом,
   защита AMOLED-экрана от выгорания. Остальные файлы подписываются на события MP. */
const MP = (() => {
  const $ = id => document.getElementById(id);
  const body = document.body;
  const listeners = {};
  const PAGES = 4;

  const api = {
    $, state: {}, page: 0, pages: PAGES, seeking: false,
    on(evt, fn) { (listeners[evt] ||= []).push(fn); },
    emit(evt, data) { (listeners[evt] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); },
    post(path) {
      return fetch('/api/' + path, { method: 'POST', headers: { 'X-MP': '1' } })
        .then(r => r.json()).catch(() => ({ ok: false }));
    },
  };

  /* ---------- позиция и статус трека (общие для плеера и текста) ---------- */
  const P = { base: 0, at: performance.now(), status: 'stopped', duration: 0, holdPos: 0, holdStatus: 0 };
  api.status = () => P.status;
  api.duration = () => P.duration;
  api.position = () => {
    let p = P.base;
    if (P.status === 'playing') p += (performance.now() - P.at) / 1000;
    return P.duration ? Math.min(p, P.duration) : p;
  };
  api.setPosition = (t, holdMs = 2000) => {
    P.base = t; P.at = performance.now(); P.holdPos = performance.now() + holdMs;
  };
  api.setStatus = (st, holdMs = 1500) => {
    P.base = api.position(); P.at = performance.now();
    P.status = st; P.holdStatus = performance.now() + holdMs;
    body.dataset.status = st;
    api.emit('status', st);
  };

  let trackKey = null, uiVer = null, lastActiveAt = 0;
  const GRACE_MS = 5000;
  function onState(s) {
    // файлы страницы обновили — перезагружаемся сами
    if (s.ui) { if (uiVer === null) uiVer = s.ui; else if (s.ui !== uiVer) { location.reload(); return; } }
    const now = performance.now();
    const active = !!(s.active && (s.title || s.artist));
    if (active) lastActiveAt = now;
    else if (body.dataset.mode === 'playing' && now - lastActiveAt < GRACE_MS) {
      // между песнями Windows на секунду говорит «ничего не играет» — не мигаем часами, ждём следующий трек
      return;
    }
    api.state = s;
    body.dataset.mode = active ? 'playing' : 'idle';
    if (active) {
      if (now > P.holdStatus && s.status !== P.status) {
        P.base = api.position(); P.at = now; P.status = s.status;
        body.dataset.status = s.status;
        api.emit('status', s.status);
      }
      P.duration = s.duration || 0;
      if (!api.seeking && now > P.holdPos) { P.base = s.position || 0; P.at = now; }
    } else if (P.status !== 'stopped') {
      P.status = 'stopped'; body.dataset.status = 'stopped'; api.emit('status', 'stopped');
    }
    const key = active ? `${s.appId}|${s.title}|${s.artist}` : '';
    if (key !== trackKey) { trackKey = key; api.emit('track', active ? s : null); }
    api.emit('state', s);
  }

  let failures = 0;
  async function poll() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      onState(await r.json());
      failures = 0;
    } catch (e) {
      if (++failures > 3) { body.dataset.mode = 'idle'; api.emit('offline'); }
    } finally {
      setTimeout(poll, 700);
    }
  }

  /* ---------- часы ---------- */
  const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  function clock() {
    const now = new Date(), t = timeFmt.format(now), d = dateFmt.format(now);
    $('clockMini').textContent = t;
    $('bigClock').textContent = t;
    $('date').textContent = d.charAt(0).toUpperCase() + d.slice(1);
  }

  /* ---------- страницы и свайп ---------- */
  const pagesEl = $('pages');
  function goPage(i, animate = true) {
    i = Math.max(0, Math.min(PAGES - 1, i));
    pagesEl.style.transition = animate ? '' : 'none';
    pagesEl.style.transform = `translateX(${-i * 100}%)`;
    if (i === api.page && body.dataset.page === String(i)) return;
    api.page = i;
    body.dataset.page = i;
    document.querySelectorAll('#dots button').forEach(b => b.classList.toggle('on', +b.dataset.page === i));
    try { localStorage.setItem('mp-page', i); } catch (e) {}
    api.emit('page', i);
  }
  api.goPage = goPage;

  let sw = null, suppressClick = false;
  pagesEl.addEventListener('pointerdown', e => {
    if (e.target.closest('.bar, .ly-plain')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sw = { x0: e.clientX, y0: e.clientY, t0: performance.now(), id: e.pointerId, active: false };
  });
  window.addEventListener('pointermove', e => {
    if (!sw || e.pointerId !== sw.id) return;
    const dx = e.clientX - sw.x0, dy = e.clientY - sw.y0;
    if (!sw.active) {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        sw.active = true; suppressClick = true; pagesEl.style.transition = 'none';
      } else if (Math.abs(dy) > 24) { sw = null; return; } else return;
    }
    const edge = (api.page === 0 && dx > 0) || (api.page === PAGES - 1 && dx < 0);
    pagesEl.style.transform = `translateX(calc(${-api.page * 100}% + ${edge ? dx * .3 : dx}px))`;
  });
  const endSwipe = e => {
    if (!sw || e.pointerId !== sw.id) return;
    if (sw.active) {
      const dx = e.clientX - sw.x0, v = dx / Math.max(1, performance.now() - sw.t0);
      let i = api.page;
      if (e.type !== 'pointercancel') {
        if (dx < -innerWidth * .16 || v < -.45) i++;
        else if (dx > innerWidth * .16 || v > .45) i--;
      }
      body.dataset.page = '';  // чтобы goPage точно отработал анимацию
      goPage(i);
      setTimeout(() => { suppressClick = false; }, 60);
    }
    sw = null;
  };
  window.addEventListener('pointerup', endSwipe);
  window.addEventListener('pointercancel', endSwipe);
  document.addEventListener('click', e => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }, true);
  $('dots').addEventListener('click', e => { const b = e.target.closest('button'); if (b) goPage(+b.dataset.page); });
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key >= '1' && e.key <= String(PAGES)) goPage(+e.key - 1);
    else if (e.key === 'PageDown' || e.key === 'Tab') { e.preventDefault(); goPage((api.page + 1) % PAGES); }
    else if (e.key === 'PageUp') { e.preventDefault(); goPage((api.page + PAGES - 1) % PAGES); }
  });

  /* ---------- защита экрана от выгорания ---------- */
  // 1) раз в полторы минуты всё чуть-чуть сдвигается (незаметно глазу)
  // 2) если долго не трогать — кнопки притухают, а без музыки экран затемняется
  let lastAct = performance.now();
  const shiftEl = $('shift');
  function shift() {
    const big = body.dataset.mode === 'idle';
    const ax = big ? 26 : 7, ay = big ? 18 : 5;
    shiftEl.style.setProperty('--sx', Math.round((Math.random() * 2 - 1) * ax) + 'px');
    shiftEl.style.setProperty('--sy', Math.round((Math.random() * 2 - 1) * ay) + 'px');
  }
  function wake() {
    lastAct = performance.now();
    if (body.dataset.dim !== '0') body.dataset.dim = '0';
    body.classList.remove('calm');
  }
  ['pointerdown', 'keydown', 'wheel'].forEach(ev => document.addEventListener(ev, wake, { passive: true, capture: true }));
  document.addEventListener('mousemove', () => { lastAct = performance.now(); body.classList.remove('calm'); }, { passive: true });
  // первый тап по затемнённому экрану только будит, а не жмёт кнопку под пальцем
  $('dim').addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); wake(); });
  function burnCheck() {
    const idleFor = (performance.now() - lastAct) / 1000;
    const playing = P.status === 'playing' && body.dataset.mode === 'playing';
    body.classList.toggle('calm', idleFor > 45);
    let dim = 0;
    if (!playing) dim = idleFor > 600 ? 2 : idleFor > 180 ? 1 : 0;
    else if (api.page >= 2 && idleFor > 900) dim = 1;
    if (body.dataset.dim !== String(dim)) body.dataset.dim = dim;
  }

  // скрываем курсор, когда мышь не двигается
  let cursorTimer;
  document.addEventListener('mousemove', () => {
    body.classList.remove('hide-cursor'); clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => body.classList.add('hide-cursor'), 2500);
  });
  // двойной тап по пустому месту — полноэкранный режим вкл/выкл
  document.addEventListener('dblclick', e => {
    if (e.target.closest('button, .bar, .tile, .ly-line, .mt')) return;
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
  });
  document.addEventListener('contextmenu', e => e.preventDefault());

  api.start = () => {
    clock(); setInterval(clock, 5000);
    let saved = 0;
    try { saved = +(localStorage.getItem('mp-page') || 0); } catch (e) {}
    body.dataset.page = '';
    goPage(saved, false);
    shift(); setInterval(shift, 90000);
    setInterval(burnCheck, 2000);
    poll();
  };
  return api;
})();
