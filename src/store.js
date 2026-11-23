// Невеликі власні дані дашборду у файлах data/: журнал тривог, сесії, журнал дій адміна.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Store {
  constructor(dir, log = console) {
    this.dir = dir;
    this.log = log;
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    this.alertsFile = path.join(dir, 'alerts.json');
    this.sessionsFile = path.join(dir, 'sessions.json');
    this.auditFile = path.join(dir, 'audit.log');
    this.alerts = this._read(this.alertsFile, []);
    this.sessions = this._read(this.sessionsFile, {});
  }

  _read(file, def) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
  }

  _write(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o640 });
    fs.renameSync(tmp, file);
  }

  // ---------- тривоги ----------
  openAlert() {
    const last = this.alerts[this.alerts.length - 1];
    return last && last.end == null ? last : null;
  }

  alertStarted(t) {
    if (this.openAlert()) return;
    this.alerts.push({ start: t, end: null, seen: t });
    const cutoff = Date.now() - 400 * 86400e3; // тримаємо ~рік історії
    this.alerts = this.alerts.filter((a) => (a.end || Date.now()) >= cutoff);
    this._write(this.alertsFile, this.alerts);
  }

  // дашборд бачить, що тривога ще триває; на диск пишемо не частіше разу на хвилину
  alertSeen(t) {
    const open = this.openAlert();
    if (!open) return;
    const prev = open.seen || open.start;
    open.seen = t;
    if (t - prev >= 60e3) this._write(this.alertsFile, this.alerts);
  }

  alertEnded(t) {
    const open = this.openAlert();
    if (!open) return;
    // якщо дашборд довго не працював, кінець тривоги невідомий —
    // ставимо останній момент, коли її ще бачили, а не «зараз»
    const seen = open.seen || open.start;
    open.end = t - seen > 5 * 60e3 ? seen : t;
    this._write(this.alertsFile, this.alerts);
  }

  // копії періодів, що перетинають проміжок від `from`, з порожнім лічильником дзвінків
  alertsSince(from) {
    return this.alerts
      .filter((a) => (a.end || Date.now()) >= from)
      .map((a) => ({ start: a.start, end: a.end, calls: {} }));
  }

  // ---------- сесії ----------
  // зберігаємо лише хеш токена, сам токен живе тільки в cookie
  static hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  createSession(user, role, fp, days) {
    const token = crypto.randomBytes(32).toString('base64url');
    const h = Store.hashToken(token);
    this.sessions[h] = { user, role, fp, exp: Date.now() + days * 86400e3 };
    this._pruneSessions();
    this._write(this.sessionsFile, this.sessions);
    return token;
  }

  getSession(token) {
    if (!token) return null;
    const s = this.sessions[Store.hashToken(token)];
    if (!s || s.exp < Date.now()) return null;
    return s;
  }

  deleteSession(token) {
    if (!token) return;
    delete this.sessions[Store.hashToken(token)];
    this._write(this.sessionsFile, this.sessions);
  }

  // при зміні пароля в конфігу старі сесії цього користувача стають недійсними
  dropSessionsNotMatching(validUsers) {
    let changed = false;
    for (const [h, s] of Object.entries(this.sessions)) {
      const u = validUsers[s.user];
      if (!u || u.role !== s.role || u.fp !== s.fp) { delete this.sessions[h]; changed = true; }
    }
    if (changed) this._write(this.sessionsFile, this.sessions);
  }

  _pruneSessions() {
    const t = Date.now();
    for (const [h, s] of Object.entries(this.sessions)) if (s.exp < t) delete this.sessions[h];
  }

  // ---------- журнал дій ----------
  audit(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFile(this.auditFile, line, { mode: 0o640 }, (err) => {
      if (err) this.log.warn(`[audit] не вдалося записати: ${err.message}`);
    });
  }

  recentAudit(limit = 50) {
    try {
      const lines = fs.readFileSync(this.auditFile, 'utf8').trim().split('\n');
      return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
    } catch { return []; }
  }
}
