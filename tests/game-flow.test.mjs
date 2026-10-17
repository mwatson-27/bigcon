/*
 * Core game flow — section 1 (CF-01..CF-09) of docs/CODE_LEVEL_TEST_PLAN.md.
 * Starts (solo + multiplayer), movement, seizure and its failure modes, turn
 * completion with income, event draws and resolution, and the win path.
 *
 * Boards/games are seeded (makeGame default seed 42) so every assertion is
 * deterministic regardless of test order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, makeGame, makeConn } from './helpers/harness.mjs';

const engineFor = t => { const e = loadEngine(); t.after(() => e.dispose()); return e; };

/* Drive intents from a guest exactly the way the wire does. */
function guestIntent(engine, pi, act, extra = {}) {
  const c = engine.acc.Net.conns[pi];
  assert.ok(c && c.open, `guest ${pi} has an open connection`);
  engine.f.onHostData(c, { t: 'intent', act, ...extra });
}

async function settle() {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

/* Kick the virtual clock in rounds until a flow promise settles — timers nested
   behind awaits are only scheduled after earlier microtasks drain. */
async function kickoff(engine, flowPromise) {
  for (let i = 0; i < 8; i++) {
    const done = await Promise.race([flowPromise.then(() => true), Promise.resolve(false)]);
    if (done) break;
    engine.clock.advance(4);
    await settle();
  }
  await flowPromise;
  await settle();
}

/* Kick the virtual clock a little, then let the awaited flow finish. */
async function finish(engine, flowPromise) {
  engine.clock.advance(4);
  await flowPromise;
  await settle();
}

const beginMsgs = (engine, i) => engine.acc.Net.conns[i].sent.filter(m => m.t === 'begin');

/* ================= CF-01 / CF-02 — starting games ================= */
test('CF-01 a solo test game starts without any remote connection and holds a valid state', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 1);
  assert.ok(S);
  assert.equal(S.players.length, 1);
  assert.equal(S.cur, 0);
  assert.equal(S.phase, 'move');
  assert.ok(S.steps >= 3, `base steps: ${S.steps}`);
  assert.equal(S.turn, 1);
  assert.equal(S.boardLayout.length, engine.acc.NODES.length, 'a full random board was dealt');
  assert.equal(engine.modalRec.length, 0, 'solo start raises no announcements');
  assert.equal(engine.consoleOut.error.length, 0, 'no engine errors');

  // The lobby itself reports the solo mode once everyone picked a face.
  const Net = engine.acc.Net;
  Net.started = false;
  Net.begun = false;
  Net.roster = [{ name: 'Solo', playerId: 'p0', conn: null, char: 'markwatson' }];
  Net.conns = [null];
  Net.lobbyChat = [];
  engine.f.broadcastLobby();
  assert.equal(engine.elems.get('btnStart').__assigned_onclick, true, 'start button wired');
  assert.equal(engine.elems.get('btnStart').__assigned_onclick | 0, 1);
});

for (const n of [2, 4]) {
  test(`CF-02 a ${n}-player game starts host-authoritatively with per-seat begin payloads`, async t => {
    const engine = engineFor(t);
    const S = await makeGame(engine, n);
    assert.ok(engine.acc.Net.started, `Net.started with ${n} players`);
    const conns = engine.acc.Net.conns;
    assert.equal(conns.filter(Boolean).length, n - 1, 'one host + n-1 connections');
    const ids = new Set(engine.acc.Net.roster.map(e => e.playerId));
    assert.equal(ids.size, n, 'identities are unique (one seat per player identity)');
    assert.equal(S.players.length, n);
    // Every guest received one begin payload whose seat index matches it.
    for (let i = 0; i < n; i++) {
      if (i === engine.acc.Net.myIdx) continue;
      const begins = beginMsgs(engine, i);
      assert.equal(begins.length, 1, `guest ${i} got exactly one begin`);
      assert.equal(begins[0].idx, i);
      assert.equal(begins[0].s.players[i].name, engine.acc.Net.roster[i].name);
      assert.equal(begins[0].s.boardLayout.length, engine.acc.NODES.length, 'the dealt board is complete');
      assert.equal(begins[0].s.boardEdges.length, engine.acc.EDGES.length, 'the wire carries the dealt edges');
    }
    // The shared payload is identical for every seat.
    const payloads = [];
    for (let i = 0; i < n; i++) { const m = conns[i] && beginMsgs(engine, i)[0]; if (m) payloads.push(m.s); }
    const one = JSON.stringify(payloads[0]);
    payloads.forEach(p => assert.equal(JSON.stringify(p), one, 'identical begin state across seats'));
  });
}

