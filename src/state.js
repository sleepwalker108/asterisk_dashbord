// Живий стан черг, IVR і розмов, зібраний з подій AMI (Asterisk 11).
const now = () => Date.now();

// Status з QueueMember / QueueMemberStatus
// 0 unknown, 1 not in use, 2 in use, 3 busy, 4 invalid, 5 unavailable, 6 ringing, 7 ringinuse, 8 on hold
function statusOf(code) {
  switch (Number(code)) {
    case 1: return 'free';
    case 2: case 3: case 8: return 'call';
    case 6: case 7: return 'ring';
    case 4: case 5: return 'unavail';
    default: return 'free';
  }
}

export class LiveState {
  constructor(config, log = console) {
    this.cfg = config;
    this.log = log;
    this.lines = config.lines;
    this.byQueue = new Map(this.lines.map((l) => [l.queue, l]));
    this.byContext = new Map(this.lines.map((l) => [l.context, l]));
    this.transfer = config.transfer || null;
    this.reset();
  }

  reset() {
    this.queues = new Map(this.lines.map((l) => [l.queue, { members: new Map(), waiting: new Map() }]));
    this.channels = new Map(); // uniqueid -> { channel, num, name }
    this.ivr = new Map();      // uniqueid -> { lineId, since, alert }
    this.joined = new Set();   // uniqueid, що вже стали в чергу
    this.connected = false;
  }

  // ---------- синхронізація з QueueStatus ----------
  applyQueueStatus(events) {
    const t = now();
    const fresh = new Map(this.lines.map((l) => [l.queue, { members: new Map(), waiting: new Map() }]));
    for (const ev of events) {
      const q = fresh.get(ev.Queue);
      if (!q) continue;
      if (ev.Event === 'QueueMember') {
        const iface = ev.Location || ev.StateInterface || ev.Name;
        const old = this.queues.get(ev.Queue)?.members.get(iface);
        const m = this._memberFrom(ev, old, t);
        q.members.set(iface, m);
      } else if (ev.Event === 'QueueEntry') {
        const uid = ev.Uniqueid || ev.Channel;
        const old = this.queues.get(ev.Queue)?.waiting.get(uid);
        q.waiting.set(uid, {
          uid,
          num: ev.CallerIDNum || '',
          name: ev.CallerIDName || '',
          since: old ? old.since : t - (Number(ev.Wait) || 0) * 1000,
          pos: Number(ev.Position) || 0,
        });
        this.joined.add(uid);
        this.ivr.delete(uid);
      }
    }
    this.queues = fresh;
  }

  _memberFrom(ev, old, t) {
    const iface = ev.Location || ev.StateInterface || ev.Name;
    const status = statusOf(ev.Status);
    const paused = ev.Paused === '1' || ev.Paused === 'true';
    const m = {
      iface,
      name: ev.MemberName || ev.Name || iface,
      status,
      paused,
      since: old && old.status === status ? old.since : t,
      pausedSince: old && old.paused === paused ? old.pausedSince : t,
      callsTaken: Number(ev.CallsTaken) || 0,
      lastCall: Number(ev.LastCall) ? Number(ev.LastCall) * 1000 : null,
      caller: old && (status === 'call' || status === 'ring') ? old.caller : '',
      callerUid: old && (status === 'call' || status === 'ring') ? old.callerUid : null,
      callerFrom: old && (status === 'call' || status === 'ring') ? old.callerFrom : false,
    };
    return m;
  }

  // ---------- обробка подій ----------
  onEvent(ev) {
    const h = this['on' + ev.Event];
    if (h) {
      try { h.call(this, ev); } catch (err) { this.log.warn(`[state] ${ev.Event}: ${err.message}`); }
    }
  }

  onNewchannel(ev) {
    this.channels.set(ev.Uniqueid, { channel: ev.Channel, num: ev.CallerIDNum || '', name: ev.CallerIDName || '', at: now() });
  }

  // прибирає «завислі» записи, якщо якийсь Hangup загубився
  prune() {
    const t = now();
    for (const [uid, c] of this.channels) if (t - (c.at || t) > 6 * 3600e3) this.channels.delete(uid);
    for (const [uid, v] of this.ivr) if (t - v.since > 30 * 60e3) this.ivr.delete(uid);
    for (const uid of this.joined) if (!this.channels.has(uid)) this.joined.delete(uid);
  }

  onNewCallerid(ev) {
    const c = this.channels.get(ev.Uniqueid) || { channel: ev.Channel, at: now() };
    c.num = ev.CallerIDNum || c.num || '';
    c.name = ev.CallerIDName || c.name || '';
    this.channels.set(ev.Uniqueid, c);
  }

