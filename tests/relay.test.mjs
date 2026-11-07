/*
 * Cloudflare relay (cloudflare-relay/src/index.js): routing, Discord endpoints
 * and the BigConRoom Durable Object.
 *
 * The Worker imports "cloudflare:workers", which Node cannot resolve, so the
 * source is loaded with that import swapped for a stub. WebSockets, the
 * WebSocketPair and the Durable Object context are in-memory fakes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CLIENT_ID = '1565709969913815060';
const SRC = path.resolve(import.meta.dirname, '../cloudflare-relay/src/index.js');

/* ---------- fakes ---------- */
class FakeWS {
  constructor() { this.readyState = 1; this.sent = []; this.closed = null; this.attachment = null; }
  serializeAttachment(a) { this.attachment = structuredClone(a); }
  deserializeAttachment() { return this.attachment ? structuredClone(this.attachment) : null; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
  of(type) { return this.sent.filter(m => m.type === type); }
}
globalThis.WebSocket = { OPEN: 1 };
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeWS(); this[1] = new FakeWS(); } };
globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.a = a; this.b = b; } };
// Node's Response rejects status 101; the Workers runtime allows it.
const BaseResponse = Response;
globalThis.Response = class extends BaseResponse {
  constructor(body, init = {}) {
    if (init.status === 101) {
      super(body, { ...init, status: 200 });
      Object.defineProperty(this, 'status', { value: 101 });
      this.webSocket = init.webSocket;
    } else super(body, init);
  }
};

const tmp = path.join(os.tmpdir(), `bigcon-relay-${process.pid}.mjs`);
const code = fs.readFileSync(SRC, 'utf8').replace(
  /import \{ DurableObject \} from "cloudflare:workers";/,
  'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
assert.notEqual(code.indexOf('class DurableObject'), -1, 'import stub applied');
fs.writeFileSync(tmp, code);
const { default: worker, BigConRoom } = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

/* Async KV + alarm storage, as a Durable Object's ctx.storage. */
function makeStorage() {
  const kv = new Map();
  let alarm = null;
  return {
    kv,
    get: async k => (kv.has(k) ? structuredClone(kv.get(k)) : undefined),
    put: async (k, v) => { kv.set(k, structuredClone(v)); },
    delete: async k => kv.delete(k),
    getAlarm: async () => alarm,
    setAlarm: async t => { alarm = t; },
    deleteAlarm: async () => { alarm = null; },
  };
}

const HOST_SECRET = 'h'.repeat(64);

function makeRoom() {
  const sockets = [];
  const ctx = {
    storage: makeStorage(),
    getWebSockets: () => sockets.filter(ws => ws.readyState !== 3),
    acceptWebSocket: ws => sockets.push(ws),
    setWebSocketAutoResponse() {},
  };
  const room = new BigConRoom(ctx, {});
  /* Open a socket the way the Worker would; returns {res, ws}. */
  room.open = async role => {
    const res = await room.fetch(new Request(`https://relay/ws/ROOM?role=${role}`, { headers: { Upgrade: 'websocket' } }));
    return { res, ws: res.webSocket ? sockets[sockets.length - 1] : null };
  };
  room.storage = ctx.storage;
  room.allSockets = sockets;
  room.join = async (role, secret = HOST_SECRET) => {
    const { ws } = await room.open(role);
    await room.webSocketMessage(ws, JSON.stringify(role === 'host' ? { type: 'join', role, secret } : { type: 'join', role }));
    return ws;
  };
  room.say = (ws, msg) => room.webSocketMessage(ws, JSON.stringify(msg));
  return room;
}

const withFetch = async (handler, fn) => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  try { await fn(calls); } finally { globalThis.fetch = real; }
};
const post = (p, body, headers = {}) => new Request('https://relay' + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

/* ---------- Worker routing ---------- */
test('RL-01 /health answers, unknown paths 404', async () => {
  const ok = await worker.fetch(new Request('https://relay/health'), {});
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).service, 'bigcon-relay');
  assert.equal((await worker.fetch(new Request('https://relay/nope'), {})).status, 404);
});

test('RL-02 /ws validates upgrade header, room code and role before reaching the room', async () => {
  const env = { BIGCON_ROOMS: { idFromName: () => { throw new Error('should not be reached'); } } };
  const ws = (p, headers = { Upgrade: 'websocket' }) => worker.fetch(new Request('https://relay' + p, { headers }), env);
  assert.equal((await ws('/ws/ABC?role=host', {})).status, 426);
  assert.equal((await ws('/ws/bad%20room?role=host')).status, 400);
  assert.equal((await ws('/ws/' + 'A'.repeat(41) + '?role=host')).status, 400);
  assert.equal((await ws('/ws/ABC?role=admin')).status, 400);
  assert.equal((await ws('/ws/ABC')).status, 400);
});

