/*
 * Economy and victory — section 5 (EC-01..EC-08) of docs/CODE_LEVEL_TEST_PLAN.md.
 * MADE payouts, Sisyphus growth, income composition/timing, the victory
 * predicate and ACCC concentration. Randomness is controlled via value
 * sequences so every outcome is deterministic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadEngine, makeState, withSeed, withRandomSeq, pump,
} from './helpers/harness.mjs';

function ctx_engine(t) {
  const engine = loadEngine();
  t.after(() => engine.dispose());
  return engine;
}
function fixture(engine, over = {}) {
  const S = makeState(engine, over);
  engine.acc.S = S;
  return S;
}

/* ================= EC-01 / EC-02 — MADE ================= */
test('EC-01 MADE pays its owner $10 and 1 Intel, and takes 15% only from rich multi-holders', t => {
  const engine = ctx_engine(t);
  const S = fixture(engine, {
    owner: { made: 0, citi: 1, commbank: 1, anz: 1 }, // P1 holds exactly three real nodes
    players: [
      { money: 0, intel: 0 },   // owner
      { money: 100, intel: 0 }, // rich + 3 nodes → pays 15% (floor of $15)
      { money: 20 },            // poor: below $50
    ],
  });
  engine.f.madePay();
  assert.equal(S.players[0].money, 10);
  assert.equal(S.players[0].intel, 1);
  assert.equal(S.players[1].money, 100 - Math.floor(100 * 0.15), 'floor(15) = $15');
  assert.equal(S.players[2].money, 20, 'poorer players do not pay');
});

test('EC-02 MADE edge cases: no owner, $49/$50, 2/3/4 nodes, maximum resources', t => {
  const engine = ctx_engine(t);
  // No owner: nothing happens at all.
  const S0 = fixture(engine, { players: [{ money: 100, intel: 5 }] });
  engine.f.madePay();
  assert.equal(S0.players[0].money, 100);
  assert.equal(S0.players[0].intel, 5);

  const cases = [
    { name: '$50 with exactly 3 nodes pays the floor of 15%', nodes: ['citi', 'commbank', 'anz'], money: 50, cut: 7 },
    { name: 'exactly 2 nodes never pays', nodes: ['citi', 'commbank'], money: 500, cut: 0 },
    { name: '$49 never pays even with 4 nodes', nodes: ['citi', 'commbank', 'anz', 'rba'], money: 49, cut: 0 },
    { name: 'maximum resources pay floor(15%) of the whole book', nodes: ['citi', 'commbank', 'anz'], money: 1000, cut: 150 },
  ];
  for (const c of cases) {
    const owner = { made: 1 };
    c.nodes.forEach(id => { owner[id] = 0; });
    const S = fixture(engine, { owner, players: [{ money: c.money }, { money: 0, intel: 0 }] });
    engine.f.madePay();
    assert.equal(S.players[0].money, c.money - c.cut, c.name);
  }
});

/* ================= EC-03 — Sisyphus ================= */
test('EC-03 repeated pushes double the payout and cost no Cortisol; the growth is uncapped', async t => {
  const engine = ctx_engine(t);
  const S = fixture(engine, {
    owner: { sisy: 0, citi: 0, infl: 0 }, // 2+ nodes keeps the Cortisol protection satisfied
    players: [{ pos: 'sisy', money: 0, intel: 0, cortisol: 0 }],
    goal: 999,
    deck: Array.from({ length: 30 }, () => 'quiet'),
  });
  const pushes = 10;
  for (let i = 0; i < pushes; i++) {
    S.phase = 'action'; // startTurn flips the phase back to 'move' between pushes
    await engine.f.applyIntent(0, { act: 'push' });
    await pump();
    assert.equal(S.players[0].cortisol, 0, `push ${i}: no Cortisol cost`);
    assert.equal(S.sisyPayout, 10 * Math.pow(2, i + 1), `push ${i}: payout doubles exactly`);
  }
  // Uncapped growth: after 10 pushes the payout is $10,240 and nothing resets it.
  assert.equal(S.sisyPayout, 10240);
  assert.ok(!engine.consoleOut.error.length, 'no engine errors across the long run');
});

