/*
 * Multiplayer identity/ordering and disconnect/reconnect — sections 2 and 3
 * (MP-01..MP-06, DC-01..DC-06) of docs/CODE_LEVEL_TEST_PLAN.md.
 *
 * Guests are fake PeerJS-style connections that record every outgoing message;
 * timing (prompt timeouts, the away-turn watchdog) runs on the virtual clock.
 * DC-05 (host migration) is skipped: the current design has no host migration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, makeGame, makeConn, withSeed } from './helpers/harness.mjs';

const engineFor = t => { const e = loadEngine(); t.after(() => e.dispose()); return e; };

async function settle() {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

/* Kick the virtual clock in rounds until a flow promise settles. */
async function kickoff(engine, flowPromise) {
  for (let i = 0; i < 30; i++) {
    const done = await Promise.race([flowPromise.then(() => true), Promise.resolve(false)]);
    if (done) break;
    engine.clock.advance(250);
    await settle();
  }
  await flowPromise;
  await settle();
}

const invites = (engine, i, type) => engine.acc.Net.conns[i].sent.filter(m => m.t === type);

/* ================= MP-01 — seat identity after the shuffle ================= */
test('MP-01 the seated order and the connection array agree on every seat', async t => {
  const engine = engineFor(t);
  const Net = engine.acc.Net;
  for (const n of [2, 4, 8]) {
    const S = await makeGame(engine, n);
    assert.equal(Net.myIdx, 0, 'host seat is consistent across attempts');
    assert.equal(Net.conns[0], null, 'the host holds no connection to itself');
    for (let i = 0; i < n; i++) {
      const c = Net.conns[i];
      if (c) {
        assert.equal(c.__playerId, Net.roster[i].playerId, `seat ${i}: connection belongs to its roster identity`);
        assert.equal(c.open, true, `seat ${i} connection is open`);
      } else {
        assert.equal(Net.myIdx, i, 'only the host seat is connection-less');
      }
      assert.equal(S.players[i].name, Net.roster[i].name, `seat ${i}: state and roster agree`);
    }
    const pids = Net.roster.map(e => e.playerId);
    assert.equal(new Set(pids).size, n, 'all playerIds unique');
  }
});

test('MP-01b repeated shuffles always keep conn/roster/state aligned per seat', async t => {
  const engine = engineFor(t);
  const Net = engine.acc.Net;
  Net.role = 'host'; Net.myIdx = 0; Net.goal = 100; Net.lobbyChat = [];
  const conns = [null, makeConn(engine, 'pidA'), makeConn(engine, 'pidB')];
  const roster = [
    { name: 'Host', playerId: 'pidH', conn: null, char: 'markwatson' },
    { name: 'A', playerId: 'pidA', conn: conns[1], char: 'tomkins' },
    { name: 'B', playerId: 'pidB', conn: conns[2], char: 'jimchalmers' },
  ];
  for (const seed of [7, 21, 99, 123]) {
    Net.roster = roster.map(e => ({ ...e }));
    Net.conns = conns.slice();
    withSeed(seed, () => engine.f.initGame(roster.map(e => ({ name: e.name, char: e.char }))));
    await settle();
    await settle();
    const S = engine.acc.S;
    for (let i = 0; i < 3; i++) {
      const c = Net.conns[i];
      if (c) {
        assert.equal(c.__playerId, Net.roster[i].playerId, `seed ${seed} seat ${i}: conn matches roster identity`);
        assert.equal(S.players[i].name, Net.roster[i].name, `seed ${seed} seat ${i}: state name matches roster`);
      } else {
        assert.equal(Net.myIdx, i, `seed ${seed}: the conn-less seat is the host`);
      }
    }
  }
});