/* ================= CF-03 / CF-04 — movement ================= */
async function fresh2p(t) {
  const engine = engineFor(t);
  await makeGame(engine, 2);
  return engine;
}

test('CF-03 legal movement consumes exactly one step and keeps the graph in sync', async t => {
  const engine = await fresh2p(t);
  const S = engine.acc.S;
  S.cur = engine.acc.Net.myIdx; // host's turn
  S.phase = 'move';
  S.steps = 3;
  const start = S.players[0].pos; // quik
  const target = [...engine.acc.ADJ[start]][0];
  await engine.f.applyIntent(0, { act: 'move', id: target });
  await settle();
  assert.equal(S.players[0].pos, target, 'position updated once');
  assert.equal(S.steps, 2, 'exactly one step was consumed');
  assert.equal(S.phase, 'move', 'moves continue while steps remain');

  // Burn the remaining steps: hop out and back; the final move ends the phase.
  S.players[0].pos = start;
  S.phase = 'move';
  S.steps = 2;
  await engine.f.applyIntent(0, { act: 'move', id: target });
  await settle();
  assert.equal(S.players[0].pos, target);
  await engine.f.applyIntent(0, { act: 'move', id: start }); // threads are two-way
  await settle();
  assert.equal(S.players[0].pos, start);
  await engine.f.applyIntent(0, { act: 'move', id: target });
  await settle();
  assert.equal(S.steps, 0);
  assert.equal(S.phase, 'action', 'out of steps → action phase');
});

test('CF-04 illegal movement and stale intents mutate nothing and never jam the action lock', async t => {
  const engine = await fresh2p(t);
  const S = engine.acc.S;
  S.cur = engine.acc.Net.myIdx;
  const here = S.players[0].pos;
  const neighbour = [...engine.acc.ADJ[here]][0];

  // Non-adjacent destination: rejected with a visible message to the actor.
  const farNode = engine.acc.NODES.map(n => n.id).find(id => id !== here && !(engine.acc.ADJ[here] || []).includes(id));
  S.phase = 'move';
  S.steps = 3;
  await engine.f.applyIntent(0, { act: 'move', id: farNode });
  await settle();
  assert.equal(S.players[0].pos, here, 'position unchanged');
  assert.equal(S.steps, 3, 'no step was consumed');
  assert.ok(engine.elems.get('toast').textContent.includes('red threads'),
    `toast: ${engine.elems.get('toast').textContent}`);

  // Zero steps: silently rejected.
  S.steps = 0;
  await engine.f.applyIntent(0, { act: 'move', id: neighbour });
  await settle();
  assert.equal(S.steps, 0);
  assert.equal(S.players[0].pos, here);

  // Wrong phase: a move intent during the action phase is a no-op.
  S.phase = 'action';
  S.steps = 3;
  await engine.f.applyIntent(0, { act: 'move', id: neighbour });
  await settle();
  assert.equal(S.phase, 'action');
  assert.equal(S.steps, 3);
  assert.equal(S.players[0].pos, here);

  // A stale intent from a non-current player is bounced back to that guest.
  S.phase = 'move';
  guestIntent(engine, 1, 'favor');
  await settle();
  const sysMsgs = engine.acc.Net.conns[1].sent.filter(m => m.t === 'sys');
  assert.ok(sysMsgs.some(m => m.msg.includes('Not your turn')), `rejection sent: ${JSON.stringify(sysMsgs)}`);
  assert.equal(engine.acc.Net.lock, false, 'the action lock is free');

  // Unknown action name: rejected without crashing or mutating.
  const snap = JSON.stringify({ pos: S.players[0].pos, steps: S.steps, phase: S.phase });
  await engine.f.applyIntent(0, { act: 'hover-board', id: farNode });
  await settle();
  assert.equal(JSON.stringify({ pos: S.players[0].pos, steps: S.steps, phase: S.phase }), snap);
  assert.equal(engine.acc.Net.lock, false);
  assert.equal(engine.consoleOut.error.length, 0, `no crashes: ${JSON.stringify(engine.consoleOut.error)}`);
});

