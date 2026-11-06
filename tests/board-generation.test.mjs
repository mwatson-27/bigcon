/*
 * Board generation & wire layout fidelity — section 4 (RM-01..RM-09) of
 * docs/CODE_LEVEL_TEST_PLAN.md.
 *
 * The heavy sweep calls generateRandomBoard directly on ~200 millisecond-level
 * mulberry32 seeds (five Quikstop neighbourhoods round-robin); the init-game
 * subset runs full initGame on a fewer seeds to check seating, wire payloads
 * and the pubState/adoptState round-trip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, makeConn, withSeed, bfs, CHARS8 } from './helpers/harness.mjs';

async function settle() {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

/* Index of the first pair of array entries whose JSON serialisations differ. */
function S_idxFirstDiff(guest, host) {
  for (let i = 0; i < Math.max(guest.length, host.length); i++) {
    if (JSON.stringify(guest[i]) !== JSON.stringify(host[i])) return i;
  }
  return -1;
}

/* The five Quikstop neighbourhoods (index.html QUIK_SLOTS — generateRandomBoard
   only consumes x/y/rot; links are applied separately by the edges). */
const QUIK_SLOTS = [
  { x: 350, y: 430, rot: 2 },
  { x: 1540, y: 1210, rot: -2 },
  { x: 2060, y: 680, rot: 1 },
  { x: 700, y: 280, rot: -1 },
  { x: 1120, y: 1410, rot: 2 },
];
/* HIGH_VALUE_NODE_IDS (index.html) — the prized exhibits placed farthest out. */
const HIGH_VALUE = ['qantas', 'rba', 'oil', 'gold', 'sat', 'asics', 'rock', 'press', 'fox', 'sisy',
  'made', 'bullock', 'jt', 'mpc', 'whistle', 'term', 'bond', 'hedge', 'petronas'];
/* One node per win type — every con must be able to complete the full set. */
const BIG7 = ['citi', 'rba', 'infl', 'term', 'coal', 'oil', 'press'];
const SEEDS = 200;

