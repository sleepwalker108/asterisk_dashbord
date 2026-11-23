// Дашборд черг: HTTP + WebSocket. Дані наживо — з AMI, статистика — з MySQL.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Ami } from './ami.js';
import { LiveState } from './state.js';
import { Stats, hm } from './stats.js';
import { Store } from './store.js';
import { verifyPassword, fingerprint, LoginLimiter } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

// ---------- конфіг ----------
const configPath = process.env.CONFIG || path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const users = {};
for (const [name, u] of Object.entries(cfg.users || {})) {
  if (!['admin', 'operator'].includes(u.role)) throw new Error(`users.${name}: role має бути admin або operator`);
  if (!String(u.password).startsWith('scrypt$')) {
    log.warn(`[config] users.${name}: пароль не схожий на хеш — згенеруйте його через npm run hash-password. Вхід під цим логіном вимкнено.`);
    continue;
  }
  users[name] = { role: u.role, hash: u.password, fp: fingerprint(u.password) };
}
const lineById = new Map(cfg.lines.map((l) => [l.id, l]));
const lineByQueue = new Map(cfg.lines.map((l) => [l.queue, l]));

const store = new Store(process.env.DATA_DIR || path.join(ROOT, 'data'), log);
store.dropSessionsNotMatching(users);
const state = new LiveState(cfg, log);
const stats = new Stats(cfg, store, log);
const limiter = new LoginLimiter();

// ---------- AMI ----------
const ami = new Ami(cfg.ami, log);
async function resync() {
  if (!ami.ready) return;
  try {
    const evs = await ami.action({ Action: 'QueueStatus' }, { list: true, endEvent: 'QueueStatusComplete', timeoutMs: 20000 });
    state.applyQueueStatus(evs);
  } catch (err) {
    log.warn(`[ami] QueueStatus: ${err.message}`);
  }
}
let statsTimer = null;
function statsSoon() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => { statsTimer = null; stats.tickStats(); }, 3000);
}
ami.on('up', () => { state.reset(); state.connected = true; resync(); });
ami.on('down', () => { state.connected = false; log.warn('[ami] з\'єднання втрачено'); });
ami.on('event', (ev) => {
  state.onEvent(ev);
  if (ev.Event === 'AgentComplete' || ev.Event === 'QueueCallerAbandon' || ev.Event === 'AgentConnect' ||
      ev.Event === 'QueueMemberRemoved' || ev.Event === 'QueueMemberAdded') statsSoon();
  if (ev.Event === 'Hangup' && ev.Channel && cfg.trunkChannelPrefix && ev.Channel.startsWith(cfg.trunkChannelPrefix)) statsSoon();
});
ami.start();
setInterval(resync, 60e3);
setInterval(() => state.prune(), 60e3);

stats.tick();
stats.tickStats();
setInterval(() => stats.tick(), (cfg.alertPollSeconds || 5) * 1000);
setInterval(() => stats.tickStats(), (cfg.statsRefreshSeconds || 15) * 1000);