/* ================= CF-05 / CF-06 — seizure ================= */
test('CF-05 seizing an available node takes ownership, charges once and hands the turn on', async t => {
  const engine = await fresh2p(t);
  const S = engine.acc.S;
  S.deck = ['quiet']; S.discard = [];
  delete S.owner.infl;
  S.cur = engine.acc.Net.myIdx;
  S.phase = 'action';
  S.mode = null;
  S.steps = 0;
  S.players[0].money = 20;
  S.players[0].pos = 'infl'; // list price $3
  const before = JSON.stringify(S.players);
  await engine.f.applyIntent(0, { act: 'seize' });
  await settle();
  assert.equal(S.owner.infl, engine.acc.Net.myIdx, 'ownership changed once');
  assert.equal(S.players[0].money, 20 - 3 + 2, `seize $3 then the single quiet-quarter event +$2 (was ${before})`);
  assert.equal(S.seizeCount.infl, 1, 'the seizure count advances');
  assert.equal(engine.modalRec.filter(m => m.title.startsWith('MARKET EVENT')).length, 1,
    'exactly one market event announced');
});

test('CF-06 seizure failure cases never charge, mutate or jam the lock', async t => {
  const engine = await fresh2p(t);
  const S = engine.acc.S;
  S.cur = engine.acc.Net.myIdx;

  // Insufficient funds: rejected with a message, no ownership change.
  S.phase = 'action';
  S.players[0].money = 1;
  S.players[0].pos = 'oil'; // costs $12 — out of reach
  await engine.f.applyIntent(0, { act: 'seize' });
  await settle();
  assert.equal(S.owner.oil, undefined);
  assert.equal(S.players[0].money, 1);
  assert.ok(engine.elems.get('toast').textContent.includes("can't afford"),
    `toast: ${engine.elems.get('toast').textContent}`);

  // Already own it: a silent no-op (no charge, no event turn).
  S.players[0].money = 50;
  S.owner.infl = engine.acc.Net.myIdx;
  S.players[0].pos = 'infl';
  const modalCount = engine.modalRec.filter(m => m.title.startsWith('MARKET EVENT')).length;
  await engine.f.applyIntent(0, { act: 'seize' });
  await settle();
  assert.equal(S.owner.infl, engine.acc.Net.myIdx);
  assert.equal(S.players[0].money, 50);
  assert.equal(engine.modalRec.filter(m => m.title.startsWith('MARKET EVENT')).length, modalCount,
    'no end-of-turn was triggered by the no-op');

  // Wrong phase: seized intent during movement is a no-op.
  S.phase = 'move';
  S.players[0].pos = 'oil';
  await engine.f.applyIntent(0, { act: 'seize' });
  await settle();
  assert.equal(S.owner.oil, undefined);
  assert.equal(S.phase, 'move');

  // Duplicate submission while a request is resolving: bounced off the lock.
  // money $2 + BACKROOM DEALS and 2 Intel make the $3 node affordable only
  // through the shortfall prompt, which we hold open to keep the lock engaged.
  S.phase = 'action';
  delete S.owner.infl;
  S.owner.back = 0; // the shortfall prompt exists when Intel can cover it
  S.players[0].money = 2;
  S.players[0].intel = 2;
  S.players[0].pos = 'infl';
  engine.holdModal();
  const first = engine.f.applyIntent(0, { act: 'seize' });
  await settle();
  assert.equal(engine.acc.Net.lock, true, 'first request is in flight');
  await engine.f.applyIntent(0, { act: 'seize' }); // duplicate must bounce off the lock
  await settle();
  assert.ok(engine.elems.get('toast').textContent.includes('previous action'),
    `duplicate rejected: ${engine.elems.get('toast').textContent}`);
  assert.equal(S.players[0].intel, 2, 'duplicate paid nothing');
  engine.releaseModal(0); // 'Walk away' — reject the backroom-deal shortfall offer
  await first;
  await settle();
  assert.equal(engine.acc.Net.lock, false, 'the lock releases when the request resolves');
  assert.equal(S.owner.infl, undefined, 'nothing was seized');
  assert.equal(S.players[0].money, 2, 'no partial charge');
  assert.equal(S.players[0].intel, 2);

  // The shortfall prompt path itself: accept it and the deal goes through with
  // Intel covering the gap.
  S.deck = ['quiet']; S.discard = [];
  engine.holdModal();
  const second = engine.f.applyIntent(0, { act: 'seize' });
  await settle();
  engine.releaseModal(1); // 'Pay $2 + 1 🛈'
  await second;
  await settle();
  assert.equal(S.owner.infl, engine.acc.Net.myIdx, 'the backroom deal completed the seizure');
  assert.equal(S.players[0].intel, 1, '1 Intel covered the $1 shortfall');
  // $0 after the deal; the automatic quiet-quarter event then pays +$2.
  assert.equal(S.players[0].money, 2, 'cash covered the deal, then the quarter paid out');

  // Malformed payloads through the wire are dropped without crashing or mutating.
  // (Delivered from a real seat: a 2-player game cannot have a seat index it
  // does not have — applyIntent would crash out-of-range, which the wire can
  // never produce because conns and players are length-matched.)
  const snap = JSON.stringify({ pos: S.players[0].pos, steps: S.steps, phase: S.phase, over: S.over });
  const fuzzConn = makeConn(engine, 'fuzz', { open: true, autoAnswer: false });
  engine.acc.Net.conns[1] = fuzzConn; // stand in for guest seat 1
  S.cur = 1; // the fuzz client IS the active seat so deeper validation runs
  engine.f.sync();
  for (const bad of [null, {}, { t: 'bogus' }, { t: 'intent' }, { t: 'intent', act: 'move', id: 'not-a-node' },
    { t: 'answer', pid: 'zzz', v: 1 }, { t: 'ack', eid: 'zzz' }]) {
    assert.doesNotThrow(() => engine.f.onHostData(fuzzConn, bad), `bad payload ${JSON.stringify(bad)}`);
    assert.equal(JSON.stringify({ pos: S.players[0].pos, steps: S.steps, phase: S.phase, over: S.over }), snap,
      `no mutation for ${JSON.stringify(bad)}`);
  }

  // The action lock recovers: a legal action still succeeds afterwards.
  S.cur = engine.acc.Net.myIdx;
  S.phase = 'action';
  delete S.owner.infl;
  S.players[0].money = 20;
  S.players[0].pos = 'infl';
  S.deck = ['quiet']; S.discard = [];
  await engine.f.applyIntent(0, { act: 'seize' });
  await settle();
  assert.equal(S.owner.infl, engine.acc.Net.myIdx, 'the next legal request works');
});

