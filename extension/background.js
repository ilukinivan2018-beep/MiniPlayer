/* «Видео на второй экран» — фоновая часть.
   Туда: вкладка с видео переезжает в отдельное окно на втором мониторе и разворачивается на весь экран,
         на её старом месте остаётся вкладка-заглушка.
   Обратно: Esc / кнопка «Вернуть» / выход из полноэкранного режима — вкладка встаёт на место заглушки.
   Вкладка переезжает целиком, поэтому видео не перезагружается и не прерывается. */

const MENU_ID = 'mp2s-toggle';
const TITLE_OUT = 'Вывести видео на второй экран';
const TITLE_BACK = 'Вернуть видео в браузер';

/* ---------- состояние (фоновая часть может «засыпать», поэтому храним его в storage) ---------- */
const getState = async () => (await chrome.storage.session.get('s')).s || null;
const setState = s => chrome.storage.session.set({ s });

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: TITLE_OUT, contexts: ['video', 'page', 'frame', 'link', 'image'] });
});
const setMenu = out => chrome.contextMenus.update(MENU_ID, { title: out ? TITLE_BACK : TITLE_OUT }).catch(() => {});

/* ---------- три способа запустить: правый клик, кнопка на панели, Alt+Shift+V ---------- */
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === MENU_ID && tab) toggle(tab, info.frameId); });
chrome.action.onClicked.addListener(tab => toggle(tab));
chrome.commands.onCommand.addListener((cmd, tab) => { if (cmd === 'toggle-video' && tab) toggle(tab); });

let busy = false;  // защита от двойного нажатия
async function toggle(tab, frameHint) {
  if (busy) return;
  busy = true;
  try {
    const s = await getState();
    if (s && (s.tabId === tab.id || s.placeholderId === tab.id)) return await bringBack(s);
    if (s) await bringBack(s);  // другое видео уже на втором экране — сначала вернём его
    await sendOut(tab, frameHint);
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
  }
}

/* ---------- подготовить страницу: стиль + скрипт во все фреймы ---------- */
async function prepare(tabId) {
  const target = { tabId, allFrames: true };
  const css = { target, files: ['video-mode.css'], origin: 'USER' };
  await chrome.scripting.removeCSS(css).catch(() => {});  // чтобы стиль не вставился дважды
  await chrome.scripting.insertCSS(css).catch(() => {});
  await chrome.scripting.executeScript({ target, files: ['content.js'] });
}
const toast = (tabId, text) => chrome.tabs.sendMessage(tabId, { type: 'toast', text }, { frameId: 0 }).catch(() => {});

async function secondDisplay() {
  const list = await chrome.system.display.getInfo();
  return list.find(d => !d.isPrimary && d.isEnabled !== false) || null;
}

/* В каком фрейме самое подходящее видео (самое большое и играющее; если кликнули по видео — оно). */
async function findVideoFrame(tabId, frameHint) {
  const res = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => (window.__mp2s ? window.__mp2s.probe() : 0),
  });
  const found = res.filter(r => r.result > 0);
  const hinted = found.find(r => r.frameId === frameHint);
  if (hinted) return hinted.frameId;
  found.sort((a, b) => b.result - a.result);
  return found.length ? found[0].frameId : null;
}

/* Включить режим «видео на весь экран» в уже открытой вкладке. */
async function enterMode(tabId, frameHint, prepared = false) {
  if (!prepared) await prepare(tabId);
  const frameId = await findVideoFrame(tabId, frameHint);
  if (frameId === null) return false;
  await chrome.tabs.sendMessage(tabId, { type: 'arm' }).catch(() => {});  // все фреймы готовы поднять фрейм с видео
  return await chrome.tabs.sendMessage(tabId, { type: 'enter' }, { frameId }).catch(() => false);
}

/* Окно иногда создаётся не там, где просили (например, браузер запомнил свои размеры).
   Переставляем явно и ждём, пока оно действительно окажется на втором экране — иначе
   полноэкранный режим включится на основном мониторе. */