test('RL-03 room codes are case-insensitive: abc and ABC reach the same room', async () => {
  const names = [];
  const env = { BIGCON_ROOMS: { idFromName: n => { names.push(n); return n; }, get: () => ({ fetch: async () => new BaseResponse('ok') }) } };
  for (const c of ['abc', 'ABC']) await worker.fetch(new Request(`https://relay/ws/${c}?role=guest`, { headers: { Upgrade: 'websocket' } }), env);
  assert.deepEqual(names, ['ABC', 'ABC']);
});

/* ---------- /api/token ---------- */
test('RL-04 /api/token: method, config, body validation and exchange', async () => {
  assert.equal((await worker.fetch(new Request('https://relay/api/token', { method: 'OPTIONS' }), {})).status, 204);
  assert.equal((await worker.fetch(new Request('https://relay/api/token'), {})).status, 405);
  assert.equal((await worker.fetch(post('/api/token', { code: 'x' }), {})).status, 503, 'no secret configured');
  const env = { DISCORD_CLIENT_SECRET: 's3cret' };
  assert.equal((await worker.fetch(post('/api/token', {}), env)).status, 400);
  assert.equal((await worker.fetch(post('/api/token', { code: 'x'.repeat(2049) }), env)).status, 400);

  await withFetch(() => Response.json({ access_token: 'tok' }), async calls => {
    const res = await worker.fetch(post('/api/token', { code: 'abc' }), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { access_token: 'tok' });
    const sent = new URLSearchParams(calls[0].init.body);
    assert.equal(sent.get('client_id'), CLIENT_ID);
    assert.equal(sent.get('code'), 'abc');
  });
  await withFetch(() => Response.json({ error: 'invalid_grant' }, { status: 400 }), async () => {
    assert.equal((await worker.fetch(post('/api/token', { code: 'abc' }), env)).status, 401);
  });
});

/* ---------- /api/notify ---------- */
const CHANNEL = '123456789012345678';
const notify = (body, token = 'good') => post('/api/notify', body, token ? { Authorization: 'Bearer ' + token } : {});
const turnEvent = { type: 'turn', turn: 3, player: 'Alice' };

test('RL-05 /api/notify rejects unconfigured, unauthenticated and malformed requests', async () => {
  const env = { DISCORD_BOT_TOKEN: 'bot' };
  assert.equal((await worker.fetch(notify({ channel_id: CHANNEL, event: turnEvent }), {})).status, 503);
  assert.equal((await worker.fetch(notify({ channel_id: CHANNEL, event: turnEvent }, null), env)).status, 401);
  assert.equal((await worker.fetch(notify({ channel_id: 'nope', event: turnEvent }), env)).status, 400);
});

test('RL-06 /api/notify refuses tokens issued to a different Discord application', async () => {
  const env = { DISCORD_BOT_TOKEN: 'bot' };
  await withFetch(() => Response.json({ application: { id: '999' } }), async calls => {
    const res = await worker.fetch(notify({ channel_id: CHANNEL, event: turnEvent }), env);
    assert.equal(res.status, 403);
    assert.equal(calls.length, 1, 'the bot must never be asked to post');
  });
  await withFetch(() => Response.json({ message: 'bad' }, { status: 401 }), async () => {
    assert.equal((await worker.fetch(notify({ channel_id: CHANNEL, event: turnEvent }), env)).status, 401);
  });
});

test('RL-07 /api/notify posts a sanitised turn message with mentions disabled', async () => {
  const env = { DISCORD_BOT_TOKEN: 'bot' };
  await withFetch(url => url.includes('/oauth2/@me') ? Response.json({ application: { id: CLIENT_ID } }) : Response.json({}), async calls => {
    const res = await worker.fetch(notify({ channel_id: CHANNEL, event: { type: 'turn', turn: 3, player: '@everyone <@1>' } }), env);
    assert.equal(res.status, 200);
    const post = calls.find(c => c.url.endsWith(`/channels/${CHANNEL}/messages`));
    const body = JSON.parse(post.init.body);
    assert.equal(post.init.headers.Authorization, 'Bot bot');
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.match(body.content, /Turn 3/);
    assert.doesNotMatch(body.content, /[@<>]/);
  });
});

