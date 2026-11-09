/* Страница 2: текст песни из LRCLIB. Синхронный текст едет в такт, тап по строке — перемотка. */
(() => {
  const { $ } = MP;
  const view = $('lyView'), linesEl = $('lyLines'), plainEl = $('lyPlain'), msg = $('lyMsg');
  let token = 0, data = null, lineEls = [], times = [], cur = -2, plainTouched = 0, retryTimer = 0;

  function show(kind, text, small) {
    view.hidden = kind !== 'synced';
    plainEl.hidden = kind !== 'plain';
    msg.hidden = kind === 'synced' || kind === 'plain';
    if (!msg.hidden) msg.innerHTML = '';
    if (text && !msg.hidden) {
      msg.append(document.createTextNode(text));
      if (small) { const s = document.createElement('small'); s.textContent = small; msg.append(s); }
    }
  }

  async function load(s) {
    const my = ++token;
    clearTimeout(retryTimer);
    data = null; cur = -2;
    show('msg', 'Ищу текст…');
    const q = new URLSearchParams({ title: s.title || '', artist: s.artist || '', album: s.album || '', duration: s.duration || 0 });
    let res;
    try { res = await (await fetch('/api/lyrics?' + q)).json(); } catch (e) { res = { status: 'error' }; }
    if (my !== token) return;  // трек уже сменился
    data = res;
    if (res.status === 'synced') renderSynced(res.lines);
    else if (res.status === 'plain') { plainEl.textContent = res.plain; plainEl.scrollTop = 0; show('plain'); }
    else if (res.status === 'instrumental') show('msg', '♪  Инструментал  ♪', 'В этой песне нет слов');
    else if (res.status === 'none') show('msg', 'Текст не нашёлся', 'В базе LRCLIB нет этой песни');
    else {
      show('msg', 'Не получилось загрузить текст', 'Попробую ещё раз через полминуты');
      retryTimer = setTimeout(() => { if (my === token && MP.state.title) load(MP.state); }, 30000);
    }
  }

  function renderSynced(lines) {
    linesEl.innerHTML = '';
    lineEls = []; times = [];
    const all = lines[0] && lines[0][0] > 4 ? [[0, ''], ...lines] : lines;
    all.forEach(([t, text]) => {
      const el = document.createElement('div');
      el.className = 'ly-line' + (text ? '' : ' gap');
      el.textContent = text || '♪ ♪ ♪';
      el.addEventListener('click', () => MP.seekTo && MP.seekTo(t));
      linesEl.append(el);
      lineEls.push(el); times.push(t);
    });
    cur = -2;
    show('synced');
    tick(true);
  }

  function place() {
    const el = lineEls[Math.max(0, cur)];
    if (!el) return;
    const y = view.clientHeight * .46 - (el.offsetTop + el.offsetHeight / 2);
    linesEl.style.transform = `translateY(${Math.round(y)}px)`;
  }

  function tick(force) {
    if (!data) return;
    const pos = MP.position() + .25;  // чуть заранее — так приятнее читать
    if (data.status === 'synced') {
      let i = -1;
      for (let k = 0; k < times.length && times[k] <= pos; k++) i = k;
      if (i === cur && !force) return;
      cur = i;
      lineEls.forEach((el, k) => { el.classList.toggle('on', k === i); el.classList.toggle('past', k < i); });
      place();
    } else if (data.status === 'plain' && performance.now() - plainTouched > 6000) {
      const d = MP.duration();
      if (d) plainEl.scrollTop = (plainEl.scrollHeight - plainEl.clientHeight) * Math.min(1, pos / d);
    }
  }

  ['pointerdown', 'wheel', 'touchstart'].forEach(ev => plainEl.addEventListener(ev, () => { plainTouched = performance.now(); }, { passive: true }));
  setInterval(() => { if (MP.page === 1) tick(); }, 200);
  MP.on('page', p => { if (p === 1) tick(true); });
  window.addEventListener('resize', () => { if (data && data.status === 'synced') place(); });

  MP.on('track', s => {
    if (!s) { token++; data = null; show('msg', 'Включи музыку — здесь появится текст'); MP.setText('lyTitle', ''); MP.setText('lyArtist', ''); return; }
    MP.setText('lyTitle', s.title || '');
    MP.setText('lyArtist', s.artist || '');
    load(s);
  });
  MP.on('art', src => { $('lyCover').style.visibility = src ? 'visible' : 'hidden'; if (src) $('lyCover').src = src; });
})();