test('EC-03b a push pays the current doubling amount to the pusher', async t => {
  const engine = ctx_engine(t);
  const S = fixture(engine, {
    owner: { sisy: 0, citi: 0, infl: 0 },
    players: [{ pos: 'sisy', money: 0, intel: 0 }],
    goal: 999,
    deck: Array.from({ length: 8 }, () => 'quiet'),
  });
  S.phase = 'action';
  const before = S.players[0].money;
  await engine.f.applyIntent(0, { act: 'push' });
  await pump();
  assert.equal(S.sisyPayout, 20, 'the next push is $20');
  assert.ok(S.log.some(l => l.includes('pushed the boulder uphill')), 'the push is recorded');
  // money: push +$10, the quiet-quarter event +$2, and the automatic next turn
  // pays income (salary $4 — infl is owned — + holdings citi 3 + infl 1 + sisy 0).
  assert.equal(S.players[0].money, before + 10 + 2 + (4 + 3 + 1));
});

/* ================= EC-04 — passive income and synergies ================= */
test('EC-04a baseline salary and plain node income', t => {
  const engine = ctx_engine(t);
  const S = fixture(engine, { players: [{}] });
  assert.equal(S.players[0].money, 0);
  engine.f.income(0);
  assert.equal(S.players[0].money, 3, 'salary $3');

  const S2 = fixture(engine, { owner: { oil: 0 }, players: [{}] });
  engine.f.income(0);
  assert.equal(S2.players[0].money, 3 + 8, 'oil pays $8/turn');
});

test('EC-04b the IB Diploma doubles chart income; the master chart adds $3 per extra chart', t => {
  const engine = ctx_engine(t);
  // ib is owned too: it is a WILD node with income 1 that does NOT double itself.
  // infl raises the salary to $4 (it is also a chart).
  const S = fixture(engine, { owner: { ib: 0, tenyear: 0, infl: 0, stock: 0 }, players: [{}] });
  engine.f.income(0);
  assert.equal(S.players[0].money, 4 + (2 * (1 + 1 + 1) + 1) + 3 * (3 - 1), 'salary 4 + doubled charts 6 + ib 1 + master 6');
});

test('EC-04c headline synergies each apply exactly once', t => {
  const engine = ctx_engine(t);
  const cases = [
    { owner: { citi: 0, coal: 0, quik: 0, market: 0 }, keep: 'citi $1/sp CORPORATE + anchor stores pair', expect: 3 + (3 + 3 + 2 + 2) + 3 + 2 },
    { owner: { commbank: 0, anz: 0 }, keep: 'the big four stick together', expect: 3 + (2 + 2) + 2 },
    { owner: { westpac: 0, rba: 0 }, keep: 'westpac $1/s REGULATOR', expect: 3 + (2 + 2) + 1 },
    { owner: { anz: 0, tenyear: 0, infl: 0 }, keep: 'anz reads charts + master bonus + salaried infl', expect: 4 + (2 + 1 + 1) + 2 + 3 },
    { owner: { barrels: 0, forklift: 0, oil: 0 }, keep: 'forklift $1/s COMMODITY + pair', expect: 3 + (2 + 1 + 8) + 3 + 1 },
    { owner: { market: 0, quik: 0 }, keep: 'anchor tenant pair +$2', expect: 3 + (2 + 2) + 2 },
    { owner: { rock: 0, oil: 0, citi: 0 }, keep: 'rock: $1 per DIFFERENT type', expect: 3 + (1 + 8 + 3) + 3 },
    { owner: { bessent: 0, citi: 0 }, keep: 'bessent $1/s BANK', expect: 3 + (1 + 3) + 1 },
    { owner: { watson: 0, coal: 0 }, keep: 'watson+coal pair +$2', expect: 3 + (0 + 3) + 2 },
    { owner: { mpc: 0, tenyear: 0, cash: 0 }, keep: 'mpc $1/s CHART + master bonus', expect: 3 + (1 + 1 + 1) + 2 + 3 },
  ];
  for (const c of cases) {
    const S = fixture(engine, { owner: c.owner, players: [{ money: 0 }] });
    engine.f.income(0);
    assert.equal(S.players[0].money, c.expect, c.keep);
  }
});