/* ================= MP-02 — broadcast fanout ================= */
test('MP-02 broadcasts reach every open guest exactly once and skip the host and closed conns', async t => {
  const engine = engineFor(t);
  const Net = engine.acc.Net;
  const S = await makeGame(engine, 4);
  assert.equal(Net.conns[Net.myIdx], null, 'the host holds no connection — state pushes are guests-only');
  const states = i => engine.acc.Net.conns[i].sent.filter(m => m.t === 'state').length;
  const baseline = [0, 1, 2, 3].map(i => (Net.conns[i] ? states(i) : 0));
  engine.f.flushState(); // one coalesced push
  for (let i = 0; i < 4; i++) {
    if (i === Net.myIdx) continue;
    assert.equal(states(i), baseline[i] + 1, `guest ${i} got exactly one state push`);
  }
  // A closed connection is detached and receives nothing further.
  const c3 = engine.acc.Net.conns[3];
  engine.f.onHostClose(c3);
  await settle();
  assert.equal(Net.conns[3], null, 'the closed conn is detached');
  engine.f.flushState();
  assert.equal(c3.sent.filter(m => m.t === 'state').length, baseline[3] + 1, 'no further pushes after the drop');
});

/* ================= MP-03 — private prompt isolation ================= */
test('MP-03 a private prompt reaches only its recipient, and only the right seat can answer', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 3, { autoAnswer: false });
  const target = 2, other = 1;
  const opt = { title: 'SECRET BRIEFING', body: 'pick one', options: [{ label: 'A', v: 'a' }, { label: 'B', v: 'b' }], def: 'a' };
  const p = engine.f.askPlayer(target, opt);
  await settle();
  assert.ok(invites(engine, target, 'prompt').some(m => m.title === 'SECRET BRIEFING'), 'recipient got the prompt');
  assert.equal(invites(engine, other, 'prompt').length, 0, 'other guests saw nothing');
  assert.equal(engine.acc.Net.pendingPrompts.size, 1, 'host tracks the pending prompt');

  const prompt = invites(engine, target, 'prompt')[0];
  // Wrong seat answers: ignored.
  engine.f.onHostData(engine.acc.Net.conns[other], { t: 'answer', pid: prompt.pid, v: 'b' });
  await settle();
  assert.equal(engine.acc.Net.pendingPrompts.size, 1, 'wrong-seat answer did not resolve');
  // Wrong pid: ignored without touching the pending prompt.
  engine.f.onHostData(engine.acc.Net.conns[target], { t: 'answer', pid: 'zzz', v: 'b' });
  await settle();
  assert.equal(engine.acc.Net.pendingPrompts.size, 1);
  // Right seat and pid: resolves with the exact value, the entry is gone.
  let answered = null;
  p.then(v => { answered = v; });
  engine.f.onHostData(engine.acc.Net.conns[target], { t: 'answer', pid: prompt.pid, v: 'b' });
  await settle();
  assert.equal(answered, 'b', 'the exact answer was delivered once');
  assert.equal(engine.acc.Net.pendingPrompts.size, 0, 'prompt cleaned up');
  // A duplicate replay of the same answer must not resolve anything new.
  engine.f.onHostData(engine.acc.Net.conns[target], { t: 'answer', pid: prompt.pid, v: 'b' });
  await settle();
  assert.equal(answered, 'b', 'the promise is settled exactly once');
});

/* ================= MP-04 — state convergence ================= */
test('MP-04 after any host action every guest converges on the same public state', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 4);
  S.cur = 1; S.phase = 'move'; S.steps = 3;
  const target = [...engine.acc.ADJ[S.players[1].pos]][0];
  engine.f.onHostData(engine.acc.Net.conns[1], { t: 'intent', act: 'move', id: target });
  await settle();
  engine.f.flushState(); // force the coalesced push now
  const last = i => invites(engine, i, 'state').at(-1);
  const payload = JSON.stringify(last(1).s);
  for (let i = 0; i < 4; i++) {
    if (i === engine.acc.Net.myIdx) continue;
    assert.equal(JSON.stringify(last(i).s), payload, `seat ${i} mirrors the same state`);
  }
  assert.equal(last(1).s.players[1].pos, target, 'the move is on the wire');
});

