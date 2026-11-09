/* Демо-режим (?demo): выдуманная песня, своя обложка и текст, фейковые данные системы.
   Ничего не выполняет и не берёт с компьютера — нужен для скриншотов и чтобы посмотреть интерфейс. */
(() => {
  const params = new URLSearchParams(location.search);

  /* ---------- обложка: рисуем сами ---------- */
  const c = document.createElement('canvas');
  c.width = c.height = 600;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 600, 600);
  g.addColorStop(0, '#2b1a5e'); g.addColorStop(.55, '#7b2f8f'); g.addColorStop(1, '#f2766b');
  x.fillStyle = g; x.fillRect(0, 0, 600, 600);
  const sun = x.createRadialGradient(300, 330, 20, 300, 330, 190);
  sun.addColorStop(0, '#ffd27a'); sun.addColorStop(1, '#ff7a6b');
  x.fillStyle = sun; x.beginPath(); x.arc(300, 330, 170, 0, Math.PI * 2); x.fill();
  x.fillStyle = 'rgba(43, 26, 94, .55)';
  for (let i = 0; i < 7; i++) x.fillRect(110, 360 + i * 22, 380, 7 + i * 1.4);
  x.fillStyle = '#1b1238';
  [[40, 120, 330], [150, 70, 260], [215, 90, 300], [300, 60, 230], [355, 110, 340], [460, 80, 280], [535, 65, 250]]
    .forEach(([bx, bw, top]) => x.fillRect(bx, top + 120, bw, 600));
  x.fillStyle = 'rgba(255, 220, 150, .85)';
  for (let i = 0; i < 46; i++) x.fillRect(50 + (i * 97) % 520, 420 + (i * 53) % 150, 6, 9);
  const ART = c.toDataURL('image/png');

  // картинки обложки грузятся по адресу /art — подменяем на нашу
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, String(v).startsWith('/art') ? ART : v); },
  });

  /* ---------- песня и текст (текст сочинён для демо) ---------- */
  const t0 = performance.now();
  const START = +(params.get('t') || 63);
  const state = () => ({
    active: true, app: 'Яндекс Музыка', appId: 'demo', title: 'Ночной город', artist: 'Огни и провода', album: 'Демо',
    status: 'playing', position: START + (performance.now() - t0) / 1000, duration: 214,
    canToggle: true, canNext: true, canPrev: true, canSeek: true, art: 'demo',
    volume: .42, muted: false, mic_muted: false, hotkeys: 'Ctrl+Alt', ui: 'demo',
  });
  const LINES = [
    [8, 'Огни над крышами горят'], [12, 'И город медленно остыл'], [16, 'Мы едем ночью наугад'],
    [20, 'Туда, где ты меня забыл'], [24, ''], [40, 'Неон дрожит в сырой воде'],
    [44, 'Трамвай звенит на повороте'], [48, 'Я узнаю тебя везде'], [52, 'В любой мелодии и ноте'],
    [57, 'А ночь длинна, а ночь светла'], [61, 'И провода поют над нами'], [65, 'Ты просто рядом с ней была'],
    [69, 'Между звонками и словами'], [74, ''], [90, 'Огни над крышами горят'], [94, 'И город медленно остыл'],
  ];

  /* ---------- система: правдоподобные цифры с историей ---------- */
  const wave = (n, base, amp, f, ph = 0) => Array.from({ length: n }, (_, i) =>
    Math.round(Math.max(0, base + amp * Math.sin(i * f + ph) + amp * .45 * Math.sin(i * f * 3.1 + ph * 2))));
  const sys = withHist => {
    const out = {
      cur: {
        gpu: { name: 'NVIDIA GeForce GTX 1660', util: 63, memUsed: 3.4, memTotal: 6.0, temp: 64, power: 78, powerLimit: 130, fan: 48, clock: 1785 },
        cpu: 27, cores: 6, ramUsed: 11.8, ramTotal: 31.9, ram: 37, down: 2400000, up: 180000,
      },
      top: [{ name: 'game', cpu: 14 }, { name: 'firefox', cpu: 6 }, { name: 'discord', cpu: 2 }],
    };
    if (withHist) out.hist = {
      gpu: wave(120, 58, 12, .11), vram: wave(120, 55, 3, .05), temp: wave(120, 62, 3, .04),
      cpu: wave(120, 25, 9, .23, 1), ram: wave(120, 37, 1, .03), down: wave(120, 1500000, 900000, .17, 2), up: wave(120, 150000, 60000, .2),
    };
    return out;
  };
  const DECK = { minimized: false, tiles: [
    ['firefox', 'Firefox', 'globe', '#ff8a4c'], ['ymusic', 'Яндекс Музыка', 'music', '#ffd84d'], ['telegram', 'Telegram', 'send', '#4fb6ff'],
    ['discord', 'Discord', 'chat', '#8b9bff'], ['steam', 'Steam', 'gamepad', '#5fb4ff'], ['explorer', 'Проводник', 'folder', '#f5c84c'],
    ['minimize', 'Свернуть всё', 'minimize', '#6ee7b7', 'minimize'], ['screenshot', 'Скриншот', 'scissors', '#f58ac0', 'keys'],
    ['taskmgr', 'Диспетчер задач', 'activity', '#6cb6ff'], ['mic', 'Микрофон', 'mic', '#4ade80', 'mic'],
    ['viz', 'Визуализатор', 'waves', '#a99bff', 'ui'], ['lock', 'Заблокировать', 'lock', '#f87171', 'lock'],
  ].map(([id, label, icon, tint, type = 'run']) => ({ id, label, icon, tint, type, name: type === 'ui' ? 'viz' : null, confirm: id === 'lock' })) };

  const json = o => Promise.resolve(new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    const u = String(url);
    if (opts && opts.method === 'POST') return json({ ok: true, volume: .42, muted: false });  // в демо ничего не выполняем
    if (u.startsWith('/api/state')) return json(state());
    if (u.startsWith('/api/lyrics')) return json({ status: 'synced', lines: LINES });
    if (u.startsWith('/api/sys')) return json(sys(u.includes('hist')));
    if (u.startsWith('/api/deck')) return json(DECK);
    return realFetch(url, opts);
  };

  // визуализатор: красивый «звук» без звука
  window.EventSource = class {
    constructor() {
      this.timer = setInterval(() => {
        const t = performance.now() / 1000;
        const bands = Array.from({ length: 40 }, (_, i) =>
          Math.max(.04, Math.min(1, .78 - i * .013 + .2 * Math.sin(t * 3.1 + i * .62) * Math.cos(t * 1.4 + i * .21))));
        if (this.onmessage) this.onmessage({ data: JSON.stringify(bands) });
      }, 33);
    }
    close() { clearInterval(this.timer); }
  };

  window.addEventListener('load', () => { if (params.has('page')) MP.goPage(+params.get('page'), false); });
})();
