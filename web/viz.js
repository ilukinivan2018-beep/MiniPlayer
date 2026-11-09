/* Визуализатор: зеркальные полоски внизу экрана, прыгают под реальный звук.
   Работает только пока видна страница плеера или текста и играет музыка. */
(() => {
  const cv = MP.$('viz'), ctx = cv.getContext('2d');
  let es = null, bands = null, raf = 0, grad = null, retry = 0;
  let enabled = true;
  try { enabled = localStorage.getItem('mp-viz') !== 'off'; } catch (e) {}

  const want = () => enabled && !document.hidden && document.body.dataset.mode === 'playing'
    && MP.status() === 'playing' && MP.page <= 1;

  function sync() {
    const w = want();
    cv.classList.toggle('show', w);
    if (w && !es) open();
    else if (!w && es) close();
  }
  function open() {
    es = new EventSource('/api/viz');
    es.onmessage = ev => { bands = JSON.parse(ev.data); if (!raf) raf = requestAnimationFrame(draw); };
    es.onerror = () => { close(); clearTimeout(retry); retry = setTimeout(sync, 3000); };
  }
  function close() {
    if (es) { es.close(); es = null; }
    bands = null;
    ctx.clearRect(0, 0, cv.width, cv.height);
  }

  function resize() {
    // рисуем в 1:1 к CSS-пикселям, а не в полном разрешении телефона — так втрое дешевле для процессора
    cv.width = Math.max(1, Math.round(cv.clientWidth));
    cv.height = Math.max(1, Math.round(cv.clientHeight));
    grad = null;
  }
  function gradient() {
    const g = ctx.createLinearGradient(0, cv.height, 0, 0);
    g.addColorStop(0, MP.accent || '#a99bff');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    return g;
  }

  function draw() {
    raf = 0;
    if (!bands) return;
    const W = cv.width, H = cv.height, n = bands.length, total = n * 2;
    const gap = Math.max(2, W / total * .3), bw = (W - gap * (total - 1)) / total, r = Math.min(bw / 2, 6);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = grad || (grad = gradient());
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const h = Math.max(3, bands[i] * H * .95);
      // низкие частоты в центре, высокие — к краям
      const xr = W / 2 + gap / 2 + i * (bw + gap), xl = W / 2 - gap / 2 - (i + 1) * bw - i * gap;
      ctx.roundRect(xr, H - h, bw, h, [r, r, 0, 0]);
      ctx.roundRect(xl, H - h, bw, h, [r, r, 0, 0]);
    }
    ctx.fill();
  }

  MP.viz = {
    get enabled() { return enabled; },
    toggle() {
      enabled = !enabled;
      try { localStorage.setItem('mp-viz', enabled ? 'on' : 'off'); } catch (e) {}
      sync();
      return enabled;
    },
  };

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', sync);
  MP.on('state', sync); MP.on('status', sync); MP.on('page', sync);
  MP.on('accent', () => { grad = null; });
  resize();
})();