/* ================= MP-05 — duplicate and delayed messages ================= */
test('MP-05 duplicate/replayed messages from dead connections cannot corrupt the game', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 2);
  S.cur = 1; S.phase = 'move'; S.steps = 3;
  const target = [...engine.acc.ADJ[S.players[1].pos]][0];

  // A duplicated legal move: the replay is rejected (you cannot "move" to the
  // node you are standing on) — no crash, no double consumption, no jam.
  const c1 = engine.acc.Net.conns[1];
  engine.f.onHostData(c1, { t: 'intent', act: 'move', id: target });
  await settle();
  engine.f.onHostData(c1, { t: 'intent', act: 'move', id: target });
  await settle();
  assert.equal(S.players[1].pos, target, 'the first move applied once');
  assert.equal(S.steps, 2, 'the duplicate did not consume a second step');
  assert.ok(engine.acc.Net.conns[1].sent.some(m => m.t === 'sys' && m.msg.includes('red threads')),
    'the actor was told the move is illegal');
  assert.equal(engine.acc.Net.lock, false, 'no lock jam after a duplicate intent');

  // An intent replayed from a replaced/dead connection handle is rejected by
  // the seat check and cannot corrupt anything.
  S.cur = 0; S.phase = 'action';
  S.players[0].pos = 'infl';
  S.players[0].money = 20;
  const goneConn = makeConn(engine, 'late', { open: true });
  const moneyBefore = S.players.map(p => p.money);
  engine.acc.Net.conns[1] = goneConn; // simulate the host-side array holding a dead handle
  assert.doesNotThrow(() => engine.f.onHostData(goneConn, { t: 'intent', act: 'seize' }));
  await settle();
  assert.equal(S.owner.infl, undefined, 'the stale seize never took ownership');
  assert.ok(goneConn.sent.some(m => m.t === 'sys' && m.msg.includes('Not your turn')),
    'the stale actor was told off on the wire');
  // A truly detached conn is invisible to intents (it has no seat index at all).
  const ghost = makeConn(engine, 'ghost', { open: true });
  assert.equal(engine.acc.Net.conns.indexOf(ghost), -1, 'unknown conn has no seat');
  assert.doesNotThrow(() => engine.f.onHostData(ghost, { t: 'intent', act: 'move', id: 'oil' }));
  await settle();
  assert.equal(S.players.map(p => p.money).every((m, i) => m === moneyBefore[i]), true,
    'no charges from stale or ghost intents');
  assert.equal(engine.consoleOut.error.length, 0, `no engine errors: ${JSON.stringify(engine.consoleOut.error)}`);
});

/* ================= MP-06 — invalid client input ================= */
test('MP-06 invalid client input is rejected without crashing, mutating or locking', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 2, { autoAnswer: false });
  S.cur = 1; S.phase = 'move'; S.steps = 3;
  const c1 = engine.acc.Net.conns[1];
  const snap = () => JSON.stringify({
    pos: S.players[1].pos, steps: S.steps, phase: S.phase, over: S.over,
    money: S.players.map(p => p.money), intel: S.players.map(p => p.intel),
    owner: S.owner, seize: S.seizeCount, bugs: S.bugs,
  });
  const before = snap();

  for (const bad of [
    null, {}, { t: 'bogus' }, { t: 'intent' }, { t: 'intent', act: 'unknown-act' },
    { t: 'intent', act: 'move', id: 'not-a-node' },   // unknown node id
    { t: 'intent', act: 'seize', mode: 'explodes' },  // absurd fields are not routes
    { t: 'pick', char: 'not-a-character' },           // invalid face
    { t: 'answer', pid: 'zzz', v: 1 },                // unknown prompt id
    { t: 'ack', eid: 'nope' },                        // stale ack
    { t: 'chat', text: '🦄'.repeat(200) },            // oversized chat — clamped
  ]) {
    assert.doesNotThrow(() => engine.f.onHostData(c1, bad), `bad payload ${JSON.stringify(bad)}`);
  }
  assert.equal(engine.consoleOut.error.length, 0, `no engine crashes: ${JSON.stringify(engine.consoleOut.error)}`);
  assert.equal(engine.acc.Net.lock, false, 'no stuck lock');
  assert.equal(engine.acc.Net.pendingPrompts.size, 0, 'no leaked prompts');
  // The only allowed change is the clamped chat entry — everything else is frozen.
  assert.equal(snap(), before, 'no game-state mutation from any bad payload');
  const lastChat = S.chat.at(-1);
  assert.ok(lastChat && lastChat.t.length <= 140, 'oversized chat was clamped to 140 chars');
});

