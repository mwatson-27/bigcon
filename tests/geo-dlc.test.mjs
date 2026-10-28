/*
 * 🌍 GEOGRAPHY DLC — section GD of docs/CODE_LEVEL_TEST_PLAN.md.
 *
 * Ten extra island exhibits, host-toggled in the lobby. The suite runs against
 * the same engine contract as the base game: rebuildWorld flips the node set,
 * applyIntent gains ten actions, startTurn/income gain passives.
 *
 * Behaviour tests use the controlled `quiet` deck (each event +$2 to every
 * player) exactly like rules-consistency: action ⇒ quiet (+2 both) ⇒ next
 * seat's startTurn (salary 3 + owned-node income), where the chain stops —
 * the next seat is left awaiting movement, so per action the rival collects
 * one quiet + one startTurn income and the actor only pays and takes quiet.
 * Flag resets live at startTurn, so each test re-arms deterministically.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadEngine, makeGame, makeConn, makeState, withSeed, bfs, SOURCE, repoRoot } from './helpers/harness.mjs';

const engineFor = t => { const e = loadEngine(); t.after(() => e.dispose()); return e; };
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));
}
const quietDeck = S => { S.deck = ['quiet', 'quiet', 'quiet', 'quiet']; S.discard = []; };
const armAction = engine => { const S = engine.acc.S; S.cur = 0; S.phase = 'action'; S.mode = null; };
/* Boots a host game with the DLC flag on and a quiet deck. Seat 0 = host. */
async function geoGame(t, n = 2) {
  const e = engineFor(t);
  const S = await makeGame(e, n, { geo: true });
  assert.equal(e.acc.Net.myIdx, 0);
  quietDeck(S);
  return { e, S: e.acc.S };
}

/* ================= GD-01 — the world rebuilds both ways ================= */
test('GD-01 rebuildWorld(false) mirrors the classic 70-exhibit world; (true) deals the DLC islands', t => {
  const e = engineFor(t);
  const acc = e.acc;
  assert.equal(acc.NODES.length, 70, 'the base world loads at 70');
  assert.equal(acc.WORLD_GEO, false);
  assert.ok(!acc.NMAP.geo_pillars, 'no DLC pins before the toggle');
  assert.equal(acc.HIGH_VALUE_NODE_IDS.has('geo_pillars'), false);

  e.f.rebuildWorld(true);
  assert.equal(acc.NODES.length, 80, '80 exhibits with the DLC on');
  assert.equal(acc.WORLD_GEO, true);
  for (const id of acc.GEO_NODE_IDS) assert.ok(acc.NMAP[id], `DLC pin dealt: ${id}`);
  for (const id of acc.GEO_HIGH_VALUE_IDS) assert.ok(acc.HIGH_VALUE_NODE_IDS.has(id), `${id} seeded far out`);
  const pairs = new Set(acc.EDGES.map(ed => [...ed].sort().join('|')));
  for (const [a, b] of acc.GEO_EDGES) {
    const key = [a, b].sort().join('|');
    assert.ok(pairs.has(key), `DLC edge ${key} present with the flag on`);
  }
  assert.equal(acc.WORLD_EDGES.length, acc.CLEAN_EDGES.length + acc.GEO_EDGES.length);

  e.f.rebuildWorld(false);
  assert.equal(acc.NODES.length, 70, 'the toggle backs the board down to 70');
  assert.equal(acc.WORLD_GEO, false);
  assert.ok(!acc.NMAP.geo_missile, 'the pins come back off');
  assert.equal(Object.keys(acc.NMAP).length, 70, 'NMAP rebuilt, not accumulated');
  assert.equal(acc.HIGH_VALUE_NODE_IDS.has('geo_pillars'), false, 'high-value set rebuilt, not accumulated');
});

