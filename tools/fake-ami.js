// Фейковий Asterisk AMI для перевірки дашборду без справжньої телефонії.
// Запуск: node tools/fake-ami.js [порт]   (за замовчуванням 15038)
// Імітує дзвінки: транк → IVR (контекст лінії) → черга → оператор → кінець розмови.
import net from 'node:net';

const PORT = Number(process.argv[2] || 15038);
// --no-agent-events: як Asterisk 11 без eventwhencalled=yes — немає AgentCalled/AgentConnect/AgentComplete,
// лише Dial і Bridge
const NO_AGENT = process.argv.includes('--no-agent-events');
const LINES = [
  { queue: 'NIB', context: 'NIB', exten: '1648', members: ['SIP/508', 'SIP/510', 'SIP/511', 'SIP/525', 'SIP/526', 'SIP/529'] },
  { queue: 'minre', context: 'MINREINT', exten: '1548', members: ['SIP/203', 'SIP/209', 'SIP/210', 'SIP/215', 'SIP/229'] },
  { queue: 'upovnovazhenyy', context: 'UPOVNOVAZHENYY', exten: 'vpo', members: ['SIP/904', 'SIP/905'] },
];
const members = new Map(); // `${queue}|${iface}` -> { status, paused, calls }
for (const l of LINES) for (const m of l.members) members.set(`${l.queue}|${m}`, { status: 1, paused: false, calls: 0 });
members.get('minre|SIP/229').status = 5;
members.get('NIB|SIP/510').paused = true;

const clients = new Set();
let uidSeq = 1795090000;
let chanSeq = 0x400;
let alert = false;

const fmt = (obj) => Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n';
const broadcast = (ev) => {
  if (NO_AGENT && /^Agent(Called|Connect|Complete|RingNoAnswer)$/.test(ev.Event)) return;
  for (const c of clients) if (c.authed) c.write(fmt(ev));
};
const memberEv = (event, queue, iface) => {
  const m = members.get(`${queue}|${iface}`);
  return { Event: event, Privilege: 'agent,all', Queue: queue, Location: iface, MemberName: iface, StateInterface: iface,
    Membership: 'dynamic', Penalty: 0, CallsTaken: m ? m.calls : 0, LastCall: 0, Status: m ? m.status : 0, Paused: m && m.paused ? 1 : 0 };
};
const setStatus = (queue, iface, status) => {
  const m = members.get(`${queue}|${iface}`);
  if (!m) return;
  m.status = status;
  broadcast(memberEv('QueueMemberStatus', queue, iface));
};

const server = net.createServer((sock) => {
  sock.setEncoding('utf8');
  sock.write('Asterisk Call Manager/1.3\r\n');
  clients.add(sock);
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 4);
      const msg = {};
      for (const line of block.split('\r\n')) { const j = line.indexOf(':'); if (j > 0) msg[line.slice(0, j).trim()] = line.slice(j + 1).trim(); }
      handle(sock, msg);
    }
  });
  sock.on('close', () => clients.delete(sock));
  sock.on('error', () => clients.delete(sock));
});