test('EC-04d the market mood pays — and taxes — the right node types', t => {
  const engine = ctx_engine(t);
  const boom = fixture(engine, { owner: { oil: 0, forklift: 0 }, mood: 'BOOM', players: [{}] });
  engine.f.income(0);
  assert.equal(boom.players[0].money, 3 + (8 + 1) + 2 + 2, 'BOOM: +$1 per commodity AND the forklift synergy');

  const frenzy = fixture(engine, { owner: { press: 0, fox: 0 }, mood: 'FRENZY', players: [{}] });
  engine.f.income(0);
  assert.equal(frenzy.players[0].money, 3 + (2 + 2) + 2, 'FRENZY: +$1 per media node');

  const panic = fixture(engine, { owner: { citi: 0, hedge: 0 }, mood: 'PANIC', players: [{}] });
  engine.f.income(0);
  assert.equal(panic.players[0].money, 3 + (3 + 2) - 2, 'PANIC: banks bleed -$1 each');

  const calm = fixture(engine, { owner: { oil: 0 }, mood: 'CALM', players: [{}] });
  engine.f.income(0);
  assert.equal(calm.players[0].money, 3 + 8 + 0, 'CALM: no modifier');
});

test('EC-04e bug skims pay $1/turn, or $2 with the World Economic Forum', t => {
  const engine = ctx_engine(t);
  const S = fixture(engine, { owner: { oil: 1, gold: 1 }, bugs: { oil: 0, gold: 0 }, players: [{}, {}] });
  engine.f.income(0);
  assert.equal(S.players[0].money, 3 + 1 + 1, 'salary + two $1 skims');

  const S2 = fixture(engine, { owner: { oil: 1, wef: 0 }, bugs: { oil: 0 }, players: [{}, {}] });
  engine.f.income(0);
  assert.equal(S2.players[0].money, 3 + 2 + 2, 'salary + the WEF\'s own $2 + one $2 skim (WEF doubles)');
});

test('EC-04f inflation compensation raises the salary to $4 (and the chart itself pays)', t => {
  const engine = ctx_engine(t);
  const S = fixture(engine, { owner: { infl: 0 }, players: [{}] });
  engine.f.income(0);
  assert.equal(S.players[0].money, 4 + 1);
});

/* ================= EC-05 — income timing ================= */
test('EC-05 income is paid in startTurn only: not on sync, not on adoptState, skipped under caution', async t => {
  const engine = ctx_engine(t);
  const S = fixture(engine, { owner: { oil: 0 }, players: [{ money: 0, raided: 1 }], deck: ['quiet'] });
  engine.f.startTurn();
  await new Promise(r => setImmediate(r));
  assert.equal(S.players[0].money, 0, 'raided turn: skipped');
  assert.equal(S.caution, true);

  // Duplicated state delivery never pays again.
  const before = JSON.parse(JSON.stringify(S.players));
  engine.f.sync();
  engine.f.sync();
  engine.f.flushState();
  assert.deepEqual(JSON.parse(JSON.stringify(S.players)), before, 'sync does not award income');

  // Arrival of a (public) state on the wire does not award income either.
  const pub = engine.f.pubState(true);
  engine.f.adoptState(JSON.parse(JSON.stringify(pub)));
  assert.equal(engine.acc.S.players[0].money, S.players[0].money, 'adoptState is a transfer, not a payout');
});

/* ================= EC-06 / EC-07 — the victory predicate ================= */
const WIN_NODE_IDS = { BANK: 'citi', REGULATOR: 'rba', CHART: 'infl', WILD: 'term', CORPORATE: 'coal', COMMODITY: 'oil', MEDIA: 'press' };

function winFixture(engine, goal, params = {}) {
  const owner = {};
  for (const t of engine.acc.WIN_TYPES) {
    if (t !== params.missing) owner[WIN_NODE_IDS[t]] = params.holder ?? 0;
  }
  return fixture(engine, {
    owner,
    players: [{ money: params.money ?? goal }],
    goal,
  });
}

test('EC-06 one owned node of each type satisfies it; missing any one type blocks victory', async t => {
  const engine = ctx_engine(t);
  engine.acc.Net.role = 'host';
  for (const missing of engine.acc.WIN_TYPES) {
    const S = winFixture(engine, 100, { missing, money: 100 });
    const missingTypes = engine.acc.WIN_TYPES.filter(t => !engine.acc.NODES.some(n => n.type === t && S.owner[n.id] === 0));
    const won = await win_run(engine, S);
    assert.equal(won, false, `missing ${missing} blocks the win`);
    assert.deepEqual([...missingTypes], [missing], `exactly ${missing} is missing`);
    assert.equal(S.over, false, `no game-over flag for ${missing}`);
  }
  // All seven types at threshold → wins.
  const S = winFixture(engine, 100, { money: 100 });
  assert.equal(await win_run(engine, S), true);
  assert.equal(S.over, true);
});

