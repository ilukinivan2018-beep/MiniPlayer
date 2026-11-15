/* «Видео на второй экран» — часть, которая работает внутри страницы (во всех её фреймах).
   Находит видео, раскрывает его поверх всей страницы и возвращает как было.
   Видео поднимается в «верхний слой» браузера (Popover API): оно оказывается над всем сайтом,
   при этом его не вырываем из страницы — плеер сайта продолжает работать.
   Видео ищем и внутри «теневого DOM» компонентов — так устроены плееры ВК и Одноклассников. */
(() => {
  if (window.__mp2s) return;  // скрипт уже вставлен в этот фрейм
  const S = (window.__mp2s = { armed: false });

  let lastPath = [];          // куда был правый клик (с учётом теневого DOM)
  let video = null, saved = null;
  let raised = null, raisedSaved = null;  // фрейм с видео, поднятый в родительской странице
  let button = null, hideTimer = 0, timeTimer = 0, guardTimer = 0;
  const shadowStyles = new Set();         // теневые деревья, куда мы положили свой стиль

  document.addEventListener('contextmenu', e => { lastPath = e.composedPath(); }, true);

  const send = msg => { try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* расширение перезагрузили */ } };
  const css = (el, props) => { for (const k in props) el.style.setProperty(k, props[k], 'important'); };

  /* ---------- найти все видео, включая теневой DOM ---------- */
  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    try { return chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null; } catch (e) { return null; }
  }
  function allVideos(root = document, out = []) {
    out.push(...root.querySelectorAll('video'));
    for (const el of root.querySelectorAll('*')) { const sr = shadowOf(el); if (sr) allVideos(sr, out); }
    return out;
  }

  /* ---------- какое видео выбрать ---------- */
  const isBig = v => { const r = v.getBoundingClientRect(); return r.width >= 160 && r.height >= 90; };
  function score(v) {
    const r = v.getBoundingClientRect();
    let s = r.width * r.height;
    if (!v.paused && !v.ended) s *= 4;          // играющее важнее
    if (v.readyState >= 2) s *= 1.5;            // уже загружено
    const host = v.getRootNode() instanceof ShadowRoot ? v.getRootNode().host : null;
    if (lastPath.includes(v) || lastPath.includes(v.parentElement) || (host && lastPath.includes(host))) s *= 10;  // по нему кликнули
    return s;
  }
  function best() {
    const list = allVideos().filter(isBig);
    list.sort((a, b) => score(b) - score(a));
    return list[0] || null;
  }
  S.probe = () => { const v = best(); return v ? Math.round(score(v)) : 0; };

  /* ---------- стиль режима для видео внутри теневого DOM (общий стиль туда не доходит) ---------- */
  const FULL_CSS = `
    .mp2s-full:popover-open, .mp2s-full.mp2s-fallback {
      position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
      max-width: none !important; max-height: none !important; min-width: 0 !important; min-height: 0 !important;
      margin: 0 !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important;
      background: #000 !important; transform: none !important; opacity: 1 !important; visibility: visible !important;
      object-fit: contain !important; display: block !important; overflow: hidden !important;
      z-index: 2147483646 !important; pointer-events: auto !important; clip-path: none !important; filter: none !important;
    }
    .mp2s-full::backdrop { background: #000 !important; }
    video.mp2s-full::-webkit-media-controls,
    video.mp2s-full::-webkit-media-controls-enclosure,
    video.mp2s-full::-webkit-media-controls-panel { display: flex !important; visibility: visible !important; }`;
  function ensureShadowStyle(el) {
    const root = el.getRootNode();
    if (!(root instanceof ShadowRoot) || shadowStyles.has(root)) return;
    const st = document.createElement('style');
    st.className = 'mp2s-shadow-style';
    st.textContent = FULL_CSS;
    root.appendChild(st);
    shadowStyles.add(root);
  }
  function removeShadowStyles() {
    for (const root of shadowStyles) root.querySelectorAll('style.mp2s-shadow-style').forEach(s => s.remove());
    shadowStyles.clear();
  }

  /* ---------- поднять элемент поверх всего ----------
     Сайты (например, YouTube) при смене размера окна перекладывают плеер в другое место страницы —
     браузер при этом снимает элемент с верхнего слоя. Поэтому следим и сразу поднимаем обратно. */
  function show(el) {
    if (!el.isConnected || el.matches(':popover-open')) return false;
    if (el.getAttribute('popover') !== 'manual') el.setAttribute('popover', 'manual');
    try { el.showPopover(); el.classList.remove('mp2s-fallback'); } catch (e) { el.classList.add('mp2s-fallback'); }
    return true;
  }
  function bringButtonsToTop() {  // поднятое заново видео ложится поверх кнопки — возвращаем кнопку наверх
    if (button && button.isConnected) { try { button.hidePopover(); button.showPopover(); } catch (e) {} }
  }
  /* Клики и касания по видео не пускаем дальше к плееру сайта: иначе нажал паузу на полосе браузера,
     а сайт получил тот же клик, решил, что нажали на его плеер, — и сразу запустил видео обратно. */
  const POINTER_EVENTS = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel'];
  const swallow = e => e.stopPropagation();
  function lift(el) {
    const keep = { popover: el.getAttribute('popover') };
    ensureShadowStyle(el);
    el.classList.add('mp2s-full');
    show(el);
    if (el.tagName === 'VIDEO') POINTER_EVENTS.forEach(t => el.addEventListener(t, swallow));
    keep.onToggle = e => {
      if (e.newState === 'closed' && el.classList.contains('mp2s-full')) {
        requestAnimationFrame(() => { if (el.classList.contains('mp2s-full') && show(el)) bringButtonsToTop(); });
      }
    };
    el.addEventListener('toggle', keep.onToggle);
    return keep;
  }
  function drop(el, keep) {
    el.removeEventListener('toggle', keep.onToggle);
    POINTER_EVENTS.forEach(t => el.removeEventListener(t, swallow));
    el.classList.remove('mp2s-full', 'mp2s-fallback');
    try { el.hidePopover(); } catch (e) {}
    if (keep.popover === null) el.removeAttribute('popover'); else el.setAttribute('popover', keep.popover);
  }
  // страховка: раз в полсекунды проверяем, что видео (или фрейм с ним) всё ещё наверху
  function startGuard() {
    clearInterval(guardTimer);
    guardTimer = setInterval(() => {
      if (video && !video.isConnected) {  // плеер заменил элемент видео (смена качества и т.п.) — берём новый
        video = null;
        if (button) { button.remove(); button = null; }
        S.enter();
        return;
      }
      let fixed = false;
      for (const el of [video, raised]) if (el && el.classList.contains('mp2s-full')) fixed = show(el) || fixed;
      if (video && !video.controls) video.controls = true;  // сайт мог выключить кнопки браузера
      if (fixed) bringButtonsToTop();
      if (!video && !raised) clearInterval(guardTimer);
    }, 500);
  }

  /* ---------- кнопка «Вернуть» (сама прячется). Стили — прямо на элементе, чтобы сайт их не перебил ---------- */
  function setButtonVisible(on) {
    if (button) css(button, { opacity: on ? '1' : '0', 'pointer-events': on ? 'auto' : 'none' });
  }
  function showButton() {
    if (!button) return;
    setButtonVisible(true);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => setButtonVisible(false), 3000);
  }
  function makeButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mp2s-back';
    b.textContent = '⤺  Вернуть в браузер';
    b.setAttribute('popover', 'manual');
    css(b, {
      appearance: 'none', '-webkit-appearance': 'none',  // без стандартного вида кнопки Windows
      position: 'fixed', inset: '18px auto auto 18px', width: 'auto', height: 'auto', margin: '0', padding: '11px 18px',
      // без backdrop-filter: в верхнем слое браузер рисует размытие белым — кнопка выглядела белой
      border: '1px solid rgba(255,255,255,.22)', 'border-radius': '999px', background: 'rgba(18,18,24,.85)',
      color: '#fff', font: '600 16px/1.2 "Segoe UI", system-ui, sans-serif', cursor: 'pointer',
      'box-shadow': '0 6px 24px rgba(0,0,0,.45)', 'backdrop-filter': 'none', transition: 'opacity .4s ease',
      'z-index': '2147483647', overflow: 'visible',
    });
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); send({ type: 'return' }); }, true);
    document.documentElement.appendChild(b);
    try { b.showPopover(); } catch (e) { b.classList.add('mp2s-fallback'); }
    return b;
  }

  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); send({ type: 'return' }); }
  };

  /* ---------- войти / выйти ---------- */
  S.enter = () => {
    if (video) return true;
    const v = best();
    if (!v) return false;
    video = v;
    saved = { controls: v.controls, lift: null };
    v.controls = true;                 // свои кнопки и полоса перемотки браузера — работают на любом сайте
    saved.lift = lift(v);
    document.documentElement.classList.add('mp2s-noscroll');  // прячем полосу прокрутки страницы
    button = makeButton();
    showButton();
    startGuard();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointermove', showButton, true);
    document.addEventListener('pointerdown', showButton, true);
    if (window !== window.top) window.parent.postMessage({ mp2s: 'raise' }, '*');
    clearInterval(timeTimer);
    timeTimer = setInterval(() => { if (video) send({ type: 'time', t: video.currentTime }); }, 3000);
    return true;
  };

  S.exit = () => {
    if (video) {
      const v = video;
      video = null;
      drop(v, saved.lift);
      v.controls = saved.controls;
    }
    clearInterval(timeTimer);
    clearInterval(guardTimer);
    clearTimeout(hideTimer);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointermove', showButton, true);
    document.removeEventListener('pointerdown', showButton, true);
    if (button) { button.remove(); button = null; }
    lowerFrame();
    removeShadowStyles();
    document.documentElement.classList.remove('mp2s-noscroll');
    S.armed = false;
  };

  /* ---------- видео внутри фрейма: поднимаем сам фрейм в родительской странице ---------- */
  function raiseFrame(el) {
    if (raised === el) return;
    lowerFrame();
    raised = el;
    raisedSaved = lift(el);
    document.documentElement.classList.add('mp2s-noscroll');
    startGuard();
  }
  function lowerFrame() {
    if (!raised) return;
    drop(raised, raisedSaved);
    raised = null;
    if (!video) document.documentElement.classList.remove('mp2s-noscroll');
  }
  window.addEventListener('message', e => {
    const d = e.data;
    if (!S.armed || !d || typeof d !== 'object' || (d.mp2s !== 'raise' && d.mp2s !== 'lower')) return;
    const el = [...document.querySelectorAll('iframe, frame')].find(f => f.contentWindow === e.source);
    if (!el) return;
    if (d.mp2s === 'raise') raiseFrame(el); else lowerFrame();
    if (window !== window.top) window.parent.postMessage({ mp2s: d.mp2s }, '*');  // вложенные фреймы — дальше наверх
  });

  /* ---------- сообщение поверх страницы ---------- */
  S.toast = text => {
    const t = document.createElement('div');
    t.className = 'mp2s-toast';
    t.textContent = text;
    t.setAttribute('popover', 'manual');
    css(t, {
      position: 'fixed', inset: 'auto auto 32px 50%', transform: 'translateX(-50%)', margin: '0', width: 'auto', height: 'auto',
      padding: '12px 20px', border: '0', 'border-radius': '12px', background: 'rgba(18,18,24,.92)', color: '#fff',
      font: '500 15px/1.3 "Segoe UI", system-ui, sans-serif', 'box-shadow': '0 8px 30px rgba(0,0,0,.4)',
      'pointer-events': 'none', 'z-index': '2147483647',
    });
    document.documentElement.appendChild(t);
    try { t.showPopover(); } catch (e) {}
    setTimeout(() => t.remove(), 3500);
  };

  /* ---------- подсказка посреди экрана: «🔊 42%», «⏭ Следующее» ---------- */
  let osd = null, osdTimer = 0;
  function showOsd(text) {
    if (!osd) {
      osd = document.createElement('div');
      osd.className = 'mp2s-osd';
      osd.setAttribute('popover', 'manual');
      css(osd, {
        position: 'fixed', inset: '12% auto auto 50%', transform: 'translateX(-50%)', margin: '0', width: 'auto', height: 'auto',
        padding: '14px 26px', border: '0', 'border-radius': '18px', background: 'rgba(14,14,20,.86)', color: '#fff',
        font: '650 26px/1.2 "Segoe UI", system-ui, sans-serif', 'font-variant-numeric': 'tabular-nums',
        'backdrop-filter': 'none', 'box-shadow': '0 10px 34px rgba(0,0,0,.45)', 'pointer-events': 'none', 'z-index': '2147483647',
      });
      document.documentElement.appendChild(osd);
    }
    osd.textContent = text;
    try { osd.hidePopover(); osd.showPopover(); } catch (e) { osd.classList.add('mp2s-fallback'); }  // заново — чтобы оказаться поверх видео
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => { try { osd.hidePopover(); } catch (e) {} osd.remove(); osd = null; }, 1100);
  }

  /* ---------- стрелки: как в мини-плеере ---------- */
  const ARROWS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };
  let lastVolKey = 0;
  function localKey(key) {  // мини-плеер не отвечает — управляем самим видео
    const v = video || best();
    if (!v) return;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const d = key === 'ArrowRight' ? 10 : -10;
      v.currentTime = Math.max(0, Math.min((v.duration || Infinity) - 0.5, v.currentTime + d));
      showOsd(d > 0 ? '⏩  +10 с' : '⏪  −10 с');
    } else {
      v.muted = false;
      v.volume = Math.max(0, Math.min(1, v.volume + (key === 'ArrowUp' ? 0.05 : -0.05)));
      showOsd(`🔊  ${Math.round(v.volume * 100)}%`);
    }
  }
  function onArrow(e) {
    if (!S.armed || !ARROWS[e.key] || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();  // чтобы сайт (например, YouTube) не перематывал заодно сам
    const vol = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    if (!vol && e.repeat) return;
    const now = performance.now();
    if (vol && now - lastVolKey < 60) return;  // зажатая клавиша — не быстрее ~16 шагов в секунду
    lastVolKey = now;
    const key = e.key;
    chrome.runtime.sendMessage({ type: 'key', key }).then(res => {
      if (!res || !res.ok) return localKey(key);
      if (vol) showOsd(res.muted ? '🔇  Без звука' : `🔊  ${Math.round((res.volume || 0) * 100)}%`);
      else showOsd(key === 'ArrowRight' ? '⏭  Следующее' : '⏮  Предыдущее');
    }).catch(() => localKey(key));
  }

  // Esc в любом фрейме страницы (фокус может быть не там, где видео)
  const onArmedKey = e => {
    if (!S.armed) return;
    if (e.key === 'Escape') { e.preventDefault(); send({ type: 'return' }); return; }
    // пробел — пауза ровно один раз (иначе его ловят и сайт, и браузер — двойное переключение)
    if ((e.code === 'Space' || e.key === ' ') && video && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) { if (video.paused) video.play().catch(() => {}); else video.pause(); }
      return;
    }
    if (video || raised || window === window.top) onArrow(e);  // стрелки ловим там, где режим включён
  };

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === 'arm') { S.armed = true; window.addEventListener('keydown', onArmedKey, true); }
    else if (msg.type === 'enter') { reply(S.enter()); return; }
    else if (msg.type === 'exit') { S.exit(); window.removeEventListener('keydown', onArmedKey, true); }
    else if (msg.type === 'toast' && window === window.top) S.toast(msg.text);
  });
})();