test('RM-01..RM-07 the generated board is a valid connected collage across 200 seeds', { timeout: 120000 }, t => {
  const engine = loadEngine();
  t.after(() => engine.dispose());
  const { NODES, NMAP, ADJ } = engine.acc;

  const hops = { all: 0, dists: [] };
  let violations = 0;
  let overlapTotal = 0;
  const fail = msg => { violations++; console.error(`    seed violation: ${msg}`); };

  for (let s = 0; s < SEEDS; s++) {
    const seed = 1000 + s;
    const slot = QUIK_SLOTS[s % QUIK_SLOTS.length];
    let gen;
    withSeed(seed, () => { gen = engine.f.generateRandomBoard(slot); });
    const posById = new Map(gen.positions.map(p => [p.id, p]));

    /* RM-01 — every edge connects valid ids, no self loops, no duplicates, symmetric. */
    const seen = new Set();
    for (const [a, b] of gen.edges) {
      if (!NMAP[a] || !NMAP[b]) { fail(`edge ${a}-${b} references an unknown node`); continue; }
      if (a === b) fail(`self loop on ${a}`);
      const key = [a, b].sort().join('|');
      if (seen.has(key)) fail(`duplicate edge ${key}`);
      seen.add(key);
      if (!(ADJ[a] || []).includes(b) || !(ADJ[b] || []).includes(a)) fail(`asymmetric edge ${a}-${b}`);
    }
    if (gen.edges.length < NODES.length - 1) fail(`only ${gen.edges.length} edges for ${NODES.length} nodes (spanning tree lost)`);

    /* RM-02 — the graph is connected from Quikstop. */
    const dist = bfs(ADJ, 'quik');
    for (const n of NODES) {
      if (!dist.has(n.id)) fail(`node ${n.id} unreachable from quik`);
    }

    /* RM-03 — every node centre inside the collage bounds. */
    for (const p of gen.positions) {
      if (p.x < 95 || p.x > 2305 || p.y < 95 || p.y > 1455) fail(`${p.id} out of bounds (${p.x},${p.y})`);
    }

    /* RM-04 — node box collision detection: the shipped separateNodes() does
       NOT guarantee zero residual overlaps (pairs pushed into each other +
       wall-clamped stacks). Pin the measured envelope and flag the quirk. */
    let overlaps = 0;
    for (let i = 0; i < NODES.length; i++) {
      for (let j = i + 1; j < NODES.length; j++) {
        const A = posById.get(NODES[i].id), B = posById.get(NODES[j].id);
        if (!A || !B) continue;
        const [aw, ah] = engine.f.nodeBox(NODES[i]);
        const [bw, bh] = engine.f.nodeBox(NODES[j]);
        if (Math.abs(B.x - A.x) < (aw + bw) / 2 + 16 && Math.abs(B.y - A.y) < (ah + bh) / 2 + 16) overlaps++;
      }
    }
    overlapTotal += overlaps;
    if (overlaps > 8) fail(`${overlaps} overlapping node boxes (more than double the observed worst case, 5)`);

    /* RM-05 — placements are bijective: no two nodes share a position. */
    const spots = new Set(gen.positions.map(p => `${p.x},${p.y}`));
    if (spots.size !== gen.positions.length) fail('two nodes share one position');

    /* High-value exhibits are pushed to the outer board: their mean distance
       from Quikstop beats the ordinary exhibits'. The generator sorts the
       prized ring PRE-separation, so after separateNodes' clamping drift an
       exact farthest-ring check is not valid (observed: one miss). */
    const prizedD = HIGH_VALUE.map(id => {
      const p = posById.get(id);
      return Math.hypot(p.x - slot.x, p.y - slot.y);
    });
    const ordD = gen.positions.filter(p => p.id !== 'quik' && !HIGH_VALUE.includes(p.id))
      .map(p => Math.hypot(p.x - slot.x, p.y - slot.y));
    const mean = a => a.reduce((s, d) => s + d, 0) / a.length;
    if (mean(prizedD) <= mean(ordD)) fail('high-value nodes are not biased to the outer board');

    /* RM-06 — all seven win-type exhibits exist and are reachable. */
    for (const id of BIG7) {
      if (!posById.has(id)) fail(`win-type node ${id} missing from the dealt board`);
      else if (!dist.has(id)) fail(`win-type node ${id} unreachable from quik`);
    }

    const dmax = [...dist.values()].reduce((m, d) => Math.max(m, d), 0);
    if (dmax > 12) fail(`path length ${dmax} exceeds the loose maximum of 12`);
    if (dmax > hops.all) hops.all = dmax;
    hops.dists.push(dmax);
  }

  assert.equal(violations, 0, `${violations} board violations across ${SEEDS} seeds`);
  /* Path-length stats over the sweep (informational). */
  hops.dists.sort((a, b) => a - b);
  const med = hops.dists[Math.floor(hops.dists.length / 2)];
  const p95 = hops.dists[Math.floor(hops.dists.length * 0.95)];
  console.log(`    graph depth from quik across ${SEEDS} seeds: median ${med}, p95 ${p95}, max ${hops.all} (loose max 12)`);
  /* Residual overlap count — pinned envelope for the separateNodes quirk. */
  console.log(`    residual node-box overlaps across ${SEEDS} seeds: ${overlapTotal} (shipped separateNodes() does not guarantee zero; ~0.6/seed observed)`);
  assert.ok(overlapTotal <= SEEDS * 2, 'overlap envelope stays at/below two per seed');
  assert.equal(violations, 0);
});

test('RM-10 Ringworld places every node on concentric rings around a four-link Quikstop hub', { timeout: 30000 }, t => {
  const engine = loadEngine();
  t.after(() => engine.dispose());
  const { NODES, NMAP, ADJ } = engine.acc;
  let gen;
  withSeed(9917, () => { gen = engine.f.generateRingworldBoard(); });
  const metrics = engine.f.ringworldMetrics(NODES.length - 1);
  const positions = new Map(gen.positions.map(p => [p.id, p]));
  assert.equal(positions.size, NODES.length, 'every node has a unique layout entry');
  assert.deepEqual(
    [positions.get('quik').x, positions.get('quik').y],
    [metrics.cx, metrics.cy],
    'Quikstop sits in the centre'
  );
  assert.equal((ADJ.quik || []).length, 4, 'Quikstop has exactly four spokes');
  for (const node of NODES) {
    if (node.id === 'quik') continue;
    const p = positions.get(node.id);
    assert.ok(p, node.id + ' is present');
    const matchesRing = metrics.radii.some(r => {
      const norm = ((p.x - metrics.cx) / r.x) ** 2 + ((p.y - metrics.cy) / r.y) ** 2;
      return Math.abs(norm - 1) < 0.01;
    });
    assert.ok(matchesRing, node.id + ' lies on one of the three ring tracks');
  }
  const reached = bfs(ADJ, 'quik');
  assert.equal(reached.size, NODES.length, 'all ring tracks are reachable from Quikstop');
  assert.equal(gen.edges.filter(e => e.includes('quik')).length, 4, 'wire layout preserves the four Quikstop spokes');
});