test('EC-07 cash threshold: one below fails, exactly at wins; the richest simultaneous candidate wins; post-over intents rejected', async t => {
  const engine = ctx_engine(t);
  engine.acc.Net.role = 'host';

  const below = winFixture(engine, 100, { money: 99 });
  assert.equal(await win_run(engine, below), false);
  assert.equal(below.over, false);

  const at = winFixture(engine, 100, { money: 100 });
  assert.equal(await win_run(engine, at), true);

  // Only QUALIFYING players can win: a richer player without the full set of
  // types does not win over a poorer player who has it. There is a single
  // REGULATOR node (rba), so the full set is handed to the poorer candidate.
  const tie = fixture(engine, {
    owner: {
      citi: 0, rba: 0, infl: 0, term: 0, coal: 0, oil: 0, press: 0, // P0: full set, $120
      commbank: 1, cash: 1, school: 1, quik: 1, gold: 1, fox: 1,    // P1: six of seven types, $200
    },
    players: [{ money: 120 }, { money: 200 }],
    goal: 100,
  });
  assert.equal(await win_run(engine, tie), true);
  assert.equal(tie.over, true);
  const winnerLine = tie.log.find(l => l.startsWith('🏆'));
  assert.ok(winnerLine && winnerLine.includes('P0'), `the $120 full-set player wins: ${winnerLine}`);

  // After victory, further intents are rejected without crashing or mutating.
  const snap = JSON.parse(JSON.stringify({ m: tie.players.map(p => p.money), o: tie.owner }));
  await engine.f.applyIntent(0, { act: 'favor' });
  await pump();
  assert.deepEqual(JSON.parse(JSON.stringify({ m: tie.players.map(p => p.money), o: tie.owner })), snap,
    'no mutation after game over');

  // Divestment after near-victory blocks the automatic win.
  const S = winFixture(engine, 100, { money: 100 });
  delete S.owner.press; // lose MEDIA
  assert.equal(await win_run(engine, S), false);
});

async function win_run(engine, S) {
  return Boolean(await engine.f.winCheck());
}

/* ================= EC-08 — ACCC concentration ================= */
test('EC-08 0/1/2 holdings in an industry never trigger the ACCC; charts are exempt', t => {
  const engine = ctx_engine(t);
  const cases = [
    { keep: 'two BANK nodes only', owner: { citi: 0, commbank: 0 } },
    { keep: 'four CHART nodes only (charts exempt)', owner: { us: 0, japan: 0, uk: 0, aus: 0 } },
  ];
  for (const c of cases) {
    const S = fixture(engine, { owner: c.owner, players: [{ money: 100, intel: 10 }, { money: 0 }] });
    withSeed(1, () => engine.f.acccInvestigate(0)); // gate ignored — no concentrated industry
    assert.ok(Object.values(S.owner).filter(v => v === 0).length >= 2, `${c.keep}: nothing divested`);
    assert.equal(engine.modalRec.filter(m => m.title === 'MONOPOLY ALERT').length, 0, c.keep);
    assert.equal(S.players[0].money, 100, c.keep);
  }
});

function hostMode(engine) { engine.acc.Net.role = 'host'; }

