/* Страница 4: пульт. Плитки описаны в deck.json, сервер выполняет только их. */
(() => {
  const { $ } = MP;
  const S = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const ICONS = {
    globe: S('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.8 3.8 5.8 3.8 9s-1.2 6.2-3.8 9c-2.6-2.8-3.8-5.8-3.8-9S9.4 5.8 12 3z"/>'),
    music: S('<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="17.5" cy="16" r="2.5" fill="currentColor"/>'),
    chat: S('<path d="M20 12.5a7.5 7.5 0 0 1-10.9 6.7L4 20.5l1.4-4.5A7.5 7.5 0 1 1 20 12.5z"/><path d="M9 12h.01M12.5 12h.01M16 12h.01" stroke-width="2.8"/>'),
    gem: S('<path d="M7 3.5h10l4 5.5-9 11.5L3 9z"/><path d="M3 9h18M12 20.5 8.5 9 12 3.5 15.5 9z"/>'),
    gamepad: S('<path d="M6.5 7.5h11a4 4 0 0 1 4 4.2l-.4 4.3a2.5 2.5 0 0 1-4.3 1.5L15 15.5H9l-1.8 2a2.5 2.5 0 0 1-4.3-1.5l-.4-4.3a4 4 0 0 1 4-4.2z"/><path d="M8 10.5v3M6.5 12h3"/><path d="M15.5 11h.01M17.5 13h.01" stroke-width="2.6"/>'),
    folder: S('<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>'),
    minimize: S('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M9 10.5l3 3 3-3"/>'),
    scissors: S('<circle cx="6" cy="6.5" r="2.5"/><circle cx="6" cy="17.5" r="2.5"/><path d="M8.2 7.8 20 18M8.2 16.2 20 6"/>'),
    activity: S('<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>'),
    mic: S('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
    micOff: S('<path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5"/><path d="M5.5 11a6.5 6.5 0 0 0 10.4 5.2M18.4 12.6c.07-.5.1-1 .1-1.6M12 17.5V21M3 3l18 18"/>'),
    waves: S('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3"/>'),
    lock: S('<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/>'),
    send: S('<path d="M21 3.5 3 10.8l6.8 2.6L12.4 20l3.2-5.4L21 3.5z"/><path d="M9.8 13.4 21 3.5"/>'),
    code: S('<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15"/>'),
    app: S('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 12h6M12 9v6"/>'),
  };

  let tiles = [], armed = null, armTimer = 0;
  const els = {};

  function isActive(t) {
    const s = MP.state || {};
    if (t.type === 'mic') return s.mic_muted === true;
    if (t.type === 'mute') return s.muted === true;
    if (t.type === 'ui' && t.name === 'viz') return MP.viz && MP.viz.enabled;
    if (t.type === 'minimize') return !!t._active;
    return false;
  }
  function paint(t) {
    const el = els[t.id];
    if (!el) return;
    const active = isActive(t);
    const sig = `${active}|${armed === t.id}`;
    if (el.dataset.sig === sig) return;  // ничего не поменялось — не перерисовываем
    el.dataset.sig = sig;
    el.classList.toggle('active', active);
    el.classList.toggle('armed', armed === t.id);
    let icon = t.icon;
    if (t.type === 'mic' && active) icon = 'micOff';
    el.querySelector('.ti').innerHTML = ICONS[icon] || ICONS.app;
    el.querySelector('.tl').textContent = armed === t.id ? 'Нажми ещё раз' : (active && t.labelActive) || t.label;
  }

  function render() {
    const root = $('deck');
    root.innerHTML = '';
    tiles.forEach(t => {
      const b = document.createElement('button');
      b.className = 'tile';
      b.style.setProperty('--tint', t.tint || '#a99bff');
      b.innerHTML = '<div class="ti"></div><div class="tl"></div>';
      b.setAttribute('aria-label', t.label);
      b.addEventListener('click', () => press(t));
      root.append(b);
      els[t.id] = b;
      paint(t);
    });
  }

  function feedback(t, ok) {
    const el = els[t.id];
    el.classList.remove('ok', 'fail'); void el.offsetWidth;
    el.classList.add(ok ? 'ok' : 'fail');
    setTimeout(() => el.classList.remove('ok', 'fail'), 600);
  }

  async function press(t) {
    // опасные плитки (блокировка) — только со второго нажатия
    if (t.confirm && armed !== t.id) {
      armed = t.id; paint(t);
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armed = null; paint(t); }, 2500);
      return;
    }
    armed = null; clearTimeout(armTimer);
    if (t.type === 'ui') {
      if (t.name === 'viz' && MP.viz) MP.viz.toggle();
      paint(t); feedback(t, true);
      return;
    }
    const res = await MP.post('deck?id=' + encodeURIComponent(t.id));
    if (typeof res.active === 'boolean') {
      t._active = res.active;
      if (t.type === 'mic') MP.state.mic_muted = res.active;
    }
    paint(t); feedback(t, !!res.ok);
  }

  async function load() {
    try {
      const d = await (await fetch('/api/deck')).json();
      tiles = d.tiles || [];
      const m = tiles.find(t => t.type === 'minimize');
      if (m) m._active = !!d.minimized;
      render();
    } catch (e) { setTimeout(load, 3000); }
  }

  MP.on('state', () => tiles.forEach(t => { if (t.type === 'mic' || t.type === 'mute' || t.type === 'ui') paint(t); }));
  MP.on('page', p => { if (p === 3) load(); });  // перечитываем deck.json — вдруг его поменяли
  load();
})();
