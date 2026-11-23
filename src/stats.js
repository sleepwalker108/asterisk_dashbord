// Статистика «за сьогодні» з MySQL (queue_log, cdr) і стан тривоги (monitoring.alerts).
// Усе рахується з бази, тож перезапуск дашборду цифр не обнуляє.
import mysql from 'mysql2/promise';

const p2 = (n) => String(n).padStart(2, '0');
// Початок «доби» дашборду. hour = 8 → доба триває з 08:00 до 08:00 наступного дня:
// о 07:59 це ще вчорашня доба, о 08:00 цифри обнуляються.
export function dayStart(hour = 0, now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < hour) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(hour)}:00:00`;
}
export function hm(ms) {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// Імена таблиць беремо з конфігу; дозволяємо лише безпечні символи
function ident(name) {
  if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/.test(name)) throw new Error(`Bad table name: ${name}`);
  return name.split('.').map((p) => '`' + p + '`').join('.');
}

export class Stats {
  constructor(config, store, log = console) {
    this.cfg = config;
    this.store = store;
    this.log = log;
    this.lines = config.lines;
    // година початку доби; за замовчуванням 8 (доба 08:00–08:00)
    const h = Number(config.dayStartHour);
    this.dayHour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : 8;
    this.ok = false;
    this.lastError = null;
    this.data = this._empty();
    this.alert = { on: false, since: null };
    const db = config.db || {};
    this.enabled = db.enabled !== false;
    if (this.enabled) {
      this.pool = mysql.createPool({
        host: db.host, port: db.port || 3306, user: db.user, password: db.password,
        connectionLimit: 3, waitForConnections: true, connectTimeout: 10000,
        dateStrings: true,
      });
      this.tQueueLog = ident(db.queueLogTable || 'queue_log.queue_log');
      this.tCdr = ident(db.cdrTable || 'cdr.cdr');
      this.tAlerts = ident(db.alertsTable || 'monitoring.alerts');
    }
  }

  _empty() {
    const per = {};
    for (const l of this.lines) {
      per[l.id] = { completed: 0, abandoned: 0, timeout: 0, holdSum: 0, holdN: 0, talkSum: 0, talkN: 0,
        ivrDrop: 0, alertCalls: 0, toOther: 0, fromUpov: 0, agents: {}, removed: {} };
    }
    return { lines: per, day: dayStart(this.dayHour), updated: null };
  }

  // ---------- тривога ----------
  async pollAlert() {
    if (!this.enabled) return this.alert;
    const db = this.cfg.db;
    const [rows] = await this.pool.query(`SELECT status FROM ${this.tAlerts} WHERE name = ? LIMIT 1`, [db.alertsRowName || 'ivr']);
    const on = !!rows.length && String(rows[0].status) === String(db.alertOnStatus || 'A');
    const t = Date.now();
    const open = this.store.openAlert(); // незакрита тривога з журналу (переживає перезапуск)
    if (on) {
      if (!open) { this.store.alertStarted(t); this.log.info('[alert] тривога ввімкнена'); } else this.store.alertSeen(t);
      this.alert = { on: true, since: open ? open.start : t };
    } else {
      if (open) { this.store.alertEnded(t); this.log.info('[alert] тривогу знято'); }
      this.alert = { on: false, since: null };
    }
    return this.alert;
  }

  // ---------- статистика за сьогодні ----------
  async refresh() {
    if (!this.enabled) return this.data;
    const from = dayStart(this.dayHour);
    const out = this._empty();
    out.day = from;
    const byQueue = new Map(this.lines.map((l) => [l.queue, l.id]));
    const byCtx = new Map(this.lines.map((l) => [l.context, l.id]));

    // queue_log: time — varchar з індексом, тому порівнюємо рядком без функцій
    const [ql] = await this.pool.query(
      `SELECT queuename, agent, event, COUNT(*) AS c,
              SUM(CAST(data1 AS UNSIGNED)) AS s1, SUM(CAST(data2 AS UNSIGNED)) AS s2, MAX(time) AS last
         FROM ${this.tQueueLog}
        WHERE time >= ? AND event IN ('CONNECT','ABANDON','EXITWITHTIMEOUT','COMPLETEAGENT','COMPLETECALLER')
        GROUP BY queuename, agent, event`, [from]);
    for (const r of ql) {
      const id = byQueue.get(r.queuename);
      if (!id) continue;
      const s = out.lines[id];
      const c = Number(r.c) || 0;
      if (r.event === 'CONNECT') {
        s.completed += c; s.holdSum += Number(r.s1) || 0; s.holdN += c;
        if (r.agent && r.agent !== 'NONE') {
          const a = (s.agents[r.agent] ||= { calls: 0, last: null });
          a.calls += c; a.last = r.last;
        }
      } else if (r.event === 'ABANDON') s.abandoned += c;
      else if (r.event === 'EXITWITHTIMEOUT') s.timeout += c;
      else { s.talkSum += Number(r.s2) || 0; s.talkN += c; }
    }

    // хто прибраний з черги сьогодні (для блоку «Не в черзі»)
    const [mem] = await this.pool.query(
      `SELECT queuename, agent, event, time FROM ${this.tQueueLog}
        WHERE time >= ? AND event IN ('ADDMEMBER','REMOVEMEMBER') ORDER BY time`, [from]);
    for (const r of mem) {
      const id = byQueue.get(r.queuename);
      if (!id || !r.agent) continue;
      if (r.event === 'REMOVEMEMBER') out.lines[id].removed[r.agent] = r.time;
      else delete out.lines[id].removed[r.agent];
    }

    // cdr: «ноги» абонента з транку, що дійшли до контексту однієї з ліній
    const prefix = (this.cfg.trunkChannelPrefix || '') + '%';
    const ctxs = [...byCtx.keys()];
    const [cdr] = await this.pool.query(
      `SELECT calldate, dcontext, lastapp, lastdata, clid
         FROM ${this.tCdr}
        WHERE calldate >= ? AND channel LIKE ? AND dcontext IN (?)`, [from, prefix, ctxs]);
    const periods = this.store.alertsSince(Date.parse(from.replace(' ', 'T')));
    const inAlert = (ms) => periods.some((p) => ms >= p.start && ms <= (p.end || Date.now()));
    const tr = this.cfg.transfer;
    for (const r of cdr) {
      const id = byCtx.get(r.dcontext);
      if (!id) continue;
      const s = out.lines[id];
      const data = String(r.lastdata || '');
      const app = String(r.lastapp || '');
      const ms = Date.parse(String(r.calldate).replace(' ', 'T'));
      const isAlarm = /alarm/i.test(data) || (inAlert(ms) && app !== 'Queue' && !/no_answer/i.test(data));
      if (isAlarm) {
        s.alertCalls += 1;
        const p = periods.find((x) => ms >= x.start && ms <= (x.end || Date.now()));
        if (p) p.calls[id] = (p.calls[id] || 0) + 1;
      } else if (app !== 'Queue' && !/no_answer/i.test(data)) {
        s.ivrDrop += 1;
      }
      if (tr && id === tr.toLine && String(r.clid || '').startsWith(`"${tr.callerIdName}"`)) {
        s.fromUpov += 1;
        if (out.lines[tr.fromLine]) out.lines[tr.fromLine].toOther += 1;
      }
    }
    out.alertPeriods = periods;
    out.updated = Date.now();
    this.data = out;
    return out;
  }

  async tick() {
    try {
      await this.pollAlert();
      this.ok = true;
      this.lastError = null;
    } catch (err) {
      this.ok = false;
      this.lastError = err.message;
      this.log.warn(`[db] тривога: ${err.message}`);
    }
  }

  async tickStats() {
    try {
      await this.refresh();
      this.ok = true;
      this.lastError = null;
    } catch (err) {
      this.ok = false;
      this.lastError = err.message;
      this.log.warn(`[db] статистика: ${err.message}`);
    }
  }

  // ---------- історія тривожних дзвінків по днях ----------
  // fromDay/toDay — 'YYYY-MM-DD' (включно). «День» = доба з dayHour до dayHour наступного дня.
  // Тривожний дзвінок = «нога» абонента в контексті лінії, де грав *alarm*-запис,
  // або (для тривог, які записав дашборд) будь-який дзвінок, що не дійшов до черги під час тривоги.
  async alertHistory(fromDay, toDay) {
    const h = this.dayHour;
    const start = new Date(`${fromDay}T${p2(h)}:00:00`);
    const end = new Date(`${toDay}T${p2(h)}:00:00`);
    end.setDate(end.getDate() + 1);
    const ids = this.lines.map((l) => l.id);
    const byCtx = new Map(this.lines.map((l) => [l.context, l.id]));
    const ctxs = [...byCtx.keys()];
    const prefix = (this.cfg.trunkChannelPrefix || '') + '%';
    const zero = () => Object.fromEntries(ids.map((id) => [id, 0]));

    // заготовка: усі дні діапазону з нулями
    const days = new Map();
    for (const d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      days.set(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, zero());
    }

    const [rows] = await this.pool.query(
      `SELECT DATE(calldate - INTERVAL ${h} HOUR) AS d, dcontext, COUNT(*) AS c
         FROM ${this.tCdr}
        WHERE calldate >= ? AND calldate < ? AND channel LIKE ? AND dcontext IN (?) AND lastdata LIKE '%alarm%'
        GROUP BY d, dcontext`, [sqlTime(start), sqlTime(end), prefix, ctxs]);
    for (const r of rows) {
      const day = days.get(String(r.d).slice(0, 10));
      const id = byCtx.get(r.dcontext);
      if (day && id) day[id] += Number(r.c) || 0;
    }

    // тривоги, які записав сам дашборд: рахуємо і тих, хто поклав слухавку ще до тривожного запису
    const periods = [];
    for (const p of this.store.alerts) {
      const pEnd = p.end || Date.now();
      if (pEnd < start.getTime() || p.start >= end.getTime()) continue;
      const calls = zero();
      const [pr] = await this.pool.query(
        `SELECT DATE(calldate - INTERVAL ${h} HOUR) AS d, dcontext, COUNT(*) AS c,
                SUM(lastdata LIKE '%alarm%') AS alarm
           FROM ${this.tCdr}
          WHERE calldate >= ? AND calldate <= ? AND channel LIKE ? AND dcontext IN (?)
            AND lastapp <> 'Queue' AND lastdata NOT LIKE '%no_answer%'
          GROUP BY d, dcontext`, [sqlTime(new Date(p.start)), sqlTime(new Date(pEnd)), prefix, ctxs]);
      for (const r of pr) {
        const id = byCtx.get(r.dcontext);
        if (!id) continue;
        const all = Number(r.c) || 0;
        calls[id] += all;
        const day = days.get(String(r.d).slice(0, 10));
        if (day) day[id] += all - (Number(r.alarm) || 0); // «alarm»-дзвінки вже пораховані вище
      }
      periods.push({ start: p.start, end: p.end || null, calls });
    }

    return {
      from: fromDay, to: toDay, dayHour: h,
      lines: this.lines.map((l) => ({ id: l.id, title: l.title })),
      days: [...days].map(([day, calls]) => ({ day, calls, total: ids.reduce((a, id) => a + calls[id], 0) })),
      periods,
    };
  }
}

// Оператори зв'язку: позначка, яку dialplan пише в CDR(userfield) → назва для звіту
const DEFAULT_CARRIERS = [
  { code: 'MTS', name: 'Vodafone' },
  { code: 'KS', name: 'KyivStar' },
  { code: 'LIFE', name: 'LIFE Cell' },
  { code: 'UT', name: 'Ukrtelecom' },
];

// Добова статистика по трьох лініях разом, з розбивкою по операторах зв'язку:
//   answered — дзвінки, на які відповів оператор черги (CONNECT у queue_log + оператор зв'язку з CDR);
//   ivr      — прослухали IVR і поклали слухавку, не дійшовши до черги (без дзвінків під час тривоги);
//   lost     — стояли в черзі й не дочекались (ABANDON + EXITWITHTIMEOUT), одне число на добу.
Stats.prototype.dailyStats = async function dailyStats(fromDay, toDay) {
  const h = this.dayHour;
  const start = new Date(`${fromDay}T${p2(h)}:00:00`);
  const end = new Date(`${toDay}T${p2(h)}:00:00`);
  end.setDate(end.getDate() + 1);
  const carriers = (this.cfg.carriers && this.cfg.carriers.length ? this.cfg.carriers : DEFAULT_CARRIERS)
    .concat([{ code: '', name: 'Інші' }]);
  const known = new Set(carriers.map((c) => c.code).filter(Boolean));
  const codeOf = (uf) => (known.has(String(uf || '').trim()) ? String(uf).trim() : '');
  const queues = this.lines.map((l) => l.queue);
  const ctxs = this.lines.map((l) => l.context);
  const prefix = (this.cfg.trunkChannelPrefix || '') + '%';
  const from = sqlTime(start), to = sqlTime(end);

  const lineByQueue = new Map(this.lines.map((l) => [l.queue, l.id]));
  const lineByCtx = new Map(this.lines.map((l) => [l.context, l.id]));

  // лічильники: days[day][lineId] = { answered: {code: n}, ivr: {code: n}, lost }
  const days = new Map();
  for (const d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    days.set(key, Object.fromEntries(this.lines.map((l) => [l.id, { answered: {}, ivr: {}, lost: 0 }])));
  }
  const dayOfMs = (ms) => {
    const d = new Date(ms - h * 3600e3);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };
  const slot = (dayKey, lineId) => (days.get(dayKey) || {})[lineId];
  const add = (dayKey, lineId, field, code, n) => {
    const s = slot(dayKey, lineId);
    if (s) s[field][code] = (s[field][code] || 0) + n;
  };

  // Прийнято: кожен CONNECT з queue_log (лінія — черга, де відповіли), оператор зв'язку — з CDR цього дзвінка
  const [acc] = await this.pool.query(
    `SELECT DATE(q.time - INTERVAL ${h} HOUR) AS d, q.queuename AS qn, c.userfield AS uf, COUNT(DISTINCT q.callid) AS n
       FROM ${this.tQueueLog} q
       LEFT JOIN ${this.tCdr} c ON c.uniqueid = q.callid AND c.channel LIKE ?
      WHERE q.time >= ? AND q.time < ? AND q.event = 'CONNECT' AND q.queuename IN (?)
      GROUP BY d, qn, uf`, [prefix, from, to, queues]);
  for (const r of acc) add(String(r.d).slice(0, 10), lineByQueue.get(r.qn), 'answered', codeOf(r.uf), Number(r.n) || 0);

  // Втрачені в черзі — по кожній лінії
  const [lost] = await this.pool.query(
    `SELECT DATE(time - INTERVAL ${h} HOUR) AS d, queuename AS qn, COUNT(*) AS n
       FROM ${this.tQueueLog}
      WHERE time >= ? AND time < ? AND event IN ('ABANDON','EXITWITHTIMEOUT') AND queuename IN (?)
      GROUP BY d, qn`, [from, to, queues]);
  for (const r of lost) { const s = slot(String(r.d).slice(0, 10), lineByQueue.get(r.qn)); if (s) s.lost += Number(r.n) || 0; }

  // Прослухали IVR і поклали слухавку: дійшли до контексту лінії, але не до черги; тривожні — окремо
  const [ivr] = await this.pool.query(
    `SELECT uniqueid, MIN(calldate) AS t, MAX(userfield) AS uf, MAX(dcontext) AS ctx
       FROM ${this.tCdr}
      WHERE calldate >= ? AND calldate < ? AND channel LIKE ? AND dcontext IN (?)
        AND lastapp <> 'Queue' AND lastdata NOT LIKE '%no_answer%' AND lastdata NOT LIKE '%alarm%'
      GROUP BY uniqueid`, [from, to, prefix, ctxs]);
  const periods = this.store.alerts.map((p) => [p.start, p.end || Date.now()]);
  for (const r of ivr) {
    const ms = Date.parse(String(r.t).slice(0, 19).replace(' ', 'T'));
    if (periods.some(([a, b]) => ms >= a && ms <= b)) continue; // під час тривоги — на вкладці тривог
    add(dayOfMs(ms), lineByCtx.get(r.ctx), 'ivr', codeOf(r.uf), 1);
  }

  const rowsOf = (answered, ivrMap) => carriers
    .map((c) => ({ code: c.code, name: c.name, answered: answered[c.code] || 0, ivr: ivrMap[c.code] || 0 }));
  const sum = (rows, f) => rows.reduce((a, r) => a + r[f], 0);
  const out = [...days].map(([day, perLine]) => {
    const lines = this.lines.map((l) => {
      const s = perLine[l.id];
      const rows = rowsOf(s.answered, s.ivr);
      return { id: l.id, title: l.title, carriers: rows, answered: sum(rows, 'answered'), ivr: sum(rows, 'ivr'), lost: s.lost };
    });
    // разом по трьох лініях
    const totals = carriers.map((c, i) => ({
      code: c.code, name: c.name,
      answered: lines.reduce((a, l) => a + l.carriers[i].answered, 0),
      ivr: lines.reduce((a, l) => a + l.carriers[i].ivr, 0),
    }));
    // «Інші» показуємо лише якщо в цей день такі дзвінки були
    const keep = totals.map((t) => !!t.code || t.answered > 0 || t.ivr > 0);
    for (const l of lines) l.carriers = l.carriers.filter((_, i) => keep[i]);
    const carriersTotal = totals.filter((_, i) => keep[i]);
    return {
      day, lines, carriers: carriersTotal,
      answered: sum(carriersTotal, 'answered'), ivr: sum(carriersTotal, 'ivr'),
      lost: lines.reduce((a, l) => a + l.lost, 0),
    };
  });
  return { from: fromDay, to: toDay, dayHour: h, lines: this.lines.map((l) => ({ id: l.id, title: l.title })), days: out };
};

function sqlTime(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