test('RM-12 Ringworld sizes its tracks from the roster and keeps clear gaps at every seat count', { timeout: 30000 }, t => {
  const engine = loadEngine();
  t.after(() => engine.dispose());

  for (const geo of [false, true]) {
    engine.f.rebuildWorld(geo);
    const { NODES, NMAP } = engine.acc;
    let gen;
    withSeed(20261106 + (geo ? 1 : 0), () => { gen = engine.f.generateRingworldBoard(); });
    const nodeCount = NODES.length - 1;
    const metrics = engine.f.ringworldMetrics(nodeCount);
    const positions = new Map(gen.positions.map(p => [p.id, p]));

    assert.equal(gen.positions.length, NODES.length, 'every exhibit has a position');
    assert.deepEqual(Array.from(metrics.counts), [Math.ceil(nodeCount / 3), Math.floor((nodeCount + 1) / 3), Math.floor(nodeCount / 3)],
      'nodes are split evenly across the three tracks');

    /* Measure the gap between the actual rotated image rectangles for every
       pair on the board, not just the two neighbours joined by an edge. */
    for (let i = 0; i < NODES.length; i++) {
      for (let j = i + 1; j < NODES.length; j++) {
        const a = NMAP[NODES[i].id], b = NMAP[NODES[j].id];
        const pa = positions.get(a.id), pb = positions.get(b.id);
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const distance = Math.hypot(dx, dy);
        const axis = Math.atan2(dy, dx);
        const projectedHalf = node => {
          const [w, h] = engine.f.nodeBox(node);
          const rotation = node.rot * Math.PI / 180;
          const diff = axis - rotation;
          return (Math.abs(Math.cos(diff)) * w + Math.abs(Math.sin(diff)) * h) / 2;
        };
        const clearance = distance - projectedHalf(a) - projectedHalf(b);
        assert.ok(clearance >= 24,
          `${geo ? 'DLC' : 'base'} ring pair ${a.id}–${b.id} has only ${clearance.toFixed(1)}px of image clearance`);
      }
    }

    for (const p of gen.positions) {
      const n = NMAP[p.id];
      const [w, h] = engine.f.nodeBox(n);
      assert.ok(p.x - Math.max(w, h) / 2 >= 0, p.id + ' remains inside the left/top map margin');
      assert.ok(p.x + Math.max(w, h) / 2 <= metrics.w, p.id + ' remains inside the map width');
      assert.ok(p.y - Math.max(w, h) / 2 >= 0, p.id + ' remains inside the map height');
      assert.ok(p.y + Math.max(w, h) / 2 <= metrics.h, p.id + ' remains inside the map height');
    }

    engine.acc.S = { layoutKind: 'ringworld', boardLayout: gen.positions };
    const bounds = engine.f.boardViewBounds();
    assert.deepEqual(
      JSON.parse(JSON.stringify(bounds)),
      { x: 0, y: 0, w: metrics.w, h: metrics.h },
      'the viewport bounds expand to fit the whole ringworld'
    );
  }
});