  onNewexten(ev) {
    const line = this.byContext.get(ev.Context);
    if (!line) return;
    const uid = ev.Uniqueid;
    if (this.joined.has(uid)) return; // після черги (no_answer тощо) — це вже не IVR
    const prefix = this.cfg.trunkChannelPrefix;
    if (prefix && ev.Channel && !ev.Channel.startsWith(prefix)) return;
    let v = this.ivr.get(uid);
    if (!v) {
      v = { lineId: line.id, since: now(), alert: false };
      this.ivr.set(uid, v);
    }
    v.lineId = line.id;
    if (ev.Application === 'Set' && /PLAYBACK_AUDIO=.*alarm/i.test(ev.AppData || '')) v.alert = true;
    if (ev.Application === 'Playback' && /alarm/i.test(ev.AppData || '')) v.alert = true;
    if (ev.Application === 'Queue') { // ось-ось стане в чергу
      this.ivr.delete(uid);
      this.joined.add(uid);
    }
  }

  onHangup(ev) {
    const uid = ev.Uniqueid;
    this.ivr.delete(uid);
    this.joined.delete(uid);
    this.channels.delete(uid);
    for (const q of this.queues.values()) {
      q.waiting.delete(uid);
      for (const m of q.members.values()) {
        if (m.callerUid === uid) { m.caller = ''; m.callerUid = null; m.callerFrom = false; }
      }
    }
  }

  onJoin(ev) {
    const q = this.queues.get(ev.Queue);
    if (!q) return;
    const uid = ev.Uniqueid;
    this.ivr.delete(uid);
    this.joined.add(uid);
    q.waiting.set(uid, {
      uid,
      num: ev.CallerIDNum || this.channels.get(uid)?.num || '',
      name: ev.CallerIDName || this.channels.get(uid)?.name || '',
      since: now(),
      pos: Number(ev.Position) || 0,
    });
  }

  onLeave(ev) {
    const q = this.queues.get(ev.Queue);
    if (q) q.waiting.delete(ev.Uniqueid);
  }

  onQueueCallerAbandon(ev) { this.onLeave(ev); }

  _member(queue, iface) {
    return this.queues.get(queue)?.members.get(iface);
  }

  _callerInfo(queue, uid) {
    const w = this.queues.get(queue)?.waiting.get(uid);
    const c = this.channels.get(uid);
    const num = w?.num || c?.num || '';
    const name = w?.name || c?.name || '';
    return { num, from: this._isTransfer(queue, name) };
  }

  _isTransfer(queue, callerName) {
    const tr = this.transfer;
    if (!tr) return false;
    const to = this.lines.find((l) => l.id === tr.toLine);
    return !!to && to.queue === queue && callerName === tr.callerIdName;
  }

  onAgentCalled(ev) {
    const iface = ev.AgentCalled || ev.Interface || ev.Member;
    const m = this._member(ev.Queue, iface);
    if (!m) return;
    const uid = ev.Uniqueid;
    const info = this._callerInfo(ev.Queue, uid);
    m.caller = info.num || ev.CallerIDNum || '';
    m.callerUid = uid;
    m.callerFrom = info.from;
    if (m.status !== 'ring') { m.status = 'ring'; m.since = now(); }
  }

  onAgentConnect(ev) {
    const iface = ev.Member || ev.Interface || ev.MemberName;
    const m = this._member(ev.Queue, iface);
    const q = this.queues.get(ev.Queue);
    // Uniqueid у Asterisk 11 — канал абонента; BridgedChannel — запасний варіант
    let uid = ev.Uniqueid;
    if (q && !q.waiting.has(uid) && ev.BridgedChannel && q.waiting.has(ev.BridgedChannel)) uid = ev.BridgedChannel;
    if (m) {
      const info = this._callerInfo(ev.Queue, uid);
      if (info.num) m.caller = info.num;
      m.callerUid = uid;
      m.callerFrom = info.from || m.callerFrom;
      m.status = 'call';
      m.since = now();
    }
    if (q) q.waiting.delete(uid);
  }

  onAgentComplete(ev) {
    const iface = ev.Member || ev.Interface || ev.MemberName;
    const m = this._member(ev.Queue, iface);
    if (!m) return;
    m.caller = ''; m.callerUid = null; m.callerFrom = false;
    m.lastCall = now();
  }

  onAgentRingNoAnswer(ev) {
    const iface = ev.Member || ev.Interface || ev.MemberName;
    const m = this._member(ev.Queue, iface);
    if (!m) return;
    m.caller = ''; m.callerUid = null; m.callerFrom = false;
  }

  // ---------- розмови з подій Dial / Bridge ----------
  // AgentCalled/AgentConnect в Asterisk 11 приходять лише з eventwhencalled=yes у queues.conf.
  // Dial і Bridge приходять завжди, тож з них теж визначаємо, хто кому дзвонить і з ким розмовляє.
  _isTrunk(chan) {
    const p = this.cfg.trunkChannelPrefix;
    return !!chan && !!p && chan.startsWith(p);
  }

  // 'SIP/203-0000047e' → 'SIP/203'
  static ifaceOf(chan) {
    return String(chan || '').replace(/-[0-9a-f]+$/i, '');
  }