async function placeOnDisplay(winId, b) {
  const inside = w => w.left >= b.left - 10 && w.left < b.left + b.width && w.top >= b.top - 10 && w.top < b.top + b.height;
  for (let i = 0; i < 10; i++) {
    const w = await chrome.windows.get(winId);
    if (inside(w)) return true;
    await chrome.windows.update(winId, { state: 'normal', left: b.left, top: b.top, width: b.width, height: b.height });
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

/* ---------- туда ---------- */
async function sendOut(tab, frameHint) {
  if (!/^(https?|file):/.test(tab.url || '')) return;  // служебные страницы браузера трогать нельзя
  await prepare(tab.id);

  const display = await secondDisplay();
  if (!display) return toast(tab.id, 'Второй экран не найден — подключи телефон через spacedesk');
  if ((await findVideoFrame(tab.id, frameHint)) === null) return toast(tab.id, 'На этой странице не нашлось видео');

  // заглушка на месте вкладки — чтобы окно не закрылось и было куда вернуть
  const title = encodeURIComponent(tab.title || '');
  const placeholder = await chrome.tabs.create({
    windowId: tab.windowId, index: tab.index, active: tab.active,
    url: chrome.runtime.getURL(`placeholder.html?title=${title}`),
  });

  const b = display.bounds;
  const win = await chrome.windows.create({ tabId: tab.id, left: b.left, top: b.top, width: b.width, height: b.height, focused: true });
  await placeOnDisplay(win.id, b);
  await chrome.windows.update(win.id, { state: 'fullscreen' });

  await setState({
    tabId: tab.id, winId: win.id, origWinId: tab.windowId, placeholderId: placeholder.id,
    url: tab.url, t: 0, since: Date.now(), frameHint: frameHint ?? null,
  });
  setMenu(true);
  const ok = await enterMode(tab.id, frameHint, true);
  if (!ok) toast(tab.id, 'Не получилось развернуть видео — жми Esc, чтобы вернуть вкладку');
}

/* ---------- обратно ---------- */
async function bringBack(s) {
  await setState(null);
  setMenu(false);
  await chrome.tabs.sendMessage(s.tabId, { type: 'exit' }).catch(() => {});
  await chrome.scripting.removeCSS({ target: { tabId: s.tabId, allFrames: true }, files: ['video-mode.css'], origin: 'USER' }).catch(() => {});

  const ph = s.placeholderId ? await chrome.tabs.get(s.placeholderId).catch(() => null) : null;
  const origAlive = await chrome.windows.get(s.origWinId).then(() => true, () => false);
  try {
    if (origAlive) {
      const index = ph && ph.windowId === s.origWinId ? ph.index : -1;
      await chrome.tabs.move(s.tabId, { windowId: s.origWinId, index });
      // если в окне на втором экране остались другие вкладки — тоже забираем, чтобы окно закрылось
      for (const t of await chrome.tabs.query({ windowId: s.winId }).catch(() => [])) {
        await chrome.tabs.move(t.id, { windowId: s.origWinId, index: -1 }).catch(() => {});
      }
      await chrome.tabs.update(s.tabId, { active: true });
      await chrome.windows.update(s.origWinId, { focused: true });
    } else {
      await chrome.windows.create({ tabId: s.tabId, focused: true, state: 'maximized' });
    }
  } finally {
    if (ph) chrome.tabs.remove(ph.id).catch(() => {});
  }
}

/* ---------- стрелки: как в мини-плеере (←/→ трек, ↑/↓ громкость Windows) ----------
   Команды уходят мини-плееру на этом же компьютере. Если он не запущен — страница
   сама перемотает видео и поменяет его громкость. */
const PLAYER = 'http://127.0.0.1:8765/api/';
const KEY_CMD = { ArrowLeft: 'prev', ArrowRight: 'next', ArrowUp: 'volume?delta=0.04', ArrowDown: 'volume?delta=-0.04' };
async function playerCommand(key) {
  const cmd = KEY_CMD[key];
  if (!cmd) return { ok: false };
  try {
    const r = await fetch(PLAYER + cmd, { method: 'POST', headers: { 'X-MP': '1' }, signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return { ok: !!j.ok, volume: j.volume, muted: j.muted };
  } catch (e) {
    return { ok: false };
  }
}

/* ---------- сообщения со страницы и с заглушки ---------- */
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'key') { playerCommand(msg.key).then(reply); return true; }  // ответим позже
  handleMessage(msg, sender);
});
async function handleMessage(msg, sender) {
  const s = await getState();
  if (!s) return;
  if (msg.type === 'return') {
    if (!busy) { busy = true; try { await bringBack(s); } finally { busy = false; } }
  } else if (msg.type === 'time' && sender.tab && sender.tab.id === s.tabId) {
    if (Math.abs((s.t || 0) - msg.t) > 4) await setState({ ...s, t: msg.t });
  }
}

/* Вышли из полноэкранного режима (F11 и т.п.) — возвращаем видео в браузер. */
chrome.windows.onBoundsChanged.addListener(async w => {
  const s = await getState();
  if (!s || w.id !== s.winId || Date.now() - s.since < 2500 || busy) return;
  const cur = await chrome.windows.get(w.id).catch(() => null);
  if (cur && cur.state !== 'fullscreen') { busy = true; try { await bringBack(s); } finally { busy = false; } }
});

/* В окно на втором экране попала чужая вкладка (ссылка в новой вкладке, Ctrl+T, другое расширение) —
   переносим её в основной браузер, а видео оставляем на экране. */
async function evict(tabId) {
  const s = await getState();
  if (!s || tabId === s.tabId) return;
  const origAlive = await chrome.windows.get(s.origWinId).then(() => true, () => false);
  for (let i = 0; i < 5; i++) {  // браузер может на миг запретить перенос (например, вкладку тащат мышью)
    try {
      if (origAlive) {
        await chrome.tabs.move(tabId, { windowId: s.origWinId, index: -1 });
        await chrome.tabs.update(tabId, { active: true });
      } else {
        await chrome.windows.create({ tabId, focused: false });
      }
      break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  await chrome.tabs.update(s.tabId, { active: true }).catch(() => {});
}
chrome.tabs.onCreated.addListener(async tab => {
  const s = await getState();
  if (s && tab.windowId === s.winId && tab.id !== s.tabId) evict(tab.id);
});
chrome.tabs.onAttached.addListener(async (tabId, info) => {
  const s = await getState();
  if (s && info.newWindowId === s.winId && tabId !== s.tabId) evict(tabId);
});

/* Страница с видео перезагрузилась (например, следующее видео) — снова разворачиваем. */
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const s = await getState();
  if (s && s.tabId === tabId) setTimeout(() => enterMode(tabId, null).catch(() => {}), 800);
});

/* Окно на втором экране закрыли крестиком — вкладка пропала. Открываем страницу обратно на старом месте
   (YouTube — с того же момента), чтобы видео не потерялось. */
chrome.tabs.onRemoved.addListener(async tabId => {
  const s = await getState();
  if (!s) return;
  if (tabId === s.placeholderId) { await setState({ ...s, placeholderId: null }); return; }
  if (tabId !== s.tabId) return;
  await setState(null);
  setMenu(false);
  let url = s.url;
  try {
    const u = new URL(s.url);
    if (/(^|\.)youtube\.com$/.test(u.hostname) && u.searchParams.get('v') && s.t > 5) {
      u.searchParams.set('t', Math.floor(s.t) + 's');
      url = u.toString();
    }
  } catch (e) {}
  const ph = s.placeholderId ? await chrome.tabs.get(s.placeholderId).catch(() => null) : null;
  const origAlive = await chrome.windows.get(s.origWinId).then(() => true, () => false);
  if (origAlive) {
    await chrome.tabs.create({ windowId: s.origWinId, index: ph ? ph.index : undefined, url, active: true });
  } else {
    await chrome.windows.create({ url, focused: true });
  }
  if (ph) chrome.tabs.remove(ph.id).catch(() => {});
});