// ---------- знімок для браузера ----------
function buildSnapshot(role) {
  const admin = role === 'admin';
  const live = state.snapshot();
  const sd = stats.data;
  const lines = live.lines.map((l) => {
    const s = sd.lines[l.id] || {};
    const agents = s.agents || {};
    const members = l.members.map((m) => {
      const a = agents[m.iface];
      return { ...m, calls: a ? a.calls : m.callsTaken, lastCall: a && a.last ? Date.parse(String(a.last).slice(0, 19).replace(' ', 'T')) : m.lastCall };
    });
    const present = new Set(l.members.map((m) => m.iface));
    const off = Object.entries(s.removed || {})
      .filter(([iface]) => !present.has(iface))
      .map(([iface, time]) => ({ iface, ext: iface.replace(/^[A-Z]+\//i, ''), note: 'Прибрано з черги о ' + String(time).slice(11, 16) }));
    const out = {
      id: l.id, title: l.title, queue: l.queue, members, waiting: l.waiting, ivr: l.ivr, off,
      stats: {
        completed: s.completed || 0,
        abandoned: (s.abandoned || 0) + (s.timeout || 0),
        ivrDrop: s.ivrDrop || 0,
        holdAvg: s.holdN ? Math.round(s.holdSum / s.holdN) : 0,
        talkAvg: s.talkN ? Math.round(s.talkSum / s.talkN) : 0,
        toOther: s.toOther || 0,
        fromUpov: s.fromUpov || 0,
      },
    };
    if (admin) out.stats.alertCalls = s.alertCalls || 0;
    if (!admin) out.ivr = out.ivr.map((v) => ({ ...v, alert: false }));
    return out;
  });
  const snap = {
    now: Date.now(),
    role,
    ami: live.connected,
    db: stats.enabled ? stats.ok : null,
    transfer: cfg.transfer || null,
    day: sd.day, // початок поточної доби, напр. "2026-11-23 08:00:00"
    alert: { on: stats.alert.on, since: stats.alert.since },
    lines,
  };
  if (admin) {
    const periods = (sd.alertPeriods || []).map((p) => ({
      start: hm(p.start), end: p.end ? hm(p.end) : null, startMs: p.start, endMs: p.end, calls: p.calls,
    }));
    snap.alertLog = periods;
    const open = periods.find((p) => !p.endMs);
    snap.alert.nowCalls = open ? Object.values(open.calls).reduce((a, b) => a + b, 0) : 0;
  }
  return snap;
}

// ---------- HTTP ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionOf(req) {
  const token = cookies(req).qd_sid;
  const s = store.getSession(token);
  if (!s) return null;
  const u = users[s.user];
  if (!u || u.role !== s.role || u.fp !== s.fp) return null;
  return { ...s, token };
}

function clientIp(req) {
  return req.socket.remoteAddress || '?';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const IFACE_RE = /^(SIP|PJSIP|IAX2)\/[A-Za-z0-9_.-]{1,40}$/;

async function doAction(sess, body, ip) {
  const op = body.op;
  const line = lineById.get(body.line);
  if (!line) throw new Error('Невідома лінія');
  let iface = String(body.iface || '');
  if (op === 'add') {
    const ext = String(body.ext || '').trim().replace(/^sip\//i, '');
    if (!/^\d{2,6}$/.test(ext)) throw new Error('Введіть внутрішній номер, напр. 230');
    iface = 'SIP/' + ext;
  }
  if (!IFACE_RE.test(iface)) throw new Error('Невірний інтерфейс');
  let fields;
  if (op === 'pause' || op === 'unpause') {
    fields = { Action: 'QueuePause', Queue: line.queue, Interface: iface, Paused: op === 'pause' ? 'true' : 'false' };
  } else if (op === 'remove') {
    fields = { Action: 'QueueRemove', Queue: line.queue, Interface: iface };
  } else if (op === 'add') {
    fields = { Action: 'QueueAdd', Queue: line.queue, Interface: iface, Penalty: 0, Paused: 'false', MemberName: iface };
  } else {
    throw new Error('Невідома дія');
  }
  let ok = false;
  let error = null;
  try {
    await ami.action(fields);
    ok = true;
  } catch (err) {
    error = err.message;
  }
  store.audit({ user: sess.user, ip, op, queue: line.queue, iface, ok, error });
  setTimeout(resync, 500);
  statsSoon();
  if (!ok) throw new Error('Asterisk відхилив дію: ' + error);
  return { ok: true, iface };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      const body = fs.readFileSync(path.join(ROOT, 'public', file));
      return send(res, 200, body, type);
    }
    if (req.method === 'GET' && p === '/healthz') {
      return send(res, 200, { ami: state.connected, db: stats.enabled ? stats.ok : null });
    }
    if (p.startsWith('/api/')) {
      if (req.method === 'POST' && (!sameOrigin(req) || req.headers['x-qd'] !== '1')) return send(res, 403, { error: 'forbidden' });
      const ip = clientIp(req);

      if (req.method === 'POST' && p === '/api/login') {
        if (!limiter.allowed(ip)) return send(res, 429, { error: 'Забагато спроб. Зачекайте кілька хвилин.' });
        const body = await readJson(req);
        const name = String(body.user || '').trim().toLowerCase();
        const u = users[name];
        if (!u || !verifyPassword(String(body.pass || ''), u.hash)) {
          limiter.fail(ip);
          log.warn(`[auth] невдалий вхід "${name.slice(0, 40)}" з ${ip}`);
          return send(res, 401, { error: 'Невірний логін або пароль' });
        }
        limiter.reset(ip);
        const days = cfg.sessionDays || 180;
        const token = store.createSession(name, u.role, u.fp, days);
        const secure = cfg.cookieSecure ? '; Secure' : '';
        log.info(`[auth] вхід ${name} з ${ip}`);
        return send(res, 200, { user: name, role: u.role }, undefined, {
          'Set-Cookie': `qd_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${days * 86400}${secure}`,
        });
      }

      const sess = sessionOf(req);
      if (req.method === 'POST' && p === '/api/logout') {
        if (sess) store.deleteSession(sess.token);
        return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': 'qd_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (!sess) return send(res, 401, { error: 'not logged in' });
      if (req.method === 'GET' && p === '/api/me') return send(res, 200, { user: sess.user, role: sess.role });
      if (req.method === 'POST' && p === '/api/action') {
        if (sess.role !== 'admin') return send(res, 403, { error: 'Лише для адміністратора' });
        const body = await readJson(req);
        try {
          return send(res, 200, await doAction(sess, body, ip));
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }
      if (req.method === 'GET' && p === '/api/audit') {
        if (sess.role !== 'admin') return send(res, 403, { error: 'Лише для адміністратора' });
        return send(res, 200, store.recentAudit(100));
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    log.error(`[http] ${req.method} ${p}: ${err.message}`);
    send(res, 500, { error: 'server error' });
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const sess = url.pathname === '/ws' && sameOrigin(req) ? sessionOf(req) : null;
  if (!sess) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.role = sess.role;
    ws.token = sess.token;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', () => {}); // клієнт нічого не надсилає
    ws.send(JSON.stringify(buildSnapshot(ws.role)));
  });
});

setInterval(() => {
  const cache = {};
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    // сесію могли завершити (вихід, зміна пароля) — тоді відключаємо
    const s = store.getSession(ws.token);
    const u = s && users[s.user];
    if (!s || !u || u.role !== ws.role || u.fp !== s.fp) { ws.close(4001, 'session'); continue; }
    cache[ws.role] ||= JSON.stringify(buildSnapshot(ws.role));
    ws.send(cache[ws.role]);
  }
}, 1000);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30e3);

const { host = '0.0.0.0', port = 8080 } = cfg.listen || {};
server.listen(port, host, () => log.info(`[http] дашборд слухає http://${host}:${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log.info('зупинка'); ami.stop(); server.close(); process.exit(0); });
}