test('EC-08b 3+ BANK nodes in Banking trigger the 1-in-3 investigation: divest, redistribute, fine 20%', t => {
  const engine = ctx_engine(t);
  hostMode(engine);
  const S = fixture(engine, {
    owner: { citi: 0, commbank: 0, nab: 0, oil: 1 },
    players: [{ money: 100, intel: 10 }, { money: 0, intel: 0 }, { money: 0, intel: 0 }],
  });
  withRandomSeq([0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], () => engine.f.acccInvestigate(0));
  assert.ok(engine.modalRec.some(m => m.title === 'MONOPOLY ALERT'), 'the table saw the alert');
  // The whole Banking book was divested: nothing may remain with player 0, the
  // rest of the table picks up at most one node each, the remainder returns to market.
  assert.notEqual(S.owner.citi, 0, 'citi is divested from the offender');
  assert.notEqual(S.owner.commbank, 0, 'commbank is divested from the offender');
  assert.notEqual(S.owner.nab, 0, 'nab is divested from the offender');
  const divested = ['citi', 'commbank', 'nab'];
  assert.equal(S.owner.oil, 1, 'non-industry holdings survive (oil)');
  const moved = divested.filter(id => S.owner[id] !== undefined && S.owner[id] !== 0);
  const returned = divested.filter(id => S.owner[id] === undefined);
  assert.equal(moved.length + returned.length, 3, 'every divested node went somewhere valid');
  assert.ok(moved.length >= 1 && moved.length <= 2, `one per rival (2 rivals) — got ${moved.length}`);
  assert.equal(S.players[0].money, 100 - Math.floor(100 * 0.2), '20% cash fine');
  assert.equal(S.players[0].intel, 10 - Math.floor(10 * 0.2), '20% Intel fine');
});

test('EC-08c the same bank book CAN be safe when the 1-in-3 gate misses', t => {
  const engine = ctx_engine(t);
  hostMode(engine);
  const S = fixture(engine, {
    owner: { citi: 0, commbank: 0, nab: 0 },
    players: [{ money: 100, intel: 10 }, { money: 0 }],
  });
  withRandomSeq([0.9], () => engine.f.acccInvestigate(0)); // gate misses
  assert.equal(S.owner.citi, 0, 'no divestment');
  assert.equal(S.owner.commbank, 0);
  assert.equal(S.owner.nab, 0);
  assert.equal(S.players[0].money, 100);
  assert.equal(engine.modalRec.filter(m => m.title === 'MONOPOLY ALERT').length, 0);
});

test('EC-08d the Watson monopoly exception: holding Mark Watson is itself an offence', t => {
  const engine = ctx_engine(t);
  hostMode(engine);
  const S = fixture(engine, { owner: { watson: 0 }, players: [{ money: 50 }, { money: 0 }] });
  withRandomSeq([0.1, 0.5, 0.5, 0.5], () => engine.f.acccInvestigate(0));
  assert.equal(S.owner.watson, 1, 'watson divested to the one rival');
  assert.equal(S.players[0].money, 50 - Math.floor(50 * 0.2));
});

test('EC-08e fewer rivals than divested nodes: one node max per rival, the rest return to market', t => {
  const engine = ctx_engine(t);
  hostMode(engine);
  const S = fixture(engine, {
    // OIL industry: oil, oilgraph, barrels, tanker, petronas — 5 nodes
    owner: { oil: 0, oilgraph: 0, barrels: 0, tanker: 0, petronas: 0 },
    players: [{ money: 100, intel: 0 }, { money: 0 }, { money: 0 }],
  });
  withRandomSeq(Array.from({ length: 20 }, (_, i) => (i === 0 ? 0.1 : 0.5)), () => engine.f.acccInvestigate(0));
  const divested = ['oil', 'oilgraph', 'barrels', 'tanker', 'petronas'];
  const moved = divested.filter(id => S.owner[id] !== undefined && S.owner[id] !== 0);
  const returned = divested.filter(id => S.owner[id] === undefined);
  assert.equal(moved.length, 2, 'one per rival (2 rivals), regardless of which seats they land on');
  assert.equal(returned.length, 3, 'the remainder rebounds to the market');
});

test('EC-08f overlapping industry groups break ONE book with a single alert', t => {
  const engine = ctx_engine(t);
  hostMode(engine);
  const S = fixture(engine, {
    // press/jt/iface are MEDIA ×3 AND the JTPORTAL group ×3
    owner: { press: 0, jt: 0, iface: 0 },
    players: [{ money: 100, intel: 0 }, { money: 0 }],
  });
  withRandomSeq([0.1, 0.5, 0.5, 0.5, 0.5], () => engine.f.acccInvestigate(0));
  const all = ['press', 'jt', 'iface'];
  assert.equal(engine.modalRec.filter(m => m.title === 'MONOPOLY ALERT').length, 1, 'a single investigation');
  const moved = all.filter(id => S.owner[id] === 1);
  const returned = all.filter(id => S.owner[id] === undefined);
  assert.equal(moved.length + returned.length, 3, 'the whole overlapping book was broken in one alert');
  assert.equal(moved.length, 1, 'max one node per rival');
});