test('RL-08 /api/notify game_over lists clamped scores; bad events are rejected', async () => {
  const env = { DISCORD_BOT_TOKEN: 'bot' };
  await withFetch(url => url.includes('/oauth2/@me') ? Response.json({ application: { id: CLIENT_ID } }) : Response.json({}), async calls => {
    const event = { type: 'game_over', winner: 'Bob', scores: [{ name: 'Bob', money: 1e12 }, { name: 'Eve', money: -5 }, { name: 'Zed', money: 'x' }] };
    assert.equal((await worker.fetch(notify({ channel_id: CHANNEL, event }), env)).status, 200);
    const content = JSON.parse(calls.at(-1).init.body).content;
    assert.match(content, /1\. Bob: \$999999/);
    assert.match(content, /2\. Eve: \$0/);
    assert.match(content, /3\. Zed: \$0/);
    for (const bad of [{ type: 'turn', turn: 0, player: 'A' }, { type: 'turn', turn: 1, player: '' }, { type: 'game_over' }, { type: 'wat' }]) {
      assert.equal((await worker.fetch(notify({ channel_id: CHANNEL, event: bad }), env)).status, 400);
    }
  });
});

/* ---------- BigConRoom ---------- */
test('RL-09 a host joins; a second host and a host-less guest are refused', async () => {
  const room = makeRoom();
  assert.equal((await room.open('guest')).res.status, 404, 'no host yet');
  const host = await room.join('host');
  assert.equal(host.of('ready').length, 1);
  assert.equal((await room.open('host')).res.status, 409, 'host slot taken');
});

test('RL-10 a guest join is announced to the host, and data routes both ways', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  const guest = await room.join('guest');
  const gid = guest.of('ready')[0].id;
  assert.deepEqual(host.of('incoming'), [{ type: 'incoming', id: gid }]);

  await room.say(guest, { type: 'data', data: { hello: 1 } });
  assert.deepEqual(host.of('data'), [{ type: 'data', source: gid, data: { hello: 1 } }]);

  await room.say(host, { type: 'data', target: gid, data: { reply: 2 } });
  assert.equal(guest.of('data')[0].data.reply, 2);

  await room.say(host, { type: 'data', target: 'unknown', data: 1 });
  assert.equal(guest.of('data').length, 1, 'unknown target receives nothing');
});

test('RL-11 messages before join are ignored; bad JSON and oversize frames are handled', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  const { ws: early } = await room.open('guest');
  await room.say(early, { type: 'data', data: 'sneaky' });
  assert.equal(host.of('data').length, 0, 'unjoined sockets cannot send data');
  await room.webSocketMessage(early, '{not json');
  assert.equal(early.of('error')[0].code, 'bad-message');
  await room.webSocketMessage(early, 'x'.repeat(256_001));
  assert.equal(early.closed.code, 1009);
});

test('RL-12 closing a guest tells the host; closing the host tells guests', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  const guest = await room.join('guest');
  await room.webSocketClose(guest, 1000, '');
  assert.equal(host.of('left')[0].id, guest.of('ready')[0].id);
  guest.readyState = 1; // still counted: simulate the reconnect window
  await room.webSocketClose(host, 1006, '');
  assert.equal(guest.of('host_lost').length, 1);
});

test('RL-13 a reconnecting host re-announces joined guests and they get host_back', async () => {
  const room = makeRoom();
  const host1 = await room.join('host');
  const guest = await room.join('guest');
  host1.close(1006, ''); await room.webSocketClose(host1, 1006, '');
  const host2 = await room.join('host');
  assert.equal(host2.of('incoming')[0].id, guest.of('ready')[0].id);
  assert.equal(guest.of('host_back').length, 1);
});

test('RL-14 host can kick a guest with "leave"', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  const guest = await room.join('guest');
  await room.say(host, { type: 'leave', target: guest.of('ready')[0].id });
  assert.equal(guest.closed.code, 1000);
});

test('RL-15 the room caps at 8 connections', async () => {
  const room = makeRoom();
  await room.join('host');
  for (let i = 0; i < 7; i++) assert.equal((await room.open('guest')).res.status, 101);
  assert.equal((await room.open('guest')).res.status, 429);
});

test('RL-16 idle sockets that never join are evicted so they cannot lock the room', async () => {
  const room = makeRoom();
  await room.join('host');
  const idle = [];
  for (let i = 0; i < 7; i++) idle.push((await room.open('guest')).ws);
  assert.equal((await room.open('guest')).res.status, 429, 'room is full of idle sockets');

  const realNow = Date.now;
  Date.now = () => realNow() + 11_000;
  try {
    const { res } = await room.open('guest');
    assert.equal(res.status, 101, 'stale unjoined sockets were dropped to make space');
    assert.ok(idle.every(ws => ws.closed?.code === 1008));
  } finally { Date.now = realNow; }
});