test('CF-06b a hostile takeover pays list price to the victim and doubles the taker cost', async t => {
  const engine = await fresh2p(t);
  const S = engine.acc.S;
  S.cur = engine.acc.Net.myIdx;
  S.phase = 'action';
  S.deck = ['quiet']; S.discard = [];
  const victim = engine.acc.Net.myIdx === 0 ? 1 : 0;
  S.owner = { infl: victim, citi: 0, commbank: 0, accc: victim };
  S.seizeCount = { infl: 1 }; // seized once already → first takeover costs 2× list
  S.players[0].money = 30;
  S.players[victim].money = 10;
  S.players[0].pos = 'infl'; // list price $3
  const taker = engine.acc.Net.myIdx;
  await engine.f.applyIntent(taker, { act: 'seize' });
  await settle(); // endOfTurn continues: quiet event +2 each, then P2's next-turn income
  assert.equal(S.owner.infl, taker);
  assert.equal(S.players[taker].money, 30 - 6 - 2 + 2, '$6 (2× list $3) + $2 ACCC fee, then the quiet quarter +$2');
  assert.equal(S.players[victim].money, 10 + 3 + 2 + 2 + 4, 'victim: list $3 + fee $2 + quiet $2 + next-turn income $4');
  assert.equal(S.players[taker].cortisol, 2, 'hostile takeover: +2 Cortisol');
  assert.equal(S.seizeCount.infl, 2);
  assert.ok(S.log.some(l => l.includes('pockets a $3 buyout')), 'the buyout is on the record');
  assert.ok(S.log.some(l => l.includes('ACCC review fee')), 'the ACCC fee is on the record');
});

/* ================= CF-07 — full rounds ================= */
for (const n of [2, 4]) {
  test(`CF-07 a full ${n}-player round: exactly one turn and one income each, one event after each turn`, async t => {
    const engine = engineFor(t);
    const S = await makeGame(engine, n);
    S.deck = Array.from({ length: n + 4 }, () => 'quiet');
    S.discard = [];
    const money = S.players.map(p => p.money);
    for (let i = 0; i < n; i++) {
      await engine.f.endOfTurn();
      await settle();
    }
    // endOfTurn immediately starts the next player's turn, so the n-th call has
    // already opened the FOLLOWING turn of player 0 (turn 2, income +3 again).
    assert.equal(S.turn, 2, 'the counter advanced after the round wrapped');
    for (let pi = 0; pi < n; pi++) {
      const name = S.players[pi].name;
      const turns = S.log.filter(l => l.startsWith('—— TURN 1 ·') && l.includes(name)).length;
      assert.equal(turns, 1, `${name} took exactly one turn`);
    }
    assert.equal(S.log.filter(l => l.startsWith('—— TURN 1 ·')).length, n, 'one turn log line per player');
    // Income is one $3 salary per started turn; the money snapshot already
    // includes the initial startTurn income, and one quiet-quarter event fires
    // after every turn of the round (+$2 each time, for everyone).
    for (let pi = 0; pi < n; pi++) {
      assert.equal(
        S.players[pi].money - money[pi],
        3 + 2 * n,
        `player ${pi} took one turn and banked every quiet quarter (${money[pi]} → ${S.players[pi].money})`);
    }
  });
}