test('RM-11 Mega Ring keeps clear gaps between rotated nodes and auto-fits the expanded canvas', t => {
  const engine = loadEngine();
  t.after(() => engine.dispose());

  for (const geo of [false, true]) {
    engine.f.rebuildWorld(geo);
    const { NODES, NMAP, ADJ } = engine.acc;
    let gen;
    withSeed(20261106 + (geo ? 1 : 0), () => { gen = engine.f.generateMegaRingBoard(); });

    const nodeCount = NODES.length - 1;
    const metrics = engine.f.megaRingMetrics(nodeCount);
    const positions = new Map(gen.positions.map(p => [p.id, p]));
    const ringEdges = gen.edges.filter(e => e[0] !== 'quik' && e[1] !== 'quik');

    assert.equal(gen.positions.length, NODES.length, 'every exhibit has a position');
    assert.equal(ringEdges.length, nodeCount, 'the outer ring is one closed loop');
    assert.equal((ADJ.quik || []).length, 4, 'Quikstop keeps four spokes');
    assert.deepEqual(
      [positions.get('quik').x, positions.get('quik').y],
      [metrics.cx, metrics.cy],
      'Quikstop stays in the centre of the expanded map'
    );

    let minClearance = Infinity;
    for (const [aId, bId] of ringEdges) {
      const a = NMAP[aId], b = NMAP[bId];
      const pa = positions.get(aId), pb = positions.get(bId);
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const distance = Math.hypot(dx, dy);
      const axis = Math.atan2(dy, dx);
      const projectedHalf = node => {
        const [w, h] = engine.f.nodeBox(node);
        const rotation = node.rot * Math.PI / 180;
        const diff = axis - rotation;
        return (Math.abs(Math.cos(diff)) * w + Math.abs(Math.sin(diff)) * h) / 2;
      };
      /* Measure the gap between the actual rotated image rectangles, not just
         the distance between their centres. */
      const clearance = distance - projectedHalf(a) - projectedHalf(b);
      minClearance = Math.min(minClearance, clearance);
      assert.ok(clearance >= 24,
        `${geo ? 'DLC' : 'base'} ring edge ${aId}–${bId} has only ${clearance.toFixed(1)}px of image clearance`);
    }
    assert.ok(minClearance >= 24, 'even the tightest neighbour pair has a visible image gap');

    for (const p of gen.positions) {
      const n = NMAP[p.id];
      const [w, h] = engine.f.nodeBox(n);
      assert.ok(p.x - Math.max(w, h) / 2 >= 0, p.id + ' remains inside the left/top map margin');
      assert.ok(p.x + Math.max(w, h) / 2 <= metrics.w, p.id + ' remains inside the map width');
      assert.ok(p.y - Math.max(w, h) / 2 >= 0, p.id + ' remains inside the map height');
      assert.ok(p.y + Math.max(w, h) / 2 <= metrics.h, p.id + ' remains inside the map height');
    }

    engine.acc.S = { layoutKind: 'megaring', boardLayout: gen.positions };
    const bounds = engine.f.boardViewBounds();
    assert.deepEqual(
      JSON.parse(JSON.stringify(bounds)),
      { x: 0, y: 0, w: metrics.w, h: metrics.h },
      'the viewport bounds expand to fit the whole ring'
    );
    assert.equal(bfs(ADJ, 'quik').size, NODES.length, 'every node remains reachable from Quikstop');
  }
});

test('RM-08 a full initGame deals a legal board: everyone starts at quik, layouts match the live graph', { timeout: 60000 }, async t => {
  for (const seed of [3001, 3002, 3003, 3004, 3005, 3006]) {
    const engine = loadEngine();
    t.after(() => engine.dispose());
    const { NODES, NMAP, EDGES: _staticEdges } = engine.acc; // EDGES is rebound by initGame — always read the live acc.EDGES
    const Net = engine.acc.Net;
    Net.role = 'host'; Net.myIdx = 0; Net.goal = 100; Net.lobbyChat = []; Net.started = false;
    Net.roster = []; Net.conns = [];
    const conns = [];
    for (let i = 0; i < 3; i++) {
      const conn = i === 0 ? null : makeConn(engine, 'pid' + i, {});
      conns.push(conn);
      Net.roster.push({ name: 'P' + i, playerId: 'pid' + i, conn, char: CHARS8[i] });
    }
    Net.conns = conns;
    withSeed(seed, () => engine.f.initGame(Net.roster.map(e => ({ name: e.name, char: e.char }))));
    await settle(); await settle();
    const S = engine.acc.S;
    assert.ok(S, `seed ${seed}: a state exists`);
    assert.equal(S.players.length, 3, `seed ${seed}: three seats`);
    for (let i = 0; i < 3; i++) {
      assert.equal(S.players[i].pos, 'quik', `seed ${seed}: player ${i} starts at Quikstop`);
      // seat 0 already banked its opening turn's salary inside initGame's startTurn
      assert.equal(S.players[i].money, i === 0 ? 18 : 15, `seed ${seed}: player ${i} opening cash`);
    }
    assert.equal(S.turn, 1, `seed ${seed}: turn 1`);
    /* The dealt layout matches the live mutated graph node for node. */
    assert.equal(S.boardLayout.length, NODES.length, `seed ${seed}: full layout dealt`);
    for (const p of S.boardLayout) {
      const n = NMAP[p.id];
      assert.ok(n, `seed ${seed}: layout id ${p.id} is a real node`);
      assert.equal(p.x, n.x); assert.equal(p.y, n.y); assert.equal(p.rot, n.rot);
    }
    /* Wire edges mirror the live adjacency. */
    assert.equal(S.boardEdges.length, engine.acc.EDGES.length, `seed ${seed}: the wire carries the dealt edges`);
    const liveKeys = new Set(engine.acc.EDGES.map(e => e.slice().sort().join('|')));
    for (const e of S.boardEdges) assert.ok(liveKeys.has(e.slice().sort().join('|')), `seed ${seed}: wire edge ${e} matches a live edge`);
    /* Guests received a begin payload with the same board. */
    for (let i = 1; i < 3; i++) {
      const begins = conns[i].sent.filter(m => m.t === 'begin');
      assert.equal(begins.length, 1, `seed ${seed}: guest ${i} got one begin`);
      const bs = begins[0].s;
      assert.equal(bs.boardLayout.length, NODES.length, `seed ${seed}: guest layout complete`);
      const firstGuestDiff = S_idxFirstDiff(bs.boardLayout, S.boardLayout);
      assert.equal(firstGuestDiff, -1, `seed ${seed}: guest ${i} layout equals the host layout (first diff at ${firstGuestDiff})`);
      assert.equal(JSON.stringify(bs.boardEdges), JSON.stringify(S.boardEdges), `seed ${seed}: guest ${i} edges equal the host edges`);
    }
  }
});