test('RL-17 joined guests are never evicted by the idle sweep', async () => {
  const room = makeRoom();
  await room.join('host');
  const guest = await room.join('guest');
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try { await room.open('guest'); } finally { Date.now = realNow; }
  assert.equal(guest.closed, null);
});

/* ---------- host claim (anti-squatting) ---------- */
const OTHER_SECRET = 'o'.repeat(64);
const CLAIM_IDLE = 10 * 60_000;
const withNow = async (offsetMs, fn) => {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  try { return await fn(); } finally { Date.now = realNow; }
};
/* Simulate the runtime closing a socket: the readyState flips, then webSocketClose fires. */
const drop = async (room, ws) => { ws.readyState = 3; await room.webSocketClose(ws, 1006, ''); };

test('RL-18 the first host to join claims the room and only a hash is stored', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  assert.equal(host.of('ready').length, 1);
  assert.equal(host.attachment.joined, true);
  const claim = await room.storage.get('claim');
  assert.match(claim.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(claim.hash, HOST_SECRET, 'the secret itself is never stored');
  assert.equal(claim.idleSince, null);
  assert.equal(await room.storage.getAlarm(), null, 'no expiry clock while a host is connected');
});

test('RL-19 a host reconnecting with the right secret is accepted and guests are re-announced', async () => {
  const room = makeRoom();
  const host1 = await room.join('host');
  const guest = await room.join('guest');
  await drop(room, host1);
  assert.equal(guest.of('host_lost').length, 1);
  const host2 = await room.join('host');
  assert.equal(host2.of('ready').length, 1);
  assert.equal(host2.of('error').length, 0);
  assert.equal(host2.of('incoming')[0].id, guest.of('ready')[0].id);
  assert.equal(guest.of('host_back').length, 1);
});

test('RL-20 a wrong host secret is rejected without disturbing guests', async () => {
  const room = makeRoom();
  const host1 = await room.join('host');
  const guest = await room.join('guest');
  await drop(room, host1);
  const before = guest.sent.length;
  const squatter = await room.join('host', OTHER_SECRET);
  assert.equal(squatter.of('error')[0].code, 'room-claimed');
  assert.equal(squatter.closed.code, 1008);
  assert.equal(squatter.of('ready').length, 0);
  assert.equal(squatter.attachment.joined, false);
  await room.webSocketClose(squatter, 1008, 'Room claimed'); // the runtime's follow-up callback
  assert.equal(guest.sent.length, before, 'guest saw nothing: no host_back, no extra host_lost');
  assert.equal(guest.closed, null);
  await room.say(guest, { type: 'data', data: 'secret chatter' });
  assert.equal(squatter.of('data').length, 0, 'guest traffic never reaches the squatter');
  // The rightful host still gets back in afterwards.
  const host2 = await room.join('host');
  assert.equal(host2.of('ready').length, 1);
  assert.equal(guest.of('host_back').length, 1);
});

test('RL-21 a missing or malformed host secret is rejected, even on an unclaimed room', async () => {
  const room = makeRoom();
  for (const msg of [{ type: 'join', role: 'host' }, { type: 'join', role: 'host', secret: 'short' }, { type: 'join', role: 'host', secret: 12345678901234567890 }, { type: 'join', role: 'host', secret: 'bad chars!'.repeat(4) }]) {
    const { ws } = await room.open('host');
    await room.webSocketMessage(ws, JSON.stringify(msg));
    assert.equal(ws.of('error')[0].code, 'host-secret-required');
    assert.equal(ws.closed.code, 1008);
    assert.equal(ws.of('ready').length, 0);
  }
  assert.equal(await room.storage.get('claim'), undefined, 'a rejected join never claims the room');
  // And a missing secret can't take over a claimed room either.
  await room.join('host');
  assert.ok(await room.storage.get('claim'));
});

test('RL-22 a second host join while a host is connected is refused, even with the right secret', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  // Two sockets open before either joins (the fetch-time check can't see the race).
  const a = (await room.open('host'));
  assert.equal(a.res.status, 409, 'refused at fetch while a host is connected');
  host.readyState = 3; // host socket silently gone: fetch passes, then both join
  const s1 = (await room.open('host')).ws, s2 = (await room.open('host')).ws;
  await Promise.all([
    room.webSocketMessage(s1, JSON.stringify({ type: 'join', role: 'host', secret: HOST_SECRET })),
    room.webSocketMessage(s2, JSON.stringify({ type: 'join', role: 'host', secret: HOST_SECRET })),
  ]);
  const joined = [s1, s2].filter(s => s.of('ready').length);
  assert.equal(joined.length, 1, 'only one racing host wins');
  const loser = [s1, s2].find(s => !s.of('ready').length);
  assert.equal(loser.of('error')[0].code, 'host-taken');
});