  // усі члени черг з цим інтерфейсом (оператор може бути в кількох чергах)
  _membersByIface(iface) {
    const out = [];
    for (const [queue, q] of this.queues) {
      const m = q.members.get(iface);
      if (m) out.push([queue, m]);
    }
    return out;
  }

  _setCaller(iface, uid, fallbackNum, status) {
    const c = this.channels.get(uid);
    const num = c?.num || fallbackNum || '';
    for (const [queue, m] of this._membersByIface(iface)) {
      if (m.callerUid !== uid) { m.caller = num; m.callerUid = uid; }
      else if (num) m.caller = num;
      m.callerFrom = this._isTransfer(queue, c?.name || '');
      if (status && m.status !== status && m.status !== 'unavail') { m.status = status; m.since = now(); }
    }
  }

  _clearCaller(uid) {
    for (const q of this.queues.values()) {
      for (const m of q.members.values()) {
        if (m.callerUid === uid) { m.caller = ''; m.callerUid = null; m.callerFrom = false; }
      }
    }
  }

  onDial(ev) {
    const sub = ev.SubEvent || 'Begin';
    if (sub === 'Begin') {
      if (!this._isTrunk(ev.Channel)) return; // цікавлять лише дзвінки від абонентів з транку
      this._setCaller(LiveState.ifaceOf(ev.Destination), ev.UniqueID || ev.Uniqueid, ev.CallerIDNum, 'ring');
    } else if (sub === 'End') {
      // оператор не взяв слухавку — прибираємо «дзвонить»; якщо взяв, далі прийде Bridge
      if (String(ev.DialStatus || '').toUpperCase() !== 'ANSWER') this._clearCaller(ev.UniqueID || ev.Uniqueid);
    }
  }

  onBridge(ev) {
    const [c1, c2] = [ev.Channel1, ev.Channel2];
    const [u1, u2] = [ev.Uniqueid1, ev.Uniqueid2];
    let callerUid = null, agentChan = null, num = '';
    if (this._isTrunk(c1)) { callerUid = u1; agentChan = c2; num = ev.CallerID1; }
    else if (this._isTrunk(c2)) { callerUid = u2; agentChan = c1; num = ev.CallerID2; }
    if (!callerUid) return;
    if (ev.Bridgestate === 'Link') this._setCaller(LiveState.ifaceOf(agentChan), callerUid, num, 'call');
    else if (ev.Bridgestate === 'Unlink') this._clearCaller(callerUid);
  }

  onQueueMemberStatus(ev) {
    const q = this.queues.get(ev.Queue);
    if (!q) return;
    const iface = ev.Location || ev.StateInterface || ev.MemberName;
    const old = q.members.get(iface);
    q.members.set(iface, this._memberFrom(ev, old, now()));
  }

  onQueueMemberAdded(ev) { this.onQueueMemberStatus(ev); }

  onQueueMemberRemoved(ev) {
    const q = this.queues.get(ev.Queue);
    if (!q) return;
    q.members.delete(ev.Location || ev.StateInterface || ev.MemberName);
  }

  onQueueMemberPaused(ev) {
    const iface = ev.Location || ev.StateInterface || ev.MemberName;
    const m = this._member(ev.Queue, iface);
    if (!m) return;
    const paused = ev.Paused === '1' || ev.Paused === 'true';
    if (m.paused !== paused) { m.paused = paused; m.pausedSince = now(); }
  }

  // ---------- знімок для клієнтів ----------
  snapshot() {
    const lines = this.lines.map((l) => {
      const q = this.queues.get(l.queue);
      const members = [...q.members.values()].map((m) => ({
        iface: m.iface,
        ext: m.iface.replace(/^[A-Z]+\//i, ''),
        status: m.status,
        paused: m.paused,
        since: m.since,
        pausedSince: m.pausedSince,
        callsTaken: m.callsTaken,
        lastCall: m.lastCall,
        caller: m.status === 'call' || m.status === 'ring' ? m.caller : '',
        fromUpov: !!m.callerFrom,
      })).sort((a, b) => a.ext.localeCompare(b.ext, 'uk', { numeric: true }));
      const waiting = [...q.waiting.values()].sort((a, b) => a.since - b.since).map((w) => ({
        num: w.num, since: w.since, fromUpov: this._isTransfer(l.queue, w.name),
      }));
      const ivr = [];
      for (const [uid, v] of this.ivr) {
        if (v.lineId !== l.id) continue;
        const c = this.channels.get(uid);
        const from = !!(this.transfer && this.transfer.toLine === l.id && c?.name === this.transfer.callerIdName);
        ivr.push({ num: c?.num || '', since: v.since, alert: v.alert, fromUpov: from });
      }
      ivr.sort((a, b) => a.since - b.since);
      return { id: l.id, title: l.title, queue: l.queue, members, waiting, ivr };
    });
    return { connected: this.connected, lines };
  }
}