/* ================= CF-08 — event draws and resolution ================= */
test('CF-08 exactly one event card is consumed per turn; choice cards honor the owner\'s pick', async t => {
  const engine = await fresh2p(t);
  const S = engine.acc.S;
  const pressOwner = engine.acc.Net.myIdx === 0 ? 1 : 0; // always a guest
  const rivals = [0, 1].filter(i => i !== pressOwner);
  const target = rivals[0];

  // Choice card: the PRESS ROOM owner torches a rival (+2 Cortisol).
  S.owner.press = pressOwner;
  // Give BOTH players ≥2 nodes so the torch (+2 Cortisol) sticks past the
  // current ownership-protection quirk no matter which rival was picked.
  S.owner.citi = 0; S.owner.commbank = 0;
  S.owner.westpac = 1; S.owner.anz = 1;
  S.deck = ['frenzy']; S.discard = [];
  const pressConn = engine.acc.Net.conns[pressOwner];
  pressConn.answers = [target]; // the press owner auto-picks the lowest-indexed rival
  await kickoff(engine, engine.f.endOfTurn());
  assert.equal(S.deck.length, 0, 'exactly one card left the deck');
  assert.deepEqual([...S.discard], ['frenzy'], 'and went to the discard');
  assert.equal(S.mood, 'FRENZY', 'the mood moved');
  assert.equal(S.players[target].cortisol, 2, `the torched rival (${target}) took +2 Cortisol`);
  assert.equal(engine.modalRec.filter(m => m.title.startsWith('MARKET EVENT')).length, 1,
    'one announcement for the table');
  // Only the press-room owner saw the private prompt (seat-indexed accounting).
  const promptBySeat = engine.acc.Net.conns.map(c => (c ? c.sent.filter(m => m.t === 'prompt').length : -1));
  assert.ok(promptBySeat[pressOwner] > 0, 'the press owner was privately prompted');
  assert.equal(promptBySeat.filter(c => c > 0).length, 1, 'exactly one seat saw the private prompt');
});

test('CF-08b a harmless event applies its effect exactly once', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 2);
  S.deck = ['quiet']; S.discard = [];
  delete S.owner.press;
  const before = S.players.map(p => p.money);
  await engine.f.endOfTurn();
  await settle();
  // endOfTurn immediately opens the NEXT player's turn, whose income (+3)
  // lands on the new current seat; the quiet quarter pays $2 to everyone once.
  const payer = S.cur;
  const others = [0, 1].filter(i => i !== payer);
  assert.equal(S.players[payer].money, before[payer] + 2 + 3, `the new current seat also banked income (${payer})`);
  for (const i of others) assert.equal(S.players[i].money, before[i] + 2, `player ${i} gains exactly $2 once`);
  assert.equal(S.deck.length, 0);
  assert.equal(engine.modalRec.filter(m => m.title.startsWith('MARKET EVENT')).length, 1);
});

/* ================= CF-09 — win condition through the flow ================= */
test('CF-09 completing the con announces the winner to every seat and reloads the table', async t => {
  const engine = engineFor(t);
  const S = await makeGame(engine, 2);
  const goal = S.goal;
  S.players.forEach(p => { p.money = goal + 5; });
  // The current player holds the full set; the other seat does not — so the
  // winner is unambiguous even though both crossed the cash line.
  S.owner = { citi: S.cur, rba: S.cur, infl: S.cur, term: S.cur, coal: S.cur, oil: S.cur, press: S.cur };
  S.phase = 'action';
  S.deck = ['quiet'];
  await kickoff(engine, engine.f.endOfTurn());
  assert.equal(S.over, true, 'the game is over');
  assert.equal(S.phase, 'over');
  assert.ok(engine.modalRec.some(m => m.title.startsWith('🏆')), 'the winner modal was queued');
  for (let i = 0; i < 2; i++) {
    if (i === engine.acc.Net.myIdx) continue;
    assert.ok(engine.acc.Net.conns[i].sent.some(m => m.t === 'reload'), `seat ${i} was told to reload`);
  }
  engine.clock.advance(500);
  assert.equal(engine.location.reloadCount, 1, 'the host page reloads');
  const winLine = S.log.find(l => l.startsWith('🏆') && l.includes('banks $'));
  assert.ok(winLine && winLine.includes('The con is complete'), `the wire logs the payout: ${winLine}`);
});