/* ================= DC-01 — disconnect during movement ================= */
test('DC-01 the away seat finishes its turn exactly once, and the seat can be reclaimed', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 2);
  S.deck = ['quiet', 'quiet']; S.discard = [];
  S.cur = 1; S.phase = 'move'; S.steps = 3;
  const target = [...engine.acc.ADJ[S.players[1].pos]][0];
  // One movement first, then the wire dies.
  engine.f.onHostData(engine.acc.Net.conns[1], { t: 'intent', act: 'move', id: target });
  await settle();
  const movedTo = S.players[1].pos;
  engine.f.onHostClose(engine.acc.Net.conns[1]);
  await settle();
  assert.equal(S.players[1].dc, true, 'the seat is held');
  assert.ok(S.log.some(l => l.includes('lost connection')), 'the table saw the drop');
  // The watchdog fires after 20s once and only once.
  engine.clock.advance(20000);
  await settle();
  engine.clock.advance(20000);
  await settle();
  assert.equal(S.log.filter(l => l.includes('plays it quiet')).length, 1, 'the away turn completes exactly once');
  assert.equal(S.turn, 2, 'the round advanced exactly one turn');
  assert.equal(S.cur, 0, 'the active seat moved back to the host');
  assert.equal(S.players[1].pos, movedTo, 'the away player keeps their position');

  // Reclaim with the same displayed name from a NEW connection & new identity.
  const back = makeConn(engine, 'pid1-new', {});
  engine.f.handleHello(back, 'Player 2', 'pid1-new');
  await settle();
  const welcomes = back.sent.filter(m => m.t === 'welcome');
  assert.equal(welcomes.length, 1, 'the reclaiming client got a welcome with the full state');
  assert.equal(welcomes[0].idx, 1);
  assert.equal(S.players[1].dc, false, 'the seat is live again');
  assert.equal(engine.acc.Net.conns[1], back, 'the new conn is wired to the seat');
  // The watchdog was cleared on reclaim: no further quiet turns.
  engine.clock.advance(30000);
  await settle();
  assert.equal(S.log.filter(l => l.includes('plays it quiet')).length, 1, 'reclaim cancels the away watchdog');

  // A fresh drop (new conn, same seat) brings exactly one more quiet turn.
  S.cur = 1;
  engine.f.onHostClose(engine.acc.Net.conns[1]);
  await settle();
  engine.clock.advance(20000);
  await settle();
  assert.equal(S.log.filter(l => l.includes('plays it quiet')).length, 2, 'a fresh drop brings one more quiet turn');
});

/* ================= DC-02 — disconnect during a private choice ================= */
test('DC-02 a drop during a pending prompt applies the default once and the game advances', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 3);
  S.deck = ['quiet', 'quiet']; S.discard = [];
  S.owner.jt = 1; // guest 1 holds the JTPortal — endOfTurn will ask privately
  S.cur = 2; S.phase = 'move';
  const flow = engine.f.endOfTurn();
  await settle(); // the prompt is now pending
  assert.equal(engine.acc.Net.pendingPrompts.size, 1, 'the private choice is pending');
  const pidBefore = [...engine.acc.Net.pendingPrompts.keys()][0];
  engine.f.onHostClose(engine.acc.Net.conns[1]);
  await settle();
  assert.equal(engine.acc.Net.pendingPrompts.size, 0, 'the prompt was cleaned up');
  await kickoff(engine, flow);
  assert.equal(S.discard.length, 1, 'the event still ran (the default was applied once)');
  assert.equal(engine.modalRec.filter(m => m.title.startsWith('MARKET EVENT')).length, 1, 'exactly one event');
  assert.equal(S.jtUsed, false, 'the seat never chose to cancel');
  assert.ok(![...engine.acc.Net.pendingPrompts.keys()].includes(pidBefore), 'no stale prompt id');
});