function handle(sock, msg) {
  const id = msg.ActionID;
  const ok = (extra = {}) => sock.write(fmt({ Response: 'Success', ActionID: id, ...extra }));
  const err = (m) => sock.write(fmt({ Response: 'Error', ActionID: id, Message: m }));
  switch ((msg.Action || '').toLowerCase()) {
    case 'login': sock.authed = true; ok({ Message: 'Authentication accepted' }); break;
    case 'ping': ok({ Ping: 'Pong' }); break;
    case 'queuestatus': {
      ok({ Message: 'Queue status will follow' });
      for (const l of LINES) {
        sock.write(fmt({ Event: 'QueueParams', Queue: l.queue, Max: 0, Strategy: 'rrmemory', ActionID: id }));
        for (const [key] of members) {
          const [q, iface] = key.split('|');
          if (q === l.queue) sock.write(fmt({ ...memberEv('QueueMember', q, iface), Event: 'QueueMember', Name: iface, ActionID: id }));
        }
      }
      sock.write(fmt({ Event: 'QueueStatusComplete', ActionID: id }));
      break;
    }
    case 'queuepause': {
      const m = members.get(`${msg.Queue}|${msg.Interface}`);
      if (!m) { err('Interface not found'); break; }
      m.paused = msg.Paused === 'true';
      ok({ Message: 'Interface paused successfully' });
      broadcast({ Event: 'QueueMemberPaused', Queue: msg.Queue, Location: msg.Interface, MemberName: msg.Interface, Paused: m.paused ? 1 : 0 });
      break;
    }
    case 'queueremove': {
      const key = `${msg.Queue}|${msg.Interface}`;
      if (!members.has(key)) { err('Unable to remove interface: Not there'); break; }
      const ev = memberEv('QueueMemberRemoved', msg.Queue, msg.Interface);
      members.delete(key);
      ok({ Message: 'Removed interface from queue' });
      broadcast(ev);
      break;
    }
    case 'queueadd': {
      const key = `${msg.Queue}|${msg.Interface}`;
      if (members.has(key)) { err('Unable to add interface: Already there'); break; }
      members.set(key, { status: 1, paused: false, calls: 0 });
      ok({ Message: 'Added interface to queue' });
      broadcast(memberEv('QueueMemberAdded', msg.Queue, msg.Interface));
      break;
    }
    default: err('Invalid/unknown command');
  }
}

// ---------- імітація дзвінків ----------
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const fakeNum = () => `0${rnd(50, 99)}555${rnd(1000, 9999)}`;

function newCall() {
  const line = LINES[rnd(0, 2)];
  const uid = `${++uidSeq}.${rnd(100, 999)}`;
  const chan = `SIP/transit1-${(++chanSeq).toString(16).padStart(8, '0')}`;
  const num = fakeNum();
  broadcast({ Event: 'Newchannel', Channel: chan, ChannelState: 0, CallerIDNum: '380' + num.slice(1), CallerIDName: '', Uniqueid: uid });
  broadcast({ Event: 'NewCallerid', Channel: chan, CallerIDNum: num, CallerIDName: line.queue === 'upovnovazhenyy' ? 'Upovnovazhenyy' : 'MinRe', Uniqueid: uid });
  // переведення з Уповноваженого на 1548, якщо там усі зайняті
  let target = line;
  if (line.queue === 'upovnovazhenyy') {
    const freeHere = [...members].some(([k, m]) => k.startsWith('upovnovazhenyy|') && m.status === 1 && !m.paused);
    const freeMinre = [...members].some(([k, m]) => k.startsWith('minre|') && m.status === 1 && !m.paused);
    if (!freeHere && freeMinre) target = LINES[1];
  }
  const ex = (prio, app, data) => broadcast({ Event: 'Newexten', Channel: chan, Context: target.context, Extension: target.exten, Priority: prio, Application: app, AppData: data, Uniqueid: uid });
  ex(1, 'NoOp', '');
  ex(2, 'Set', `DNUM=${target.exten}`);
  const audio = alert ? (target.queue === 'NIB' ? 'nib_alarm' : 'airalarm-1548') : '10-hello';
  ex(5, 'Set', `PLAYBACK_AUDIO=${audio}`);
  ex(11, 'Playback', `/var/lib/asterisk/sounds/minre/${audio}`);
  const hang = () => broadcast({ Event: 'Hangup', Channel: chan, Uniqueid: uid, Cause: 16 });
  if (alert) { setTimeout(hang, rnd(5, 15) * 1000); return; }
  if (Math.random() < 0.15) { setTimeout(hang, rnd(3, 8) * 1000); return; } // кинув у IVR
  setTimeout(() => {
    ex(13, 'Queue', `${target.queue},t,,,200,,,answered-by-minre`);
    broadcast({ Event: 'Join', Channel: chan, CallerIDNum: num, CallerIDName: line.queue === 'upovnovazhenyy' ? 'Upovnovazhenyy' : 'MinRe', Queue: target.queue, Position: 1, Count: 1, Uniqueid: uid });
    tryAnswer(target, chan, uid, num, 0);
  }, rnd(6, 12) * 1000);
}

