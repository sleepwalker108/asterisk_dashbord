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
}