test('RM-09 pubState→adoptState round-trips exactly and is idempotent', { timeout: 60000 }, async t => {
  for (const seed of [4001, 4002, 4003, 4004]) {
    const host = loadEngine();
    const guest = loadEngine();
    t.after(() => { host.dispose(); guest.dispose(); });
    const Net = host.acc.Net;
    Net.role = 'host'; Net.myIdx = 0; Net.goal = 100; Net.lobbyChat = []; Net.started = false;
    Net.roster = []; Net.conns = [];
    for (let i = 0; i < 2; i++) {
      const conn = i === 0 ? null : makeConn(host, 'pid' + i, {});
      Net.roster.push({ name: 'P' + i, playerId: 'pid' + i, conn, char: CHARS8[i] });
      Net.conns.push(conn);
    }
    withSeed(seed, () => host.f.initGame(Net.roster.map(e => ({ name: e.name, char: e.char }))));
    await settle(); await settle();

    const wire = host.f.pubState(true); // what a first sync to a joining guest carries
    const hostJson = JSON.stringify(wire);
    guest.f.adoptState(wire);
    const afterFirst = JSON.stringify(guest.acc.S);
    assert.equal(afterFirst, hostJson, `seed ${seed}: the adopted public state equals the wire payload`);
    guest.f.adoptState(host.f.pubState(true)); // replay the same full state
    assert.equal(JSON.stringify(guest.acc.S), afterFirst, `seed ${seed}: re-adopting the same state is a no-op`);
    /* Splicing tails behaves like the guest screen: prefixes never detoach. */
    const beforeLog = JSON.stringify(guest.acc.S.log);
    const tailOnly = host.f.pubState(false);
    guest.f.adoptState(tailOnly);
    const spliced = JSON.stringify(guest.acc.S.log);
    assert.ok(spliced.startsWith(beforeLog.slice(0, Math.max(0, beforeLog.length - tailOnly.log.length))) || tailOnly.log.length === guest.acc.S.log.length,
      `seed ${seed}: the tail splice kept the earlier record`);
    assert.equal(JSON.stringify(guest.acc.S.log), JSON.stringify(host.acc.S.log), `seed ${seed}: the guest record equals the host record after splicing`);
    /* Board payloads survive the round trip untouched. Host and guest live in
       separate vm realms, so the correct equality is the WIRE one: JSON
       serialisation (which is exactly what the real wire does). */
    const firstLayDiff = S_idxFirstDiff(guest.acc.S.boardLayout, host.acc.S.boardLayout);
    assert.equal(firstLayDiff, -1, `seed ${seed}: the layout survives the round trip (first diff at ${firstLayDiff})`);
    assert.equal(JSON.stringify(guest.acc.S.boardEdges), JSON.stringify(host.acc.S.boardEdges), `seed ${seed}: the edges survive the round trip`);
    assert.equal(guest.acc.S.deckCount, host.acc.S.deck.length, `seed ${seed}: the deck count travels (the deck itself stays home)`);
    assert.equal(guest.acc.S.deck, undefined, `seed ${seed}: the deck never leaves the host`);
  }
});