function tryAnswer(line, chan, uid, num, tries) {
  const free = [...members].filter(([k, m]) => k.startsWith(line.queue + '|') && m.status === 1 && !m.paused).map(([k]) => k.split('|')[1]);
  if (!free.length || Math.random() < 0.3) {
    if (tries > 12) { // не дочекався
      broadcast({ Event: 'QueueCallerAbandon', Queue: line.queue, Uniqueid: uid, Position: 1, OriginalPosition: 1, HoldTime: tries * 3 });
      broadcast({ Event: 'Leave', Channel: chan, Queue: line.queue, Count: 0, Uniqueid: uid });
      broadcast({ Event: 'Hangup', Channel: chan, Uniqueid: uid, Cause: 16 });
      return;
    }
    setTimeout(() => tryAnswer(line, chan, uid, num, tries + 1), 3000);
    return;
  }
  const iface = free[rnd(0, free.length - 1)];
  const agentChan = `${iface}-${(++chanSeq).toString(16).padStart(8, '0')}`;
  const agentUid = `${++uidSeq}.${rnd(100, 999)}`;
  broadcast({ Event: 'AgentCalled', Queue: line.queue, AgentCalled: iface, AgentName: iface, ChannelCalling: chan, CallerIDNum: num, Uniqueid: uid });
  broadcast({ Event: 'Dial', SubEvent: 'Begin', Channel: chan, Destination: agentChan, CallerIDNum: num, UniqueID: uid, DestUniqueID: agentUid, Dialstring: iface.replace('SIP/', '') });
  setStatus(line.queue, iface, 6);
  setTimeout(() => {
    broadcast({ Event: 'Leave', Channel: chan, Queue: line.queue, Count: 0, Uniqueid: uid });
    broadcast({ Event: 'AgentConnect', Queue: line.queue, Uniqueid: uid, Channel: agentChan, Member: iface, MemberName: iface, HoldTime: tries * 3, RingTime: 3 });
    broadcast({ Event: 'Dial', SubEvent: 'End', Channel: chan, UniqueID: uid, DialStatus: 'ANSWER' });
    broadcast({ Event: 'Bridge', Bridgestate: 'Link', Bridgetype: 'core', Channel1: chan, Channel2: agentChan, Uniqueid1: uid, Uniqueid2: agentUid, CallerID1: num, CallerID2: iface.replace('SIP/', '') });
    setStatus(line.queue, iface, 2);
    setTimeout(() => {
      const m = members.get(`${line.queue}|${iface}`);
      if (m) m.calls += 1;
      broadcast({ Event: 'AgentComplete', Queue: line.queue, Uniqueid: uid, Channel: agentChan, Member: iface, MemberName: iface, HoldTime: tries * 3, TalkTime: 30, Reason: 'caller' });
      broadcast({ Event: 'Bridge', Bridgestate: 'Unlink', Bridgetype: 'core', Channel1: chan, Channel2: agentChan, Uniqueid1: uid, Uniqueid2: agentUid, CallerID1: num, CallerID2: iface.replace('SIP/', '') });
      broadcast({ Event: 'Hangup', Channel: chan, Uniqueid: uid, Cause: 16 });
      broadcast({ Event: 'Hangup', Channel: agentChan, Uniqueid: agentUid, Cause: 16 });
      setStatus(line.queue, iface, 1);
    }, rnd(15, 60) * 1000);
  }, 3000);
}

setInterval(() => { if (Math.random() < 0.5) newCall(); }, 3000);
// раз на 2 хвилини оператор 229 то зникає, то з'являється
setInterval(() => {
  const m = members.get('minre|SIP/229');
  if (m) setStatus('minre', 'SIP/229', m.status === 5 ? 1 : 5);
}, 120e3);
process.stdin.on('data', (d) => {
  if (String(d).trim() === 'alert') { alert = !alert; console.log('alert =', alert); }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Фейковий AMI слухає 127.0.0.1:${PORT}. Введіть "alert" + Enter, щоб імітувати тривогу у звуках.`));