/* ================= DC-03 — reconnect around prompts ================= */
test('DC-03 reclaiming a seat replays nothing; the defaulted prompt cannot resolve twice', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 2);
  S.deck = ['quiet', 'quiet']; S.discard = [];
  S.cur = 1; S.phase = 'move';
  const promptP = engine.f.askPlayer(1, { title: 'CHOOSE FAST', options: [{ label: 'Yes', v: 1 }, { label: 'No', v: 0 }], def: 0, timeout: 15000 });
  await settle();
  assert.equal(engine.acc.Net.pendingPrompts.size, 1);
  const pid = invites(engine, 1, 'prompt')[0].pid;
  const firstConn = engine.acc.Net.conns[1];
  // The old connection dies without answering…
  engine.f.onHostClose(firstConn);
  await settle();
  assert.equal(engine.acc.Net.pendingPrompts.size, 0, 'default applied on drop');
  assert.equal(await promptP, 0, 'the default was resolved exactly once');
  // …and its late answer replays nothing into the (now empty) registry.
  engine.f.onHostData(firstConn, { t: 'answer', pid, v: 1 });
  await settle();
  assert.equal(engine.acc.Net.pendingPrompts.size, 0);
  // Reconnection reissues NO prompt for the already-defaulted decision.
  const again = makeConn(engine, 'pid1-again', { autoAnswer: true });
  engine.f.handleHello(again, 'Player 2', 'pid1-again');
  await settle();
  assert.equal(again.sent.filter(m => m.t === 'prompt').length, 0, 'no re-issued prompt');
  assert.equal(again.sent.some(m => m.t === 'welcome'), true, 'the reclaim still gets its welcome');
});

/* ================= DC-04 — disconnect during an announcement ================= */
test('DC-04 announcements and event resolution complete without the closed client', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 3);
  S.deck = ['quiet', 'quiet']; S.discard = [];
  const departing = engine.acc.Net.conns[1];
  engine.f.onHostClose(departing);
  await settle();
  S.cur = 2; S.phase = 'move';
  await kickoff(engine, engine.f.endOfTurn());
  assert.equal(engine.modalRec.filter(m => m.title.startsWith('MARKET EVENT')).length, 1,
    'the table announcement went out');
  assert.equal(S.discard.length, 1, 'the event resolved');
  assert.equal(departing.sent.filter(m => m.t === 'event').length, 0, 'the departed client received nothing');
  assert.equal(S.cur, 0, 'the round moved on');
});

/* ================= DC-05 — host migration ================= */
test('DC-05 the current design has no host migration',
  { skip: 'host migration is explicitly unimplemented; the plan records the documented behaviour only' },
  () => {});

/* ================= DC-06 — cleanup after disconnects ================= */
test('DC-06 after the disconnect/reconnect gauntlet nothing is leaked', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 3);
  S.deck = ['quiet', 'quiet']; S.discard = [];
  // prompt + drop mid-air
  const p = engine.f.askPlayer(2, { title: 'HOLD ON', options: [{ label: 'A', v: 1 }], def: 0, timeout: 15000 });
  await settle();
  engine.f.onHostClose(engine.acc.Net.conns[2]);
  await settle();
  assert.equal(await p, 0, 'the dropped prompt defaulted exactly once');
  // an ack from a departed conn must not wedge the reveal gate
  engine.f.onHostClose(engine.acc.Net.conns[1]);
  await settle();
  S.cur = 0; S.phase = 'move';
  await kickoff(engine, engine.f.endOfTurn());
  const Net = engine.acc.Net;
  assert.equal(Net.pendingPrompts.size, 0, 'prompt registry is clean');
  assert.equal(Net.lock, false, 'no stuck action lock');
  assert.ok(!Net.acks, 'no leaked ack gate');
  assert.equal(engine.consoleOut.error.length, 0, `no engine errors: ${JSON.stringify(engine.consoleOut.error)}`);
  engine.clock.advance(90000); // any remaining one-shot timers (stale-lock watchdog, prompt timeouts) resolve harmlessly
  await settle();
  assert.equal(Net.pendingPrompts.size, 0, 'still clean after the clock spun out');
});