test('RL-23 racing first-claims from different secrets: exactly one wins', async () => {
  const room = makeRoom();
  const s1 = (await room.open('host')).ws, s2 = (await room.open('host')).ws;
  await Promise.all([
    room.webSocketMessage(s1, JSON.stringify({ type: 'join', role: 'host', secret: HOST_SECRET })),
    room.webSocketMessage(s2, JSON.stringify({ type: 'join', role: 'host', secret: OTHER_SECRET })),
  ]);
  assert.equal([s1, s2].filter(s => s.of('ready').length).length, 1);
  assert.equal([s1, s2].filter(s => s.of('error').length).length, 1);
});

test('RL-24 the claim starts expiring when the room empties, and a reconnect cancels it', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  const guest = await room.join('guest');
  await drop(room, host);
  assert.equal((await room.storage.get('claim')).idleSince, null, 'a guest is still connected: not abandoned');
  assert.equal(await room.storage.getAlarm(), null);
  await drop(room, guest);
  const claim = await room.storage.get('claim');
  assert.ok(claim.idleSince, 'empty room: idle clock started');
  assert.equal(await room.storage.getAlarm(), claim.idleSince + CLAIM_IDLE);

  const host2 = await room.join('host');
  assert.equal(host2.of('ready').length, 1);
  assert.equal((await room.storage.get('claim')).idleSince, null);
  assert.equal(await room.storage.getAlarm(), null, 'reconnect cancels the pending expiry');
});

test('RL-25 an abandoned room can be reclaimed by a different host after the idle period (alarm)', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  await drop(room, host);
  // Too early: still claimed, and the alarm leaves it alone.
  await withNow(CLAIM_IDLE - 1000, async () => {
    await room.alarm();
    assert.ok(await room.storage.get('claim'));
    const early = await room.join('host', OTHER_SECRET);
    assert.equal(early.of('error')[0].code, 'room-claimed');
  });
  // Past the deadline the alarm deletes the claim and the code is free.
  await withNow(CLAIM_IDLE + 1000, async () => {
    await room.alarm();
    assert.equal(await room.storage.get('claim'), undefined);
    const fresh = await room.join('host', OTHER_SECRET);
    assert.equal(fresh.of('ready').length, 1);
    assert.equal((await room.storage.get('claim')).idleSince, null);
  });
});

test('RL-26 an expired claim is also honoured lazily if the alarm never ran', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  await drop(room, host);
  let fresh;
  await withNow(CLAIM_IDLE + 1000, async () => {
    fresh = await room.join('host', OTHER_SECRET);
    assert.equal(fresh.of('ready').length, 1, 'no alarm needed');
  });
  // The new claim replaced the old one: the original secret no longer works.
  await drop(room, fresh);
  const old = await room.join('host', HOST_SECRET);
  assert.equal(old.of('error')[0].code, 'room-claimed');
});

test('RL-26b an unjoined host socket is never a routing target for guests', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  await drop(room, host);
  const { ws: squatter } = await room.open('host'); // connects but never proves the secret
  assert.equal((await room.open('guest')).res.status, 404, 'an unjoined socket is not a host');
  const host2 = await room.join('host');
  const guest = await room.join('guest');
  await room.say(guest, { type: 'data', data: 'hi' });
  assert.equal(host2.of('data').length, 1);
  assert.equal(squatter.of('data').length + squatter.of('incoming').length, 0);
});

test('RL-27 stray connections cannot extend an abandoned claim, and a busy room is never expired', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  await drop(room, host);
  const idleSince = (await room.storage.get('claim')).idleSince;
  const stray = await room.join('host', OTHER_SECRET); // rejected
  await room.webSocketClose(stray, 1008, '');
  assert.equal((await room.storage.get('claim')).idleSince, idleSince, 'idle clock not restarted');

  // A live socket at alarm time keeps the claim.
  const room2 = makeRoom();
  const h = await room2.join('host');
  await drop(room2, h);
  const guest = (await room2.open('guest')); // fetch refuses (no host) so nothing is connected
  assert.equal(guest.res.status, 404);
  await withNow(CLAIM_IDLE + 1000, async () => {
    const h2 = await room2.join('host');
    assert.equal(h2.of('ready').length, 1);
    await room2.alarm(); // claim was refreshed when h2 joined
    assert.ok(await room2.storage.get('claim'));
  });
});
