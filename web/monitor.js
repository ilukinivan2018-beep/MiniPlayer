/* Страница 3: монитор видеокарты и системы. Опрос раз в секунду — только пока страница открыта. */
(() => {
  const { $ } = MP;
  const N = 120;
  const series = { gpu: [], vram: [], temp: [], cpu: [], ram: [], down: [], up: [] };
  const canvases = [...document.querySelectorAll('.mt canvas')];
  let timer = 0, haveHist = false;

  const fmtRate = b => b >= 1048576 ? (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + ' МБ/с'
    : b >= 1024 ? Math.round(b / 1024) + ' КБ/с' : Math.round(b) + ' Б/с';
  const level = (v, warn, bad) => v == null ? '' : v >= bad ? 'bad' : v >= warn ? 'warn' : '';
  function setVal(id, html, cls = '') {
    const el = $(id);
    if (el.innerHTML !== html) el.innerHTML = html;
    el.className = 'mt-val' + (cls ? ' ' + cls : '');
  }

  function render(d) {
    const c = d.cur || {}, g = c.gpu;
    if (d.hist) {
      for (const k in series) series[k] = (d.hist[k] || []).slice(-N);
      haveHist = true;
    } else if (c.cpu != null) {
      const vram = g && g.memTotal ? Math.round(100 * g.memUsed / g.memTotal) : null;
      const add = { gpu: g?.util ?? null, vram, temp: g?.temp ?? null, cpu: c.cpu, ram: c.ram, down: c.down, up: c.up };
      for (const k in series) { series[k].push(add[k]); if (series[k].length > N) series[k].shift(); }
    }

    MP.setText('gpuName', g?.name || 'видеокарта не найдена');
    if (g) {
      setVal('mGpu', `${g.util ?? '—'}<small>%</small>`);
      MP.setText('mGpuSub', [g.clock && `${g.clock} МГц`, g.power != null && `${g.power}${g.powerLimit ? ' / ' + g.powerLimit : ''} Вт`].filter(Boolean).join(' · '));
      const vp = g.memTotal ? Math.round(100 * g.memUsed / g.memTotal) : null;
      setVal('mVram', `${g.memUsed?.toFixed(1) ?? '—'}<small>/ ${g.memTotal?.toFixed(1) ?? '—'} ГБ</small>`, level(vp, 80, 92));
      MP.setText('mVramSub', vp != null ? `занято ${vp}% · свободно ${(g.memTotal - g.memUsed).toFixed(1)} ГБ` : '');
      setVal('mTemp', `${g.temp ?? '—'}<small>°C</small>`, level(g.temp, 76, 84));
      MP.setText('mTempSub', g.fan != null ? `вентилятор ${g.fan}%` : '');
    } else {
      ['mGpu', 'mVram', 'mTemp'].forEach(id => setVal(id, '—'));
    }
    if (c.cpu != null) {
      setVal('mCpu', `${c.cpu}<small>%</small>`, level(c.cpu, 85, 95));
      MP.setText('mCpuSub', `${c.cores} ядер`);
      setVal('mRam', `${c.ramUsed.toFixed(1)}<small>/ ${c.ramTotal.toFixed(1)} ГБ</small>`, level(c.ram, 80, 92));
      MP.setText('mRamSub', `занято ${c.ram}%`);
      setVal('mNet', `<small style="margin:0 4px 0 0">↓</small>${fmtRate(c.down)}`);
      MP.setText('mNetSub', `↑ ${fmtRate(c.up)}`);
    }
    const top = $('monTop');
    top.innerHTML = '';
    if (d.top && d.top.length) {
      top.append('Больше всего грузят процессор:  ');
      d.top.forEach((p, i) => {
        const b = document.createElement('b'); b.textContent = p.name;
        top.append(i ? '  ·  ' : '', b, ` ${p.cpu}%`);
      });
    }
    canvases.forEach(spark);
  }

  function spark(cv) {
    const k = cv.dataset.k, data = series[k];
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!data.length || !W) return;
    let lo = 0, hi = 100;
    if (k === 'temp') { lo = 30; hi = 95; }
    if (k === 'down') hi = Math.max(262144, ...data.filter(v => v != null)) * 1.15;
    const color = getComputedStyle(cv.parentElement).getPropertyValue('--c').trim() || '#fff';
    const x = i => (i + N - data.length) / (N - 1) * W;
    const y = v => H - 2 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * (H - 6);
    ctx.beginPath();
    let started = false, firstX = 0, lastX = 0;
    data.forEach((v, i) => {
      if (v == null) return;
      if (!started) { ctx.moveTo(x(i), y(v)); started = true; firstX = x(i); } else ctx.lineTo(x(i), y(v));
      lastX = x(i);
    });
    if (!started) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(lastX, H); ctx.lineTo(firstX, H); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, color + '55'); g.addColorStop(1, color + '00');
    ctx.fillStyle = g; ctx.fill();
  }

  async function tick() {
    timer = 0;
    if (MP.page !== 2 || document.hidden) { haveHist = false; return; }
    try { render(await (await fetch('/api/sys' + (haveHist ? '' : '?hist=1'))).json()); } catch (e) {}
    if (MP.page === 2) timer = setTimeout(tick, 1000);
  }
  MP.on('page', p => { if (p === 2 && !timer) tick(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && MP.page === 2 && !timer) tick(); });
  window.addEventListener('resize', () => canvases.forEach(spark));
})();
