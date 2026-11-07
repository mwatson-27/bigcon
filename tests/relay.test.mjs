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

function makeRoom() {
  const sockets = [];
  const ctx = {
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
  room.join = async role => {
    const { ws } = await room.open(role);
    room.webSocketMessage(ws, JSON.stringify({ type: 'join' }));
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

  room.say(guest, { type: 'data', data: { hello: 1 } });
  assert.deepEqual(host.of('data'), [{ type: 'data', source: gid, data: { hello: 1 } }]);

  room.say(host, { type: 'data', target: gid, data: { reply: 2 } });
  assert.equal(guest.of('data')[0].data.reply, 2);

  room.say(host, { type: 'data', target: 'unknown', data: 1 });
  assert.equal(guest.of('data').length, 1, 'unknown target receives nothing');
});

test('RL-11 messages before join are ignored; bad JSON and oversize frames are handled', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  const { ws: early } = await room.open('guest');
  room.say(early, { type: 'data', data: 'sneaky' });
  assert.equal(host.of('data').length, 0, 'unjoined sockets cannot send data');
  room.webSocketMessage(early, '{not json');
  assert.equal(early.of('error')[0].code, 'bad-message');
  room.webSocketMessage(early, 'x'.repeat(256_001));
  assert.equal(early.closed.code, 1009);
});

test('RL-12 closing a guest tells the host; closing the host tells guests', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  const guest = await room.join('guest');
  room.webSocketClose(guest, 1000, '');
  assert.equal(host.of('left')[0].id, guest.of('ready')[0].id);
  guest.readyState = 1; // still counted: simulate the reconnect window
  room.webSocketClose(host, 1006, '');
  assert.equal(guest.of('host_lost').length, 1);
});

test('RL-13 a reconnecting host re-announces joined guests and they get host_back', async () => {
  const room = makeRoom();
  const host1 = await room.join('host');
  const guest = await room.join('guest');
  host1.close(1006, ''); room.webSocketClose(host1, 1006, '');
  const host2 = await room.join('host');
  assert.equal(host2.of('incoming')[0].id, guest.of('ready')[0].id);
  assert.equal(guest.of('host_back').length, 1);
});

test('RL-14 host can kick a guest with "leave"', async () => {
  const room = makeRoom();
  const host = await room.join('host');
  const guest = await room.join('guest');
  room.say(host, { type: 'leave', target: guest.of('ready')[0].id });
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
