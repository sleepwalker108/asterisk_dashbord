'use strict';
// Фронтенд дашборду черг. Дані приходять по WebSocket раз на секунду, сторінка перемальовується.
(() => {
  const $app = document.getElementById('app');
  const $root = document.getElementById('root');
  const $toast = document.getElementById('toast');

  const ui = {
    user: null, role: null,
    view: 'all',
    theme: load('qd-theme', null) || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    showQueues: load('qd-showQueues', true),
    showCalls: load('qd-showCalls', true),
    snap: null, offset: 0, wsOk: false,
    addExt: '', loginErr: '', busy: false,
  };

  function load(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватний режим */ } }

  // ---------- режим для телевізорів ----------
  // Адреса для ТВ: /?tv=1               — всі лінії
  //                /?tv=1&view=minre    — одна лінія (NIB, minre, upov)
  //                /?tv=1&calls=1       — показати ще й панель «Дзвінки»
  //                /?tv=1&theme=light   — світла тема
  const qs = new URLSearchParams(location.search);
  ui.tv = qs.get('tv') === '1';
  if (ui.tv) {
    ui.view = qs.get('view') || 'all';
    ui.showQueues = true;
    ui.showCalls = qs.get('calls') === '1';
    if (qs.get('theme') === 'light' || qs.get('theme') === 'dark') ui.theme = qs.get('theme');
  }
  // масштаб під розмір екрана: макет розрахований на ~1500×860, на Full HD і 4K усе пропорційно збільшується
  // Масштаб підбирається так, щоб усе вмістилося на екрані без прокрутки:
  // за шириною — як на екрані ~1500px, а якщо вміст вищий за екран — менше.
  let tvZoom = null;
  function setScale(z) {
    $app.style.transformOrigin = '0 0';
    $app.style.width = (innerWidth / z) + 'px';
    $app.style.transform = `scale(${z})`;
  }
  function fitTv() {
    if (!ui.tv) return;
    const zw = Math.min(3, innerWidth / 1500);
    if (tvZoom == null) tvZoom = zw;
    setScale(tvZoom);
    const h = $app.offsetHeight; // висота до масштабування
    const target = Math.max(0.5, Math.min(zw, (innerHeight - 4) / h));
    // дрібні зміни ігноруємо, щоб екран не «смикався» щосекунди
    if (Math.abs(target - tvZoom) / tvZoom > 0.03 || h * tvZoom > innerHeight) {
      tvZoom = target;
      setScale(tvZoom);
    }
  }
  addEventListener('resize', () => { tvZoom = null; fitTv(); });
  // на ТВ ховаємо курсор, якщо мишку не рухали 3 секунди
  let idleTimer = null;
  function wake() {
    if (!ui.tv) return;
    $root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => $root.classList.add('idle'), 3000);
  }
  addEventListener('mousemove', wake);
  function tvUrl(on) {
    if (!on) return location.pathname;
    const p = new URLSearchParams({ tv: '1' });
    if (ui.view && ui.view !== 'all' && ui.view !== 'alert') p.set('view', ui.view);
    if (ui.showCalls) p.set('calls', '1');
    return location.pathname + '?' + p.toString();
  }

  // ---------- утиліти ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const p2 = (n) => String(n).padStart(2, '0');
  const now = () => Date.now() + ui.offset;
  const fmt = (sec) => { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60; return h ? `${h}:${p2(m)}:${p2(x)}` : `${m}:${p2(x)}`; };
  const since = (ms) => fmt((now() - ms) / 1000);
  const ago = (ms) => { if (!ms) return '—'; const d = Math.floor((now() - ms) / 1000); if (d < 60) return `${Math.max(d, 0)} с тому`; if (d < 3600) return `${Math.floor(d / 60)} хв тому`; return `${Math.floor(d / 3600)} год тому`; };
  const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
  const ST = {
    free: { l: 'Вільний', c: 'var(--free)' },
    call: { l: 'Розмовляє', c: 'var(--call)' },
    ring: { l: 'Дзвонить', c: 'var(--ring)' },
    paused: { l: 'Пауза', c: 'var(--paused)' },
    unavail: { l: 'Недоступний', c: 'var(--unavail)' },
  };
  const keyOf = (m) => (m.status === 'unavail' ? 'unavail' : (m.status === 'free' && m.paused ? 'paused' : m.status));
  const waitColor = (sec) => (sec >= 45 ? 'var(--danger)' : sec >= 20 ? 'var(--ring)' : 'var(--text)');
  const tagUp = (on) => (on ? '<span class="tag-up">з Уповноваженого</span>' : '');
  const isAdmin = () => ui.role === 'admin';
  const canManage = () => isAdmin() && !ui.tv; // на ТВ кнопок керування немає

  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => $toast.classList.remove('show'), 4000);
  }

  async function api(path, body) {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'X-QD': '1' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await r.json(); } catch { /* порожньо */ }
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
    return data;
  }

  // ---------- WebSocket ----------
  let ws = null;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { ui.wsOk = true; };
    ws.onmessage = (e) => {
      try {
        const snap = JSON.parse(e.data);
        ui.offset = snap.now - Date.now();
        ui.snap = snap;
        if (snap.role !== ui.role) ui.role = snap.role;
        render();
      } catch { /* ігноруємо зіпсоване повідомлення */ }
    };
    ws.onclose = (e) => {
      ui.wsOk = false;
      ws = null;
      if (e.code === 4001) { ui.user = null; ui.role = null; render(); return; }
      if (ui.user) { render(); setTimeout(connect, 3000); }
    };
  }

  // ---------- рендер ----------
  function render() {
    const idle = $root.classList.contains('idle');
    $root.className = (ui.theme === 'light' ? 't-light' : 't-dark') + (ui.tv ? ' tv' : '') + (ui.tv && idle ? ' idle' : '');
    if (!ui.user) { if (!document.getElementById('loginName')) $app.innerHTML = loginView(); return; }
    // поки кнопка натиснута, не перемальовуємо — інакше клік «загубиться»
    if (ui.pointerDown) { ui.pendingRender = true; return; }
    // поки вибирають дату, не перемальовуємо — інакше календар закриється
    const ae = document.activeElement;
    if (ae && ae.type === 'date') {
      ui.pendingRender = true;
      if (!ae.dataset.qdBound) { ae.dataset.qdBound = '1'; ae.addEventListener('blur', () => { if (ui.pendingRender) { ui.pendingRender = false; setTimeout(render, 0); } }); }
      return;
    }
    // зберігаємо фокус у полі вводу між перемальовуваннями
    const a = document.activeElement;
    const focusId = a && a.id ? a.id : null;
    const sel = a && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
    $app.innerHTML = (ui.tv ? tvHeader() : header()) + `<main>${body()}</main>`;
    fitTv();
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* */ } }
    }
  }

  function loginView() {
    return `<div class="login-wrap"><div class="login">
      <div style="display:flex;align-items:center;gap:12px">${logo()}
        <div><h1 style="margin:0;font-size:20px;font-weight:700">Вхід у дашборд черг</h1><div class="small muted">Черги Asterisk</div></div></div>
      <div class="field"><label for="loginName">Логін</label><input id="loginName" class="inp" autocomplete="username" autofocus></div>
      <div class="field"><label for="loginPass">Пароль</label><input id="loginPass" class="inp" type="password" autocomplete="current-password"></div>
      <div id="loginErr" class="err" role="alert">${esc(ui.loginErr)}</div>
      <button class="btn btn-primary" data-act="login" style="min-height:44px;font-size:15px">Увійти</button>
    </div></div>`;
  }

  function logo() {
    return `<div class="logo"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg></div>`;
  }

  function header() {
    const s = ui.snap;
    const lines = s ? s.lines : [];
    const allWaiting = lines.reduce((a, l) => a + l.waiting.length, 0);
    const tabs = [{ id: 'all', label: 'Всі лінії', n: allWaiting }]
      .concat(lines.map((l) => ({ id: l.id, label: l.title, n: l.waiting.length })));
    if (isAdmin()) {
      const total = lines.reduce((a, l) => a + (l.stats.alertCalls || 0), 0);
      tabs.push({ id: 'alert', label: s && s.alert.on ? '⚠ Тривога' : 'Під час тривоги', n: total, red: true });
    }
    const t = new Date(now());
    let connTxt = 'Онлайн', connC = 'var(--free)';
    if (!ui.wsOk) { connTxt = 'Немає зв\'язку з сервером'; connC = 'var(--danger)'; }
    else if (s && !s.ami) { connTxt = 'Немає зв\'язку з Asterisk'; connC = 'var(--danger)'; }
    else if (s && s.db === false) { connTxt = 'Немає зв\'язку з базою'; connC = 'var(--ring)'; }
    return `<header><div class="head">
      <div class="brand">${logo()}<div><div style="font-weight:700;font-size:17px">Черги</div><div class="xs muted">asterisk-ip</div></div></div>
      <nav class="tabs" aria-label="Лінії">${tabs.map((x) => {
        const on = ui.view === x.id;
        const cnt = x.red ? (x.n > 0 ? 'cnt red' : 'cnt') : (x.n > 0 ? 'cnt hot' : 'cnt');
        return `<button class="btn tab${on ? ' on' : ''}${x.red && s && s.alert.on ? ' red' : ''}" data-act="view" data-id="${esc(x.id)}"><span>${esc(x.label)}</span><span class="${cnt} num">${x.n}</span></button>`;
      }).join('')}</nav>
      <div class="head-right">
        <div class="conn"><span class="dot" style="background:${connC}"></span><span>${connTxt}</span><span class="num" style="color:var(--text);font-weight:600;margin-left:6px">${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}</span></div>
        <div class="seg" role="group" aria-label="Тема">
          <button class="btn${ui.theme !== 'light' ? ' on' : ''}" data-act="theme" data-id="dark" aria-pressed="${ui.theme !== 'light'}">Темна</button>
          <button class="btn${ui.theme === 'light' ? ' on' : ''}" data-act="theme" data-id="light" aria-pressed="${ui.theme === 'light'}">Світла</button>
        </div>
        <button class="btn" data-act="tvOn" title="Відкрити цю сторінку у вигляді для телевізора">📺 Режим ТВ</button>
        <div class="chip-user"><div><div style="font-size:13px;font-weight:600">${esc(ui.user)}</div>
          <div class="xs" style="font-weight:600;color:${isAdmin() ? 'var(--paused)' : 'var(--muted)'}">${isAdmin() ? 'Адміністратор' : 'Оператор'}</div></div>
          <button class="btn" data-act="logout" style="background:var(--surface)">Вийти</button></div>
      </div></div></header>`;
  }

  // «з 08:00 23.11 до 08:00 24.11» — межі поточної доби, яку рахує дашборд
  function dayText() {
    const d = ui.snap && ui.snap.day;
    if (!d) return '';
    const start = new Date(d.replace(' ', 'T'));
    const end = new Date(start.getTime() + 86400e3);
    const f = (x) => `${p2(x.getHours())}:${p2(x.getMinutes())} ${p2(x.getDate())}.${p2(x.getMonth() + 1)}`;
    return `з ${f(start)} до ${f(end)}`;
  }

  // компактна шапка для ТВ: назва, стан зв'язку, великий годинник; без кнопок
  function tvHeader() {
    const s = ui.snap;
    const line = s && s.lines.find((l) => l.id === ui.view);
    const title = line ? `Лінія ${esc(line.title)}` : 'Всі лінії';
    const t = new Date(now());
    let connTxt = 'Онлайн', connC = 'var(--free)';
    if (!ui.wsOk) { connTxt = 'Немає зв\'язку з сервером'; connC = 'var(--danger)'; }
    else if (s && !s.ami) { connTxt = 'Немає зв\'язку з Asterisk'; connC = 'var(--danger)'; }
    return `<header><div class="head tv-head">
      <div class="brand">${logo()}<div class="tv-title">${title}</div></div>
      <div class="conn tv-conn"><span class="dot" style="background:${connC}"></span><span>${connTxt}</span><span style="margin-left:14px">Статистика за добу ${dayText()}</span></div>
      <div class="tv-clock num">${p2(t.getHours())}:${p2(t.getMinutes())}<span class="tv-sec">:${p2(t.getSeconds())}</span></div>
      <button class="btn tv-exit" data-act="tvOff">Вийти з режиму ТВ</button>
    </div></header>`;
  }

  function body() {
    const s = ui.snap;
    if (!s) return '<div class="empty">Завантаження…</div>';
    let out = '';
    if (!s.ami) out += '<div class="warn">Немає зв\'язку з Asterisk. Дані на екрані можуть бути застарілими, дашборд перепідключається автоматично.</div>';
    if (s.alert.on) out += alertBanner(s);
    if (ui.view === 'alert' && isAdmin()) return out + alertView(s);
    const line = s.lines.find((l) => l.id === ui.view);
    if (!line && ui.view !== 'all') ui.view = 'all';
    if (!ui.tv) out += panelToggles(s, line);
    if (ui.showCalls) out += callsPanel(s, line);
    if (ui.showQueues) out += line ? queueView(line, s) : allView(s);
    if (!ui.tv) out += `<div class="xs" style="color:var(--faint)">Дані оновлюються щосекунди. Статистика рахується за добу ${dayText()} з бази Asterisk.</div>`;
    return out;
  }

  function alertBanner(s) {
    return `<div role="alert" class="banner alarm">
      <div style="display:flex;align-items:center;gap:14px">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>
        <div><div style="font-size:22px;font-weight:800;color:var(--danger)">Повітряна тривога · лінії недоступні</div>
        <div style="font-size:14px;color:var(--text2)">Абоненти чують спеціальне повідомлення і в чергу не потрапляють</div></div></div>
      <div class="num" style="display:flex;gap:28px;text-align:right">
        <div><div class="small" style="color:var(--text2)">Триває</div><div style="font-size:30px;font-weight:800">${s.alert.since ? since(s.alert.since) : '—'}</div></div>
        ${isAdmin() ? `<div><div class="small" style="color:var(--text2)">Подзвонили за цю тривогу</div><div style="font-size:30px;font-weight:800;color:var(--danger)">${s.alert.nowCalls || 0}</div></div>` : ''}
      </div></div>`;
  }

  function panelToggles(s, line) {
    const scope = line ? [line] : s.lines;
    const nQ = scope.reduce((a, l) => a + l.waiting.length, 0);
    const nC = scope.reduce((a, l) => a + l.ivr.length + l.members.filter((m) => m.caller).length, 0);
    const b = (key, label, n) => `<button class="btn ptog${ui[key] ? ' on' : ''}" data-act="panel" data-id="${key}" aria-pressed="${ui[key]}"><span class="box">${ui[key] ? '✓' : ''}</span><span>${label}</span><span class="cnt num">${n}</span></button>`;
    return `<div class="panels" role="group" aria-label="Панелі"><span class="small muted" style="margin-right:4px">Показати:</span>${b('showQueues', 'Черги', nQ)}${b('showCalls', 'Дзвінки', nC)}</div>`;
  }

  function callsPanel(s, line) {
    const scope = line ? [line] : s.lines;
    const scopeTxt = line ? `лінія ${esc(line.title)}` : 'усі лінії';
    const ivr = [];
    const talks = [];
    for (const l of scope) {
      for (const v of l.ivr) ivr.push({ ...v, line: l.title });
      for (const m of l.members) if (m.caller && (m.status === 'call' || m.status === 'ring')) talks.push({ ...m, line: l.title });
    }
    ivr.sort((a, b) => a.since - b.since);
    talks.sort((a, b) => a.since - b.since);
    const ivrDrop = scope.reduce((a, l) => a + l.stats.ivrDrop, 0);
    return `<section class="grid2" aria-label="Дзвінки зараз">
      <div class="card" style="overflow:hidden"><div class="card-h"><div><h2>Слухають IVR</h2>
        <div class="xs muted">Подзвонили, але ще не потрапили на лінію · ${scopeTxt}</div>
        <div class="small num" style="color:var(--text2);margin-top:2px">Сьогодні кинули слухавку в IVR: <b style="color:var(--ivr)">${ivrDrop}</b></div></div>
        <span class="pill num" style="${ivr.length ? 'background:var(--ivr);color:var(--onAccent)' : ''}">${ivr.length}</span></div>
        ${ivr.length ? ivr.map((v) => `<div class="row ivr-row">
          <span class="num" style="font-size:16px;font-weight:700">${esc(v.num || 'номер приховано')}</span>
          <span class="small" style="color:var(--text2)">Лінія <b>${esc(v.line)}</b>${tagUp(v.fromUpov)}</span>
          <span class="badge" style="padding:0;color:${v.alert ? 'var(--danger)' : 'var(--ivr)'}"><span class="dot" style="width:7px;height:7px;background:${v.alert ? 'var(--danger)' : 'var(--ivr)'}"></span>${v.alert ? 'Повідомлення про тривогу' : 'Слухає привітання'}</span>
          <span class="num" style="font-size:15px;font-weight:600;text-align:right">${since(v.since)}</span></div>`).join('') : '<div class="empty">Зараз ніхто не слухає IVR</div>'}
      </div>
      <div class="card" style="overflow:hidden"><div class="card-h"><div><h2>Розмови</h2><div class="xs muted">Хто з ким зараз на зв'язку · ${scopeTxt}</div></div>
        <span class="pill num">${talks.length}</span></div>
        ${talks.length ? talks.map((m) => {
          const st = ST[m.status];
          return `<div class="row talk-row">
          <span class="num" style="font-size:16px;font-weight:700">${esc(m.caller)}</span><span aria-hidden="true" class="muted">→</span>
          <span style="font-weight:700">${esc(m.ext)}</span>
          <span class="small" style="color:var(--text2)">${esc(m.line)}${tagUp(m.fromUpov)}</span>
          <span class="badge" style="padding:0;color:${st.c}"><span class="dot" style="width:7px;height:7px;background:${st.c}"></span>${m.status === 'ring' ? 'Дзвонить' : 'Розмова'}</span>
          <span class="num" style="font-size:15px;font-weight:600;text-align:right">${since(m.since)}</span></div>`;
        }).join('') : '<div class="empty">Активних розмов немає</div>'}
      </div></section>`;
  }

  function counts(l) {
    const free = l.members.filter((m) => m.status === 'free' && !m.paused).length;
    const onCall = l.members.filter((m) => m.status === 'call' || m.status === 'ring').length;
    const paused = l.members.filter((m) => m.paused).length;
    const unavail = l.members.filter((m) => m.status === 'unavail').length;
    const longest = l.waiting.length ? Math.max(...l.waiting.map((w) => (now() - w.since) / 1000)) : 0;
    return { free, onCall, paused, unavail, longest };
  }

  function allView(s) {
    const cs = s.lines.map(counts);
    const sum = (f) => s.lines.reduce((a, l, i) => a + f(l, cs[i]), 0);
    const tile = (label, v, c) => `<div class="tile"><div class="small muted">${label}</div><div class="v num" style="color:${c}">${v}</div></div>`;
    const ivrN = sum((l) => l.ivr.length), waitN = sum((l) => l.waiting.length), ab = sum((l) => l.stats.abandoned), dr = sum((l) => l.stats.ivrDrop);
    let out = `<section class="tiles" aria-label="Підсумок по всіх лініях">
      ${tile('Слухають IVR', ivrN, ivrN ? 'var(--ivr)' : 'var(--text)')}
      ${tile('В очікуванні', waitN, waitN ? 'var(--ring)' : 'var(--text)')}
      ${tile('Розмовляють', sum((l, c) => c.onCall), 'var(--call)')}
      ${tile('Вільні', sum((l, c) => c.free), 'var(--free)')}
      ${tile('На паузі', sum((l, c) => c.paused), 'var(--paused)')}
      ${tile('Прийнято за добу', sum((l) => l.stats.completed), 'var(--text)')}
      ${tile('Втрачено в черзі', ab, ab ? 'var(--danger)' : 'var(--text)')}
      ${tile('Кинули в IVR', dr, dr ? 'var(--ivr)' : 'var(--text)')}
    </section><section class="cards" aria-label="Лінії"${ui.tv ? ` style="grid-template-columns:repeat(${s.lines.length},minmax(0,1fr))"` : ''}>`;
    out += s.lines.map((l, i) => lineCard(l, cs[i], s)).join('');
    return out + '</section>';
  }

  function transferInfo(l, s) {
    const tr = s.transfer;
    if (!tr) return '';
    let txt = null;
    if (l.id === tr.fromLine) txt = `<b>Переведено на ${esc((s.lines.find((x) => x.id === tr.toLine) || {}).title || '')}: ${l.stats.toOther}</b> · коли тут усі зайняті, а там є вільні`;
    if (l.id === tr.toLine) txt = `<b>З Уповноваженого: ${l.stats.fromUpov}</b> · дзвінки, переведені сюди`;
    if (!txt) return '';
    return `<div class="info"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--call)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg><span class="num">${txt}</span></div>`;
  }

  function lineCard(l, c, s) {
    const hot = l.waiting.length > 0;
    const numC = hot ? waitColor(Math.max(20, c.longest)) : 'var(--text)';
    return `<article class="line">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div><h2>${esc(l.title)}</h2><div class="small muted">Черга ${esc(l.queue)} · ${l.members.length} операторів</div></div>
        ${ui.tv ? '' : `<button class="btn" data-act="view" data-id="${esc(l.id)}" style="border-radius:10px;padding:8px 14px;min-height:40px">Відкрити</button>`}</div>
      <div class="waitbox${hot ? ' hot' : ''}">
        <div><div style="font-size:14px;color:var(--text2)">В очікуванні</div><div class="waitnum num" style="color:${numC}">${l.waiting.length}</div></div>
        <div style="text-align:right"><div style="font-size:14px;color:var(--text2)">Найдовше</div><div class="num" style="font-size:30px;font-weight:700">${hot ? fmt(c.longest) : '—'}</div></div></div>
      ${l.ivr.length ? `<div class="info" style="font-weight:600;color:var(--ivr)"><span class="dot" style="background:var(--ivr)"></span><span class="num">Ще слухають IVR: ${l.ivr.length}</span></div>` : ''}
      ${transferInfo(l, s)}
      <div class="three">
        <div class="mini"><div class="xs muted">Вільні</div><div class="v num" style="color:var(--free)">${c.free}</div></div>
        <div class="mini"><div class="xs muted">Розмовляють</div><div class="v num" style="color:var(--call)">${c.onCall}</div></div>
        <div class="mini"><div class="xs muted">На паузі</div><div class="v num" style="color:var(--paused)">${c.paused}</div></div></div>
      ${c.unavail ? `<div class="info"><span class="dot" style="background:var(--unavail)"></span><span class="num"><b>Недоступні: ${c.unavail}</b> · телефон не на зв'язку, дзвінки на них не йдуть</span></div>` : ''}
      <div class="chips">${l.members.map((m) => {
        const k = keyOf(m), st = ST[k];
        return `<div class="chip" style="background:${tint(st.c, 9)};border:1px solid ${tint(st.c, 28)}">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px"><span style="font-weight:700;font-size:16px">${esc(m.ext)}</span><span class="num xs muted">${m.calls} дзв.</span></div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:4px"><span class="small" style="font-weight:600;color:${st.c}">${st.l}</span><span class="num small" style="color:var(--text2)">${since(k === 'paused' ? m.pausedSince : m.since)}</span></div></div>`;
      }).join('') || '<div class="small muted">Операторів у черзі немає</div>'}</div>
      <div class="foot4">
        <div><div class="l">Прийнято</div><div class="v num">${l.stats.completed}</div></div>
        <div><div class="l">Втрачено в черзі</div><div class="v num" style="color:${l.stats.abandoned ? 'var(--danger)' : 'var(--text)'}">${l.stats.abandoned}</div></div>
        <div><div class="l">Кинули в IVR</div><div class="v num" style="color:${l.stats.ivrDrop ? 'var(--ivr)' : 'var(--text)'}">${l.stats.ivrDrop}</div></div>
        <div><div class="l">Сер. очікування</div><div class="v num">${fmt(l.stats.holdAvg)}</div></div></div>
    </article>`;
  }

  function queueView(l, s) {
    const c = counts(l);
    const admin = canManage();
    const k = (label, v, col) => `<div class="tile"><div class="small muted">${label}</div><div class="v num" style="color:${col}">${v}</div></div>`;
    const tr = s.transfer;
    const kpis = [
      k('В очікуванні', l.waiting.length, l.waiting.length ? 'var(--ring)' : 'var(--text)'),
      k('Найдовше очікування', l.waiting.length ? fmt(c.longest) : '—', waitColor(c.longest)),
      k('Вільні оператори', c.free, 'var(--free)'),
      k('Розмовляють', c.onCall, 'var(--call)'),
      k('Прийнято за добу', l.stats.completed, 'var(--text)'),
      k('Втрачено в черзі', l.stats.abandoned, l.stats.abandoned ? 'var(--danger)' : 'var(--text)'),
      k('Кинули в IVR', l.stats.ivrDrop, l.stats.ivrDrop ? 'var(--ivr)' : 'var(--text)'),
    ];
    if (tr && l.id === tr.fromLine) kpis.push(k('Переведено на 1548', l.stats.toOther, 'var(--call)'));
    if (tr && l.id === tr.toLine) kpis.push(k('З Уповноваженого', l.stats.fromUpov, 'var(--call)'));
    kpis.push(k('Сер. очікування', fmt(l.stats.holdAvg), 'var(--text)'), k('Сер. розмова', fmt(l.stats.talkAvg), 'var(--text)'));
    const cols = admin ? '1.1fr 1.4fr 1fr .8fr 1.1fr 1.7fr' : '1.1fr 1.4fr 1fr .8fr 1.1fr';
    const rows = l.members.map((m) => {
      const key = keyOf(m), st = ST[key];
      return `<div class="gr" style="grid-template-columns:${cols}">
        <div><div style="font-weight:700;font-size:16px">${esc(m.ext)}</div>${m.caller ? `<div class="num xs muted">${esc(m.caller)}${m.fromUpov ? ' · <span style="color:var(--call);font-weight:700">з Уповноваженого</span>' : ''}</div>` : ''}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="badge" style="color:${st.c};background:${tint(st.c, 12)};border:1px solid ${tint(st.c, 35)}"><span class="dot" style="width:7px;height:7px;background:${st.c}"></span>${st.l}</span>
          ${m.paused && m.status !== 'free' && m.status !== 'unavail' ? '<span class="xs" style="color:var(--paused);border:1px solid color-mix(in srgb,var(--paused) 35%,transparent);border-radius:999px;padding:2px 8px">пауза</span>' : ''}</div>
        <span class="num">${since(key === 'paused' ? m.pausedSince : m.since)}</span>
        <span class="num" style="font-weight:600">${m.calls}</span>
        <span class="num small" style="color:var(--text2)">${ago(m.lastCall)}</span>
        ${admin ? `<div class="acts">
          <button class="btn${m.paused ? ' btn-paused' : ''}" data-act="${m.paused ? 'unpause' : 'pause'}" data-line="${esc(l.id)}" data-iface="${esc(m.iface)}" ${ui.busy ? 'disabled' : ''}>${m.paused ? 'Зняти паузу' : 'Пауза'}</button>
          <button class="btn btn-danger" data-act="remove" data-line="${esc(l.id)}" data-iface="${esc(m.iface)}" ${ui.busy ? 'disabled' : ''}>Видалити</button></div>` : ''}
      </div>`;
    }).join('');
    return `<div class="qhead"><div><h1>${esc(l.title)}</h1><div class="muted" style="font-size:14px">Черга ${esc(l.queue)}</div></div>
      ${admin ? '<div class="admin-note">Режим адміністратора: доступні пауза, видалення і додавання операторів</div>' : ''}</div>
      <section class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))" aria-label="Показники">${kpis.join('')}</section>
      <div class="split">
        <section class="card ops" aria-label="Оператори"><div class="card-h"><h2>Оператори</h2><span class="num small muted">${l.members.length} у черзі</span></div>
          <div style="overflow-x:auto"><div style="min-width:720px">
            <div class="gh" style="grid-template-columns:${cols}"><span>Оператор</span><span>Статус</span><span>Час у статусі</span><span>Дзвінків</span><span>Останній дзвінок</span>${admin ? '<span style="text-align:right">Дії</span>' : ''}</div>
            ${rows || '<div class="empty">Операторів у черзі немає</div>'}
          </div></div></section>
        <div class="side">
          <section class="card" style="overflow:hidden" aria-label="Абоненти в очікуванні"><div class="card-h"><h2>Чекають на відповідь</h2>
            <span class="pill num" style="${l.waiting.length ? 'background:var(--ring);color:var(--onRing)' : ''}">${l.waiting.length}</span></div>
            ${l.waiting.length ? l.waiting.map((w, i) => `<div class="row" style="display:flex;align-items:center;gap:14px"><span class="pos num">${i + 1}</span>
              <span class="num" style="flex:1 1 auto">${esc(w.num || 'номер приховано')}${tagUp(w.fromUpov)}</span>
              <span class="num" style="font-weight:700;color:${waitColor((now() - w.since) / 1000)}">${since(w.since)}</span></div>`).join('') : '<div class="empty">Черга порожня</div>'}
          </section>
          ${ui.tv ? '' : `<section class="card" style="overflow:hidden" aria-label="Не в черзі"><div class="card-h"><h2>Не в черзі</h2></div>
            ${l.off.length ? l.off.map((o) => `<div class="row" style="display:flex;align-items:center;gap:12px"><span style="font-weight:700" class="muted">${esc(o.ext)}</span>
              <span class="small muted" style="flex:1 1 auto">${esc(o.note)}</span>
              ${admin ? `<button class="btn" data-act="add" data-line="${esc(l.id)}" data-ext="${esc(o.ext)}" ${ui.busy ? 'disabled' : ''}>Повернути</button>` : ''}</div>`).join('') : '<div class="empty">Сьогодні з черги нікого не прибирали</div>'}
            ${admin ? `<div style="padding:16px 20px;display:flex;flex-direction:column;gap:8px"><label for="addExt" class="small muted">Додати оператора в чергу</label>
              <div style="display:flex;gap:8px"><input id="addExt" class="inp" inputmode="numeric" placeholder="Номер, напр. 230" value="${esc(ui.addExt)}" style="flex:1 1 auto;min-width:0">
              <button class="btn btn-primary" data-act="addNew" data-line="${esc(l.id)}" ${ui.busy ? 'disabled' : ''}>Додати</button></div></div>` : ''}
          </section>`}
        </div></div>`;
  }

  function alertView(s) {
    const log = s.alertLog || [];
    const open = log.find((p) => !p.endMs);
    const total = s.lines.reduce((a, l) => a + (l.stats.alertCalls || 0), 0);
    const tiles = s.lines.map((l) => {
      const n = l.stats.alertCalls || 0;
      return `<div class="atile"><div style="font-size:15px;font-weight:700;color:var(--text2)">Лінія ${esc(l.title)}</div>
        <div class="num" style="font-size:46px;font-weight:800;line-height:1.1;color:${n ? 'var(--danger)' : 'var(--text)'}">${n}</div>
        <div class="num small muted">${open ? 'за поточну тривогу: ' + (open.calls[l.id] || 0) : 'дзвінків за добу · ' + dayText()}</div></div>`;
    }).join('') + `<div class="atile big"><div style="font-size:15px;font-weight:700;color:var(--text2)">Усього по всіх лініях</div>
      <div class="num" style="font-size:56px;font-weight:800;line-height:1.1;color:${total ? 'var(--danger)' : 'var(--text)'}">${total}</div>
      <div class="num small muted">${open ? 'за поточну тривогу: ' + (s.alert.nowCalls || 0) : 'дзвінків за добу · ' + dayText()}</div></div>`;
    const ids = s.lines.map((l) => l.id);
    const head = `<div class="agrid gh" style="padding:10px 20px"><span>Початок</span><span>Кінець</span><span>Тривалість</span>${s.lines.map((l) => `<span>${esc(l.title)}</span>`).join('')}<span>Усього</span></div>`;
    const rows = log.slice().reverse().map((p) => {
      const live = !p.endMs;
      const cnt = ids.map((id) => p.calls[id] || 0);
      return `<div class="agrid num" style="${live ? 'background:' + tint('var(--danger)', 8) : ''}"><span style="font-weight:600">${esc(p.start)}</span>
        <span style="${live ? 'font-weight:700;color:var(--danger)' : ''}">${live ? 'триває' : esc(p.end)}</span>
        <span>${fmt(((live ? now() : p.endMs) - p.startMs) / 1000)}</span>${cnt.map((n) => `<span>${n}</span>`).join('')}
        <span style="font-weight:800;color:var(--danger)">${cnt.reduce((a, b) => a + b, 0)}</span></div>`;
    }).join('');
    const stateTxt = s.alert.on ? `Тривога триває ${since(s.alert.since)}` : 'Зараз тривоги немає · лінії працюють';
    const sc = s.alert.on ? 'var(--danger)' : 'var(--free)';
    return `<div class="qhead"><div><h1>Дзвінки під час тривоги</h1>
        <div class="muted" style="font-size:14px">Абоненти, які подзвонили, коли лінії були недоступні через повітряну тривогу, і не додзвонились · доба ${dayText()}</div></div>
        <div style="font-size:14px;font-weight:700;border-radius:10px;padding:8px 14px;color:${sc};background:${tint(sc, 12)};border:1px solid ${tint(sc, 40)}">${stateTxt}</div></div>
      <section class="atiles" aria-label="Дзвінки під час тривоги по лініях">${tiles}</section>
      <section class="card" style="overflow:hidden" aria-label="Тривоги за добу"><div class="card-h"><h2>Тривоги за добу</h2><span class="small muted num">Тривог: ${log.length}</span></div>
        <div style="overflow-x:auto"><div style="min-width:720px">${head}${rows || '<div class="empty">За цю добу тривог не було</div>'}</div></div></section>
      ${historyBlock(s)}`;
  }

  // ---------- історія тривожних дзвінків по днях ----------
  const isoDay = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  function shiftToday() { // поточна «доба» з урахуванням 08:00
    const d = ui.snap && ui.snap.day ? new Date(ui.snap.day.replace(' ', 'T')) : new Date(now());
    return d;
  }
  function histRange(kind) {
    const to = shiftToday();
    const from = new Date(to);
    if (kind === '7') from.setDate(from.getDate() - 6);
    else if (kind === '30') from.setDate(from.getDate() - 29);
    else if (kind === 'month') from.setDate(1);
    return [isoDay(from), isoDay(to)];
  }
  async function loadHistory() {
    if (!ui.histFrom) [ui.histFrom, ui.histTo] = histRange('7');
    ui.histBusy = true; ui.histErr = ''; render();
    try {
      ui.hist = await api(`/api/alerts/history?from=${ui.histFrom}&to=${ui.histTo}`);
    } catch (err) {
      ui.histErr = err.message; ui.hist = null;
    } finally {
      ui.histBusy = false; render();
    }
  }
  async function downloadXlsx(href) {
    ui.xlsxBusy = true; render();
    try {
      const r = await fetch(href, { credentials: 'same-origin' });
      if (!r.ok) { let m = `HTTP ${r.status}`; try { m = (await r.json()).error || m; } catch { /* */ } throw new Error(m); }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `Тривоги_${ui.histFrom}_${ui.histTo}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (err) {
      toast('Не вдалося сформувати файл: ' + err.message);
    } finally {
      ui.xlsxBusy = false; render();
    }
  }

  function historyBlock(s) {
    if (!ui.hist && !ui.histBusy && !ui.histErr) { setTimeout(loadHistory, 0); ui.histBusy = true; }
    const h = ui.hist;
    const dmy = (x) => `${x.slice(8, 10)}.${x.slice(5, 7)}.${x.slice(0, 4)}`;
    const quick = (k, label) => `<button class="btn" data-act="histQuick" data-id="${k}">${label}</button>`;
    let table = '';
    if (ui.histErr) table = `<div class="empty" style="color:var(--danger)">${esc(ui.histErr)}</div>`;
    else if (!h) table = '<div class="empty">Завантаження…</div>';
    else {
      const ids = h.lines.map((l) => l.id);
      const cols = `1.2fr ${ids.map(() => '1fr').join(' ')} 1fr`;
      const sum = Object.fromEntries(ids.map((id) => [id, 0]));
      const days = h.days.slice().reverse();
      for (const d of days) for (const id of ids) sum[id] += d.calls[id];
      const total = ids.reduce((a, id) => a + sum[id], 0);
      table = `<div class="gh" style="grid-template-columns:${cols}"><span>Дата (доба з ${p2(h.dayHour)}:00)</span>${h.lines.map((l) => `<span>${esc(l.title)}</span>`).join('')}<span>Усього</span></div>
        <div class="gr num" style="grid-template-columns:${cols};font-weight:800;background:var(--head)"><span>Разом за період</span>${ids.map((id) => `<span>${sum[id]}</span>`).join('')}<span style="color:${total ? 'var(--danger)' : 'var(--text)'}">${total}</span></div>
        ${days.map((d) => `<div class="gr num" style="grid-template-columns:${cols}"><span style="font-weight:600">${dmy(d.day)}</span>${ids.map((id) => `<span class="${d.calls[id] ? '' : 'muted'}">${d.calls[id]}</span>`).join('')}<span style="font-weight:800;color:${d.total ? 'var(--danger)' : 'var(--muted)'}">${d.total}</span></div>`).join('')}`;
    }
    const xlsxHref = `/api/alerts/export.xlsx?from=${esc(ui.histFrom || '')}&to=${esc(ui.histTo || '')}`;
    return `<section class="card" style="overflow:hidden" aria-label="Історія по днях">
      <div class="card-h" style="flex-wrap:wrap"><div><h2>Історія по днях</h2>
        <div class="xs muted">Дзвінки під час тривоги за кожну добу. Нічого не обнуляється, дані беруться з історії дзвінків Asterisk.</div></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          ${quick('7', '7 днів')}${quick('30', '30 днів')}${quick('month', 'Цей місяць')}
          <label class="small muted" for="histFrom">з</label><input id="histFrom" class="inp" type="date" value="${esc(ui.histFrom || '')}" style="min-height:36px;padding:4px 8px">
          <label class="small muted" for="histTo">по</label><input id="histTo" class="inp" type="date" value="${esc(ui.histTo || '')}" style="min-height:36px;padding:4px 8px">
          <button class="btn" data-act="histLoad" ${ui.histBusy ? 'disabled' : ''}>Показати</button>
          <button class="btn btn-primary" data-act="histXlsx" data-href="${xlsxHref}" ${ui.xlsxBusy ? 'disabled' : ''}>⬇ Завантажити в Excel</button>
        </div></div>
      <div style="overflow-x:auto"><div style="min-width:640px">${table}</div></div></section>`;
  }

  // ---------- дії ----------
  async function doLogin() {
    const user = document.getElementById('loginName').value.trim();
    const pass = document.getElementById('loginPass').value;
    const $err = document.getElementById('loginErr');
    if (!user || !pass) { $err.textContent = 'Введіть логін і пароль'; return; }
    try {
      const me = await api('/api/login', { user, pass });
      ui.user = me.user; ui.role = me.role; ui.loginErr = '';
      if (!ui.tv) ui.view = 'all';
      $app.innerHTML = '';
      connect();
      render();
    } catch (err) {
      $err.textContent = err.message;
    }
  }

  async function adminAction(body, okMsg) {
    ui.busy = true; render();
    try {
      await api('/api/action', body);
      toast(okMsg);
      if (body.op === 'add') ui.addExt = '';
    } catch (err) {
      toast(err.message);
    } finally {
      ui.busy = false; render();
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const d = b.dataset;
    switch (d.act) {
      case 'login': doLogin(); break;
      case 'logout':
        api('/api/logout', {}).catch(() => {}).finally(() => { ui.user = null; ui.role = null; ui.snap = null; if (ws) ws.close(); $app.innerHTML = ''; render(); });
        break;
      case 'view': ui.view = d.id; render(); break;
      case 'histXlsx': downloadXlsx(d.href); break;
      case 'histQuick': [ui.histFrom, ui.histTo] = histRange(d.id); loadHistory(); break;
      case 'histLoad': {
        const f = document.getElementById('histFrom').value, t = document.getElementById('histTo').value;
        if (!f || !t || f > t) { toast('Вкажіть дати: «з» не пізніше за «по»'); break; }
        ui.histFrom = f; ui.histTo = t; loadHistory(); break;
      }
      case 'tvOn': location.href = tvUrl(true); break;
      case 'tvOff': location.href = tvUrl(false); break;
      case 'theme': ui.theme = d.id; save('qd-theme', d.id); render(); break;
      case 'panel': {
        const other = d.id === 'showQueues' ? 'showCalls' : 'showQueues';
        if (ui[d.id] && !ui[other]) { toast('Має бути ввімкнена хоча б одна панель'); break; }
        ui[d.id] = !ui[d.id]; save('qd-' + d.id, ui[d.id]); render(); break;
      }
      case 'pause': adminAction({ op: 'pause', line: d.line, iface: d.iface }, `${d.iface} поставлено на паузу`); break;
      case 'unpause': adminAction({ op: 'unpause', line: d.line, iface: d.iface }, `${d.iface}: пауза знята`); break;
      case 'remove':
        if (confirm(`Видалити ${d.iface} з черги?`)) adminAction({ op: 'remove', line: d.line, iface: d.iface }, `${d.iface} видалено з черги`);
        break;
      case 'add': adminAction({ op: 'add', line: d.line, ext: d.ext }, `SIP/${d.ext} повернуто в чергу`); break;
      case 'addNew': adminAction({ op: 'add', line: d.line, ext: ui.addExt }, `SIP/${ui.addExt.trim()} додано в чергу`); break;
      default: break;
    }
  });

  document.addEventListener('pointerdown', () => { ui.pointerDown = true; });
  const release = () => {
    ui.pointerDown = false;
    if (ui.pendingRender) { ui.pendingRender = false; setTimeout(render, 0); }
  };
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);

  document.addEventListener('input', (e) => {
    if (e.target.id === 'addExt') ui.addExt = e.target.value;
    if (e.target.id === 'histFrom' && e.target.value) ui.histFrom = e.target.value;
    if (e.target.id === 'histTo' && e.target.value) ui.histTo = e.target.value;
  });
  document.addEventListener('keydown', (e) => {
    if (ui.tv && e.key === 'Escape') { location.href = tvUrl(false); return; }
    if (e.key !== 'Enter') return;
    if (e.target.id === 'loginName' || e.target.id === 'loginPass') { e.preventDefault(); doLogin(); }
    if (e.target.id === 'addExt') { e.preventDefault(); const b = document.querySelector('[data-act="addNew"]'); if (b) b.click(); }
  });

  // ---------- старт ----------
  wake();
  api('/api/me').then((me) => { ui.user = me.user; ui.role = me.role; connect(); render(); })
    .catch(() => { ui.user = null; render(); });
})();