test('GD-01b every GEOGRAPHY node is structurally complete with a shipped asset', t => {
  const e = engineFor(t);
  e.f.rebuildWorld(true);
  for (const n of e.acc.GEO_NODES) {
    assert.ok(Array.isArray(n.name) && n.name.length >= 1, `${n.id}: name lines`);
    assert.equal(typeof n.income, 'number', `${n.id}: numeric income`);
    assert.equal(typeof n.cost, 'number', `${n.id}: numeric cost`);
    assert.ok(e.acc.WIN_TYPES.includes(n.type), `${n.id}: type ${n.type} is a win type`);
    assert.ok(n.image.startsWith('./static/GeographyDLC/'), `${n.id}: image lives in the DLC folder`);
    assert.ok(fs.existsSync(path.join(repoRoot, n.image.replace(/^\.\//, ''))), `${n.id}: ${n.image} exists on disk`);
    assert.ok(typeof n.sp === 'string' && n.sp.length > 40, `${n.id}: has power copy`);
  }
  assert.equal(e.acc.GEO_NODES.length, 10, 'ten islands, no more, no fewer');
  assert.equal(new Set(e.acc.GEO_NODES.map(n => n.id)).size, 10, 'and no duplicate ids');
});

/* ================= GD-02 — the DLC world deals a connected 80-pin board ================= */
test('GD-02 with the toggle on, initGame deals 80 pins and every seed keeps the board connected', async t => {
  const seeds = [77, 78, 79, 80, 81, 82, 83, 84];
  for (const seed of seeds) {
    const e = engineFor(t);
    e.acc.Net.dlcGeo = true;
    withSeed(seed, () => e.f.initGame([{ name: 'A', char: 'markwatson' }, { name: 'B', char: 'tomkins' }]));
    const S = e.acc.S;
    assert.equal(S.dlcGeo, true, 'the flag rides with the state');
    assert.equal(e.acc.NODES.length, 80, '80 pins dealt');
    assert.equal(Object.keys(S.rubble).length, 0, 'a fresh world has no rubble');
    assert.ok(S.log.some(l => l.includes('GEOGRAPHY DLC')), 'the table is told the DLC is live');
    const reached = bfs(e.acc.ADJ, 'quik');
    for (const id of e.acc.GEO_NODE_IDS) {
      assert.ok(reached.has(id), `seed ${seed}: ${id} reachable from Quikstop`);
    }
    assert.equal(reached.size, 80, `seed ${seed}: the whole board is walkable`);
    e.dispose();
  }
});

/* ================= GD-03..GD-05 — MISSILE COMMAND ================= */
test('GD-03 the missile expropriates an owned node: no payout, rubble, once per turn', async t => {
  const { e, S } = await geoGame(t);
  S.owner.geo_missile = 0;
  S.owner.oil = 1;                       // the rival's prize asset
  S.players[0].money = 20; S.players[0].intel = 3;
  S.players[1].money = 40;
  armAction(e);
  await e.f.applyIntent(0, { act: 'missilemode' });
  assert.equal(S.mode, 'missile', 'the launch console arms');
  /* The strike's effects are synchronous — and so is the quiet quarter the
     chain deals before the promise yields (card.run() has no awaits). */
  const strike = e.f.applyIntent(0, { act: 'missile', id: 'oil' });
  assert.equal(S.players[0].money, 20 - 4 + 2, '−$4 launch cost, + the quiet quarter already in');
  assert.equal(S.players[0].intel, 2, '−1 Intel launch cost');
  assert.equal(S.owner.oil, undefined, 'the pin is expropriated — nobody owns it');
  assert.equal(S.rubble.oil, 1, 'and it is rubble');
  assert.equal(S.geoMissiled, true, 'one missile per turn');
  assert.ok(S.log.some(l => l.includes('expropriated with NO payout')), 'the table saw the expropriation');
  await strike;
  await settle();
  /* The former owner is paid nothing — their turn pays salary only + quiet. */
  assert.equal(S.players[1].money, 40 + 2 + 3, 'no payout: quiet $2 + $3 salary, the strike paid nothing');
  assert.equal(S.players[0].money, 20 - 4 + 2, 'the actor only adds the quiet quarter');
  assert.equal(S.geoMissiled, false, 'the launch slot clears at the next startTurn');
  assert.equal(e.f.canMissileNode(0, 'oil'), false, 'rubble is exactly what cannot be struck');
  assert.equal(e.f.canMissileNode(0, 'infl'), true, 'intact unowned pins remain targetable');
});

test('GD-04 missile guards: no self-strike, Pillars immune, no charge on refused launches', async t => {
  const { e, S } = await geoGame(t);
  S.owner.geo_missile = 0;
  S.owner.geo_pillars = 1;               // the rival ESG-shields their holdings
  S.owner.sat = 1;
  S.owner.oil = 0;                       // the actor's own node
  S.players[0].money = 30; S.players[0].intel = 3;
  armAction(e);
  await e.f.applyIntent(0, { act: 'missilemode' });
  await e.f.applyIntent(0, { act: 'missile', id: 'oil' });
  await settle();
  assert.equal(S.owner.oil, 0, 'self-target refused — the node stands, owned');
  assert.equal(S.rubble.oil, undefined, 'no rubble from your own strike');
  assert.equal(S.mode, null, 'the console closed itself');
  await e.f.applyIntent(0, { act: 'missilemode' });
  await e.f.applyIntent(0, { act: 'missile', id: 'sat' });
  await settle();
  assert.equal(S.owner.sat, 1, 'the ESG SHIELD protects the rival holding');
  assert.equal(S.rubble.sat, undefined);
  assert.equal(S.players[0].money, 30, 'no launch money was ever spent');
  assert.equal(S.players[0].intel, 3, 'no launch Intel was ever spent');
  assert.equal(e.f.canMissileNode(0, 'sat'), false, 'targetability helper agrees with the shield');
  assert.equal(e.f.canMissileNode(0, 'infl'), true, 'unprotected unowned pins stay targetable');
});

test('GD-05 rubble: rebuild pays list price, returns UNOWNED, and the Hotel skims $2 off every rebuild', async t => {
  const { e, S } = await geoGame(t);
  S.owner.geo_missile = 0;
  S.owner.oil = 1;                       // strike the rival's oil pit
  S.owner.geo_pyothotel = 1;             // the rival also owns the Pyongyang Hotel
  S.players[0].money = 40; S.players[0].intel = 3;
  S.players[1].money = 10;
  /* Chain 1 — the strike. */
  armAction(e);
  await e.f.applyIntent(0, { act: 'missilemode' });
  await e.f.applyIntent(0, { act: 'missile', id: 'oil' });
  await settle();
  assert.equal(S.players[0].money, 40 - 4 + 2, 'actor: −$4, + quiet $2');
  assert.equal(S.players[1].money, 10 + 2 + (3 + 2), 'no payout; rival quiet + salary + hotel income');
  assert.equal(S.rubble.oil, 1, 'rubble set by the strike');
  /* The actor walks onto the rubble — no new turn needed, position is free. */
  S.players[0].pos = 'oil';
  armAction(e);
  const rebuild = e.f.applyIntent(0, { act: 'rebuild' });
  assert.equal(S.rubble.oil, undefined, 'the rubble is cleared synchronously');
  assert.equal(S.owner.oil, undefined, 'a rebuild grants NO ownership — bids from next turn');
  await rebuild;
  await settle();
  /* Chain 2: −$12 rebuild, +$2 quiet; rival: +$2 kickback, + quiet, income again. */
  assert.equal(S.players[0].money, 40 - 4 - 12 + 2 + 2, 'the rebuild costs exactly list price');
  assert.equal(S.players[1].money, 10 + 2 + 5 + 2 + 2 + 5, 'the Hotel collects $2 kickbacks on the rebuild (+ its usual $5)');
  assert.equal(S.rubble.oil, undefined, 'the rubble is cleared');
  assert.equal(S.owner.oil, undefined, 'a rebuild grants NO ownership — bids from next turn');
  assert.ok(S.log.some(l => l.includes('returns unowned')), 'the copy says it out loud');
  assert.ok(S.log.some(l => l.includes('construction kickbacks')), 'the Hotel skim is on the record');
});

/* ================= GD-06 — WONSAN RESORT beach day ================= */
test('GD-06 beach day at Wonsan: free −2 Cortisol, once per turn, on-site only', async t => {
  const { e, S } = await geoGame(t);
  S.owner.geo_wonsan = 0;
  S.players[0].pos = 'geo_wonsan';
  S.players[0].cortisol = 3;
  armAction(e);
  const beach = e.f.applyIntent(0, { act: 'beach' });
  assert.equal(S.players[0].cortisol, 1, '−2 Cortisol, floored properly');
  assert.equal(S.geoBeach, true, 'once per turn');
  assert.ok(S.log.some(l => l.includes('beach day in Wonsan')), 'the table saw the beach day');
  await beach;
  await settle();
  /* Same turn again: the flag gate refuses (the flag resets only at startTurn —
     simulating the mid-turn state keeps the either/or guarantee testable). */
  S.geoBeach = true; S.cur = 0; S.phase = 'action'; S.mode = null;
  await e.f.applyIntent(0, { act: 'beach' });
  assert.equal(S.players[0].cortisol, 1, 'no double beaching');
  /* Off-site: refused even when the flag were clear. */
  S.geoBeach = false;
  S.players[0].pos = 'quik';
  await e.f.applyIntent(0, { act: 'beach' });
  assert.equal(S.geoBeach, false, 'beach day needs sand underfoot');
});

/* ================= GD-07 — PYONGYANG CITY tribute ================= */
test('GD-07 Pyongyang City pays +$1 income per GEOGRAPHY node owned', t => {
  const e = engineFor(t);
  e.f.rebuildWorld(true);
  const S = makeState(e, { dlcGeo: true, players: [{ money: 50 }] });
  e.acc.S = S;
  S.owner.geo_pyoncity = 0;
  S.owner.geo_missile = 0;   // income 0
  S.owner.geo_scs = 0;       // income 4
  S.owner.westpac = 0;       // income 2 — not a GEO node
  e.f.income(0);
  /* salary 3 + holdings 8 + synergies 4 — the $3 Pyongyang tribute, plus the
     base-game westpac/REGULATOR pairing (the missile site is a regulator). */
  assert.equal(S.players[0].money, 50 + 15, 'salary 3 + $8 income + $3 tribute + $1 westpac synergy');
  const S2 = makeState(e, { dlcGeo: true, players: [{ money: 50 }] });
  e.acc.S = S2;
  S2.owner.geo_pyoncity = 0;
  S2.owner.geo_tuvalu = 0;
  S2.owner.geo_pillars = 0;
  e.f.income(0);
  assert.equal(S2.players[0].money, 50 + 3 + (2 + 2 + 1) + 3, 'three pins held ⇒ +$3 tribute');
});

/* ================= GD-08/09 — THE CORPORATE BOEING vs QANTAS ================= */
test('GD-08 shutting down Qantas parks it for two full turns: no jet, no Qantas income', async t => {
  const { e, S } = await geoGame(t);
  S.owner.geo_boeing = 0;
  S.owner.qantas = 1;                    // the rival's airline
  S.players[0].money = 30; S.players[0].intel = 2;
  S.players[1].money = 10;
  armAction(e);
  const down = e.f.applyIntent(0, { act: 'qantasdown' });
  assert.equal(S.players[0].money, 30 - 4 + 2, '−$4 grounding fee, + the quiet quarter already in');
  assert.equal(S.qantasGroundUntil, S.turn + 3, 'grounded through the current and the next two turns');
  assert.equal(S.geoBoeing, true, 'once per turn');
  assert.ok(e.f.qantasGrounded(), 'the kangaroo is parked');
  assert.ok(S.log.some(l => l.includes('grounded for two full turns')), 'the table saw the grounding');
  await down;
  await settle();
  assert.equal(S.players[0].money, 30 - 4 + 2, 'the actor ends the chain at the same figure');
  /* The grounding bites immediately — the rival's next startTurn pays only salary. */
  assert.equal(S.players[1].money, 10 + 2 + 3, 'QANTAS paid $0 income, not its usual $2');
  /* While grounded: the jet itself is unreachable, and nobody pays for it. */
  S.players[0].pos = 'citi'; S.players[0].money = 30;
  await e.f.doFly(0, 'qantas');
  assert.equal(S.players[0].pos, 'citi', 'the jet itself is unreachable while parked');
  assert.equal(S.players[0].money, 30, 'no seat fee — the flight was refused');
  assert.equal(e.f.canReach('qantas'), false);
  /* Income stays hollowed while the Boeing blocks the runway. */
  S.turn = 2;
  assert.ok(e.f.qantasGrounded(), 'turn 2: still parked');
  const pre = S.players[1].money;
  e.f.income(1);
  assert.equal(S.players[1].money, pre + 3, 'QANTAS still pays nothing on turn 2');
  S.turn = 3;
  assert.ok(e.f.qantasGrounded(), 'turn 3: still parked');
  /* Two full turns pass — the engines come back. */
  S.turn = 4;
  assert.equal(e.f.qantasGrounded(), false, 'the Boeing leaves on turn 4');
  assert.equal(e.f.canReach('qantas'), true, 'the runway is open again');
  const pre2 = S.players[1].money;
  e.f.income(1);
  assert.equal(S.players[1].money, pre2 + 3 + 2, 'the usual $2 QANTAS income returns');
});

test('GD-09 the Boeing cannot ground the airline its owner flies', async t => {
  const { e, S } = await geoGame(t);
  S.owner.geo_boeing = 0;
  S.owner.qantas = 0;                    // the actor owns both
  S.players[0].money = 30;
  armAction(e);
  await e.f.applyIntent(0, { act: 'qantasdown' });
  assert.equal(S.geoBoeing, false, 'the shutdown is refused');
  assert.equal(S.players[0].money, 30, 'no fee charged');
  assert.equal(S.qantasGroundUntil, 0, 'no grounding was ever scheduled');
});

/* ================= GD-10 — THE SOUTH CHINA SEA oil crash ================= */
test('GD-10 oil crash: PANIC mood, −$2 per oil node, Pillars exempt', async t => {
  const { e, S } = await geoGame(t);
  S.owner.geo_scs = 0;
  S.owner.oil = 1; S.owner.petronas = 1;  // two oil positions for the rival
  S.players[0].money = 30; S.players[0].intel = 2;
  S.players[1].money = 20;
  armAction(e);
  const crash = e.f.applyIntent(0, { act: 'oilcrash' });
  assert.equal(S.players[0].money, 30 - 3 + 2, '−$3 to close the sea lanes, + the quiet quarter already in');
  assert.equal(S.players[1].money, 20 - 4 + 2, '−$2 × 2 oil nodes, + the quiet quarter already in');
  assert.ok(S.log.some(l => l.includes('THE MOOD SHIFTS') && l.includes('PANIC')), 'the mood turned PANIC (the quiet card calms it a breath later)');
  assert.equal(S.geoCrash, true, 'once per turn');
  assert.ok(S.log.some(l => l.includes('OIL CRASH')), 'the table saw the crash');
  await crash;
  await settle();
  assert.equal(S.mood, 'CALM', 'the quiet quarter calmed the board');
  assert.equal(S.players[0].money, 30 - 3 + 2);
  assert.equal(S.players[1].money, 20 - 4 + 2 + (3 + 8 + 3), 'then their ordinary income');

  /* Pillars exemption: the ESG holder pays nothing per oil node. */
  const { e: e2, S: S2 } = await geoGame(t);
  S2.owner.geo_scs = 0;
  S2.owner.geo_pillars = 1;
  S2.owner.barrels = 1;                  // an oil node for the shielded player
  S2.owner.oil = 1;
  S2.players[0].money = 30; S2.players[1].money = 40;
  armAction(e2);
  const crash2 = e2.f.applyIntent(0, { act: 'oilcrash' });
  assert.ok(S2.log.some(l => l.includes('THE MOOD SHIFTS') && l.includes('PANIC')), 'the crash mood lands even on a shielded table');
  assert.equal(S2.players[1].money, 40 + 2, 'the Pillars pay nothing — only the quiet quarter lands');
  await crash2;
  await settle();
  /* shielded rival: no crash losses; income = salary 3 + oil 8 + barrels 2 + the Pillars' own $1 */
  assert.equal(S2.players[1].money, 40 + 2 + (3 + 8 + 2 + 1), 'the Pillars pay nothing while their positions keep income');
  assert.ok(S2.log.some(l => l.includes('rides the crash out unscathed')), 'the shield is announced');
});

/* ================= GD-11 — STAGE 5 DECLINE ================= */
test('GD-11 Stage 5: the richest rival makes no income on their next turn (2 Intel, once per turn)', async t => {
  const { e, S } = await geoGame(t);
  S.owner.geo_stage5 = 0;
  S.players[0].money = 30; S.players[0].intel = 3;
  S.players[1].money = 200;              // clearly the richest
  armAction(e);
  const call = e.f.applyIntent(0, { act: 'stage5' });
  assert.equal(S.players[0].intel, 1, '2 Intel spent');
  assert.equal(S.decline, 1, 'the call names the richest rival');
  assert.equal(S.geoStage5, true, 'once per turn');
  assert.ok(S.log.some(l => l.includes('STAGE 5 DECLINE')), 'the table saw the call');
  await call;
  await settle();
  /* The decline lands: the rival's next startTurn pays NOTHING. */
  assert.equal(S.players[1].money, 200 + 2, 'quiet $2 still applies — but no salary, no income');
  assert.equal(S.decline, null, 'the call is consumed');
  assert.equal(S.geoStage5, false, 'the call slot clears at the next startTurn');
  /* Their next turn after that pays normally again. */
  armAction(e);
  await e.f.applyIntent(0, { act: 'laylow', choice: 'cash' }); // +$1, chain rolls the table
  await settle();
  assert.equal(S.players[1].money, 200 + 2 + 3 + 2, 'decline gone: salary + quiet');
  assert.equal(S.players[0].money, 30 + 2 + 1 + 2, 'the actor: quiet, the laylow $1, quiet');
});

test('GD-11b Stage 5 guards: ESG-rich cannot be declined; no rival, no call', async t => {
  {
    const { e, S } = await geoGame(t);
    S.owner.geo_stage5 = 0;
    S.owner.geo_pillars = 1;
    S.players[0].intel = 3;
    S.players[1].money = 200;
    armAction(e);
    await e.f.applyIntent(0, { act: 'stage5' });
    assert.equal(S.decline, null, 'the ESG SHIELD refuses the call');
    assert.equal(S.players[0].intel, 3, 'nothing was spent');
    e.dispose();
  }
  {
    /* A solo table has nobody to decline. */
    const e = engineFor(t);
    const S0 = await makeGame(e, 1, { geo: true });
    quietDeck(S0);
    S0.owner.geo_stage5 = 0;
    S0.players[0].intel = 5;
    S0.cur = 0; S0.phase = 'action'; S0.mode = null;
    await e.f.applyIntent(0, { act: 'stage5' });
    assert.equal(S0.decline, null, 'no call on a one-seat table');
    assert.equal(S0.players[0].intel, 5, 'no spend on a one-seat table');
    e.dispose();
  }
});

/* ================= GD-12 — VENICE DI CCTV ================= */
test('GD-12 gondola therapy: free −1 Cortisol on-site, either/or with Overtourism', async t => {
  const { e, S } = await geoGame(t);
  S.owner.geo_venice = 0;
  S.players[0].pos = 'geo_venice';
  S.players[0].cortisol = 2;
  armAction(e);
  const cool = e.f.applyIntent(0, { act: 'venicecool' });
  assert.equal(S.players[0].cortisol, 1, '−1 Cortisol on the gondola');
  assert.equal(S.geoVenice, true, 'the once-per-turn slot is spent');
  assert.ok(S.log.some(l => l.includes('gondola')), 'the table saw the therapy');
  await cool;
  await settle();
  /* Either/or: overtourism is off for this turn too. The flag resets at every
     startTurn, so restore it manually to exercise the same-turn gate. */
  S.geoVenice = true;
  S.cur = 0; S.phase = 'action'; S.mode = null;
  await e.f.applyIntent(0, { act: 'overmode' });
  assert.notEqual(S.mode, 'overtour', 'gondola or ships — never both');
});

test('GD-12b Overtourism: +1 Cortisol per owner-turn while Venice stays owned', async t => {
  const { e, S } = await geoGame(t);
  S.owner.geo_venice = 0;
  S.owner.oil = 1; S.owner.westpac = 1;  // rival needs >1 node for cortisol to land
  S.players[0].money = 30; S.players[0].intel = 2;
  S.players[1].cortisol = 0;
  armAction(e);
  await e.f.applyIntent(0, { act: 'overmode' });
  assert.equal(S.mode, 'overtour', 'the cruise board arms');
  const tour = e.f.applyIntent(0, { act: 'overtour', id: 'westpac' });
  assert.equal(S.players[0].money, 30 - 2 + 2, '−$2 fare, + the quiet quarter already in');
  assert.equal(JSON.stringify(S.ov), JSON.stringify({ nid: 'westpac', by: 0 }), 'the ships are booked');
  assert.ok(S.log.some(l => l.includes('OVERTOURISM')), 'the table saw the ships');
  await tour;
  await settle();
  /* The marked owner steams on their turn. */
  assert.equal(S.players[1].cortisol, 1, '+1 Cortisol at the rival’s turn');
  assert.notEqual(S.ov, null, 'the ships keep coming');
  /* Venice changes hands — the cruise stops and is swept. */
  S.owner.geo_venice = 1;
  S.players[1].cortisol = 5; S.players[0].money = 10;
  armAction(e);
  await e.f.applyIntent(0, { act: 'laylow', choice: 'cash' }); // +$1; the chain rolls to the rival
  await settle();
  assert.equal(S.ov, null, 'overtourism clears when the Venetian sells up');
  assert.equal(S.players[1].cortisol, 5, 'no further cortisol once the ships are gone');
});

test('GD-12c Overtourism guards: needs a standing rival pin, refuses ESG holdings', async t => {
  const { e, S } = await geoGame(t);
  S.owner.geo_venice = 0;
  S.owner.geo_pillars = 1; S.owner.westpac = 1; // the rival holds the Pillars
  S.players[0].money = 30;
  armAction(e);
  await e.f.applyIntent(0, { act: 'overmode' });
  await e.f.applyIntent(0, { act: 'overtour', id: 'westpac' });
  await settle();
  assert.equal(S.ov, null, 'the ESG SHIELD keeps the ships away');
  assert.equal(S.players[0].money, 30, 'no fare charged on a refused launch');
  assert.equal(S.mode, null, 'the board closed');
  /* Rubble pins are out of scope too. */
  S.owner.westpac = 1; S.owner.geo_pillars = 2;
  S.rubble.westpac = 1; S.players[0].money = 30;
  armAction(e);
  await e.f.applyIntent(0, { act: 'overmode' });
  await e.f.applyIntent(0, { act: 'overtour', id: 'westpac' });
  await settle();
  assert.equal(S.ov, null, 'no ships to rubble');
  assert.equal(S.players[0].money, 30, 'no fare for a rubble pin');
});

/* ================= GD-13 — TUVALU, the free country ================= */
test('GD-13 Tuvalu auto-claims for the first arrival — free, no Cortisol; never for rubble', async t => {
  const { e, S } = await geoGame(t);
  S.players[0].cortisol = 0; S.players[0].money = 20;
  await e.f.doMove(0, 'geo_tuvalu');
  assert.equal(S.players[0].pos, 'geo_tuvalu');
  assert.equal(S.owner.geo_tuvalu, 0, 'first arrival claims it');
  assert.equal(S.players[0].money, 20, 'the join is free — no toll, no price');
  assert.equal(S.players[0].cortisol, 0, 'no Cortisol for the free country');
  assert.ok(S.log.some(l => l.includes('THE JOIN IS FREE')), 'the table saw the join');
  /* A later arrival does not take it — they pay the toll like anywhere else. */
  S.players[0].pos = 'quik';
  S.players[1].pos = 'citi';
  S.players[1].money = 15;
  await e.f.doMove(1, 'geo_tuvalu');
  assert.equal(S.owner.geo_tuvalu, 0, 'no second claim');
  assert.equal(S.players[1].pos, 'geo_tuvalu', 'they still stand there');
  assert.equal(S.players[1].money, 14, 'the $1 toll still applies');
  /* Rubble claims nobody. */
  const { e: e2, S: S2 } = await geoGame(t);
  e2.f.strikeNode(0, 'geo_tuvalu');
  S2.players[0].pos = 'quik';
  await e2.f.doMove(0, 'geo_tuvalu');
  assert.equal(S2.owner.geo_tuvalu, undefined, 'rubble is unclaimable');
  assert.equal(S2.rubble.geo_tuvalu, 1, 'the strike left rubble behind');
});

/* ================= GD-14 — the DLC board sweep across seeds ================= */
test('GD-14 the generated 80-pin board stays a valid collage across 30 seeds', { timeout: 60000 }, t => {
  const e = engineFor(t);
  e.f.rebuildWorld(true);
  const slots = e.acc.QUIK_SLOTS;
  for (let s = 0; s < 30; s++) {
    const seed = 3000 + s;
    const slot = slots[s % slots.length];
    let gen;
    withSeed(seed, () => { gen = e.f.generateRandomBoard(slot); });
    const posById = new Map(gen.positions.map(p => [p.id, p]));
    for (const id of e.acc.GEO_NODE_IDS) {
      assert.ok(posById.has(id), `seed ${seed}: ${id} plotted`);
    }
    const reached = bfs(e.acc.ADJ, 'quik');
    assert.equal(reached.size, 80, `seed ${seed}: fully connected`);
    /* Geo pins never share a plot with each other. */
    for (let i = 0; i < e.acc.GEO_NODE_IDS.length; i++) {
      for (let j = i + 1; j < e.acc.GEO_NODE_IDS.length; j++) {
        const a = posById.get(e.acc.GEO_NODE_IDS[i]), b = posById.get(e.acc.GEO_NODE_IDS[j]);
        assert.ok(a.x !== b.x || a.y !== b.y, `seed ${seed}: ${a.id} and ${b.id} overlap`);
      }
    }
  }
});

/* ================= GD-15 — lobby toggle: host-only, mirrored everywhere ================= */
test('GD-15 the geo flag is host-gated in the lobby and travels with every payload', async t => {
  const { e } = await geoGame(t);
  /* A third seat joins mid-lobby: the welcome payload carries the flag.
     (Mid-game, handleHello only welcomes rejoining known seats.) */
  e.acc.Net.started = false;
  const c3 = makeConn(e, 'pid9');
  e.acc.Net.conns[2] = c3;
  e.f.handleHello(c3, 'Third Chair', 'pid9');
  const welcome = c3.sent.find(m => m.t === 'welcome');
  assert.ok(welcome, 'the third seat got their welcome');
  assert.equal(welcome.dlcGeo, true, 'the welcome ships the DLC flag');
  /* broadcastLobby mirrors it too. */
  e.f.broadcastLobby();
  const lobby = c3.sent.filter(m => m.t === 'lobby').pop();
  assert.equal(lobby.dlcGeo, true, 'the lobby broadcast ships the DLC flag');
  /* The state carries it: guests rebuild their world on adopt. */
  const guest = engineFor(t);
  assert.equal(guest.acc.NODES.length, 70, 'guests start in the base world');
  guest.f.adoptState(JSON.parse(JSON.stringify(e.f.pubState(true))));
  assert.equal(guest.acc.NODES.length, 80, 'adopting a geo state rebuilds the guest world');
  assert.equal(guest.acc.WORLD_GEO, true);
  assert.ok(guest.acc.NMAP.geo_tuvalu, 'guests see every pin');
  assert.equal(JSON.parse(JSON.stringify(guest.acc.S)).dlcGeo, true);
  guest.dispose();
  /* UI gate: guests cannot flip the box; setGeoUI mirrors instead. */
  assert.ok(SOURCE.includes("gt.onchange=()=>{if(Net.role!=='host'){gt.checked=Net.dlcGeo"), 'the guest checkbox refuses to lead');
  e.f.setGeoUI(false);
  assert.equal(e.acc.Net.dlcGeo, false, 'setGeoUI flips the in-memory flag');
  e.f.setGeoUI(true);
  assert.equal(e.acc.Net.dlcGeo, true);
});

/* ================= GD-16 — help copy & the exhibit-count contract ================= */
test('GD-16 the help panel explains the DLC without breaking the base-game copy pins', t => {
  assert.ok(SOURCE.includes('The Geography DLC'), 'the help section is titled');
  assert.ok(SOURCE.includes('80 exhibits'), 'help copy says what the board becomes');
  assert.ok(SOURCE.includes('v1.9'), 'the version stamp moved');
  assert.ok(SOURCE.includes('70 exhibits'), 'the base-game exhibit copy is intact (RC-01 pin)');
  assert.ok(!SOURCE.includes('82 exhibits'), 'no stale exhibit counts');
});
