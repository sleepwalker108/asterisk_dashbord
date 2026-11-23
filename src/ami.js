// Мінімальний клієнт Asterisk Manager Interface (AMI) без сторонніх залежностей.
// Тримає одне TCP-з'єднання, сам перепідключається, вміє дії зі списком подій у відповіді.
import net from 'node:net';
import { EventEmitter } from 'node:events';

export class Ami extends EventEmitter {
  constructor({ host, port = 5038, username, secret }, log = console) {
    super();
    this.opts = { host, port, username, secret };
    this.log = log;
    this.sock = null;
    this.buf = '';
    this.gotBanner = false;
    this.ready = false;
    this.seq = 0;
    this.pending = new Map(); // actionId -> { resolve, reject, list, endEvent, events, timer }
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this._ping);
    if (this.sock) this.sock.destroy();
  }

  _connect() {
    const { host, port } = this.opts;
    this.buf = '';
    this.gotBanner = false;
    this.ready = false;
    const sock = net.connect({ host, port });
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.setKeepAlive(true, 15000);
    sock.setTimeout(0);
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (err) => this.log.warn(`[ami] помилка з'єднання ${host}:${port}: ${err.message}`));
    sock.on('close', () => {
      const wasReady = this.ready;
      this.ready = false;
      clearInterval(this._ping);
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('AMI disconnected')); }
      this.pending.clear();
      if (wasReady) this.emit('down');
      if (!this.stopped) setTimeout(() => this._connect(), 3000);
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    if (!this.gotBanner) {
      const i = this.buf.indexOf('\r\n');
      if (i < 0) return;
      this.gotBanner = true;
      this.buf = this.buf.slice(i + 2);
      this._login();
    }
    let idx;
    while ((idx = this.buf.indexOf('\r\n\r\n')) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 4);
      if (block.trim()) this._onMessage(parseBlock(block));
    }
    if (this.buf.length > 4 * 1024 * 1024) { // захист від сміття без роздільників
      this.log.warn('[ami] переповнення буфера, перепідключення');
      this.sock.destroy();
    }
  }

  _onMessage(msg) {
    const id = msg.ActionID;
    if (id && this.pending.has(id)) {
      const p = this.pending.get(id);
      if (msg.Response) {
        if (msg.Response === 'Error') { this._finish(id); p.reject(new Error(msg.Message || 'AMI error')); return; }
        if (!p.list) { this._finish(id); p.resolve(msg); return; }
        p.response = msg;
        return;
      }
      if (msg.Event) {
        if (msg.Event === p.endEvent) { this._finish(id); p.resolve(p.events); return; }
        p.events.push(msg);
        return;
      }
    }
    if (msg.Event) this.emit('event', msg);
  }

  _finish(id) {
    const p = this.pending.get(id);
    if (p) clearTimeout(p.timer);
    this.pending.delete(id);
  }

  async _login() {
    try {
      await this.action({ Action: 'Login', Username: this.opts.username, Secret: this.opts.secret, Events: 'on' });
      this.ready = true;
      this.log.info(`[ami] підключено до ${this.opts.host}:${this.opts.port}`);
      clearInterval(this._ping);
      this._ping = setInterval(() => {
        this.action({ Action: 'Ping' }, { timeoutMs: 10000 }).catch(() => {
          this.log.warn('[ami] немає відповіді на Ping, перепідключення');
          if (this.sock) this.sock.destroy();
        });
      }, 30000);
      this.emit('up');
    } catch (err) {
      this.log.error(`[ami] вхід не вдався: ${err.message}`);
      this.sock.destroy();
    }
  }

  // list: true → чекаємо подію endEvent і повертаємо масив подій
  action(fields, { list = false, endEvent = null, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.sock || this.sock.destroyed) { reject(new Error('AMI not connected')); return; }
      if (!this.ready && fields.Action !== 'Login') { reject(new Error('AMI not ready')); return; }
      const id = `qd-${++this.seq}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`AMI timeout: ${fields.Action}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, list, endEvent, events: [], timer });
      let out = '';
      for (const [k, v] of Object.entries({ ...fields, ActionID: id })) {
        if (v === undefined || v === null) continue;
        out += `${k}: ${String(v).replace(/[\r\n]/g, ' ')}\r\n`;
      }
      this.sock.write(out + '\r\n');
    });
  }
}

function parseBlock(block) {
  const msg = {};
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!(k in msg)) msg[k] = v;
  }
  return msg;
}
