/* «Видео на второй экран» — часть, которая работает внутри страницы (во всех её фреймах).
   Находит видео, раскрывает его поверх всей страницы и возвращает как было.
   Видео поднимается в «верхний слой» браузера (Popover API): оно оказывается над всем сайтом,
   при этом его не вырываем из страницы — плеер сайта продолжает работать. */
(() => {
  if (window.__mp2s) return;  // скрипт уже вставлен в этот фрейм
  const S = (window.__mp2s = { armed: false });

  let lastTarget = null;      // по чему был правый клик
  let video = null, saved = null;
  let raised = null, raisedSaved = null;  // фрейм с видео, поднятый в родительской странице
  let button = null, hideTimer = 0, timeTimer = 0;

  document.addEventListener('contextmenu', e => { lastTarget = e.target; }, true);

  const send = msg => { try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* расширение перезагрузили */ } };

  /* ---------- какое видео выбрать ---------- */
  const isBig = v => { const r = v.getBoundingClientRect(); return r.width >= 160 && r.height >= 90; };
  function score(v) {
    const r = v.getBoundingClientRect();
    let s = r.width * r.height;
    if (!v.paused && !v.ended) s *= 4;          // играющее важнее
    if (v.readyState >= 2) s *= 1.5;            // уже загружено
    if (lastTarget && (v === lastTarget || (v.parentElement && v.parentElement.contains(lastTarget)))) s *= 10;  // по нему кликнули
    return s;
  }
  function best() {
    const list = [...document.querySelectorAll('video')].filter(isBig);
    list.sort((a, b) => score(b) - score(a));
    return list[0] || null;
  }
  S.probe = () => { const v = best(); return v ? Math.round(score(v)) : 0; };

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
  function lift(el) {
    const keep = { popover: el.getAttribute('popover') };
    el.classList.add('mp2s-full');
    show(el);
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
    el.classList.remove('mp2s-full', 'mp2s-fallback');
    try { el.hidePopover(); } catch (e) {}
    if (keep.popover === null) el.removeAttribute('popover'); else el.setAttribute('popover', keep.popover);
  }
  // страховка: раз в полсекунды проверяем, что видео (или фрейм с ним) всё ещё наверху
  let guardTimer = 0;
  function startGuard() {
    clearInterval(guardTimer);
    guardTimer = setInterval(() => {
      let fixed = false;
      for (const el of [video, raised]) if (el && el.classList.contains('mp2s-full')) fixed = show(el) || fixed;
      if (video && !video.controls) video.controls = true;  // сайт мог выключить кнопки браузера
      if (fixed) bringButtonsToTop();
      if (!video && !raised) clearInterval(guardTimer);
    }, 500);
  }

  /* ---------- кнопка «Вернуть» (сама прячется) ---------- */
  function showButton() {
    if (!button) return;
    button.classList.remove('mp2s-hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => button && button.classList.add('mp2s-hidden'), 3000);
  }
  function makeButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mp2s-back';
    b.textContent = '⤺  Вернуть в браузер';
    b.setAttribute('popover', 'manual');
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
    timeTimer = setInterval(() => { if (video) send({ type: 'time', t: video.currentTime }); }, 3000);
    return true;
  };

  S.exit = () => {
    if (video) {
      const v = video;
      video = null;
      drop(v, saved.lift);
      v.controls = saved.controls;
      clearInterval(timeTimer);
      clearTimeout(hideTimer);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointermove', showButton, true);
      document.removeEventListener('pointerdown', showButton, true);
      if (button) { button.remove(); button = null; }
    }
    lowerFrame();
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
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  };

  /* ---------- подсказка посреди экрана: «🔊 42%», «⏭ Следующее» ---------- */
  let osd = null, osdTimer = 0;
  function showOsd(text) {
    if (!osd) {
      osd = document.createElement('div');
      osd.className = 'mp2s-osd';
      osd.setAttribute('popover', 'manual');
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
    if (video || raised || window === window.top) onArrow(e);  // стрелки ловим там, где режим включён
  };

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === 'arm') { S.armed = true; window.addEventListener('keydown', onArmedKey, true); }
    else if (msg.type === 'enter') { reply(S.enter()); return; }
    else if (msg.type === 'exit') { S.exit(); window.removeEventListener('keydown', onArmedKey, true); }
    else if (msg.type === 'toast' && window === window.top) S.toast(msg.text);
  });
})();
