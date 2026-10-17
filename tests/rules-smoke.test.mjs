import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `could not find ${marker}`);
  const brace = html.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = brace; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function harness({ owners = {}, players = [], nodes = [], owner = null, eventOwner = {} } = {}) {
  const state = {
    owner: { ...owners, ...eventOwner },
    players: players.map(p => ({ money: 0, intel: 0, cortisol: 0, ...p })),
    bugs: {},
  };
  const logs = [];
  const effects = [];
  const payouts = [];
  const context = {
    S: state,
    NODES: nodes.map((n, id) => ({ id: n.id ?? String(id), income: 0, cost: 0, ...n })),
    log: message => logs.push(message),
    fxAt: (...args) => effects.push(args),
    fx: (...args) => effects.push(args),
    pname: i => `P${i}`,
    gain: (i, amount, why) => { state.players[i].money += amount; payouts.push({ type: 'gain', i, amount, why }); },
    giveIntel: (i, amount, why) => { state.players[i].intel += amount; payouts.push({ type: 'intel', i, amount, why }); },
    payVoid: (i, amount, why) => { state.players[i].money -= amount; payouts.push({ type: 'pay', i, amount, why }); },
    raid: i => { state.players[i].raids = (state.players[i].raids || 0) + 1; state.players[i].cortisol = 0; },
    HIGH_VALUE_NODE_IDS: new Set(),
    console,
    Math,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('addCortisol'), context);
  vm.runInContext(extractFunction('madePay'), context);
  return { state, logs, effects, payouts, run: (name, ...args) => context[name](...args) };
}

test('Cortisol protection currently ignores positive changes with zero or one owned node', () => {
  for (const ownedCount of [0, 1]) {
    const nodes = Array.from({ length: ownedCount }, (_, i) => ({ id: `n${i}` }));
    const owners = Object.fromEntries(nodes.map(n => [n.id, 0]));
    const h = harness({ owners, nodes, players: [{ cortisol: 2 }] });
    h.run('addCortisol', 0, 2, 'test', false);
    assert.equal(h.state.players[0].cortisol, 2);
    assert.equal(h.logs.length, 0);
  }
});

test('Cortisol reaching the raid threshold triggers a raid and resets Cortisol', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }];
  const h = harness({ owners: { a: 0, b: 0 }, nodes, players: [{ cortisol: 7 }] });
  h.run('addCortisol', 0, 4, 'test', false);
  assert.equal(h.state.players[0].cortisol, 0); // raid resets Cortisol
  assert.equal(h.state.players[0].raids, 1);
});

test('Cortisol reductions work at zero and never go below zero', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }];
  const h = harness({ owners: { a: 0, b: 0 }, nodes, players: [{ cortisol: 0 }] });
  h.run('addCortisol', 0, -2, 'test', false);
  assert.equal(h.state.players[0].cortisol, 0);
  h.state.players[0].cortisol = 1;
  h.run('addCortisol', 0, -2, 'test', false);
  assert.equal(h.state.players[0].cortisol, 0);
});

test('MADE pays its owner $10 and 1 Intel when owned', () => {
  const h = harness({ owners: { made: 0 }, players: [{ money: 5, intel: 0 }] });
  h.run('madePay');
  assert.equal(h.state.players[0].money, 15);
  assert.equal(h.state.players[0].intel, 1);
});

test('MADE takes 15% only from opponents with more than 2 nodes and at least $50', () => {
  const nodes = [
    { id: 'made' }, { id: 'a1' }, { id: 'a2' },
    { id: 'b1' }, { id: 'b2' }, { id: 'b3' },
    { id: 'c1' }, { id: 'c2' }, { id: 'c3' },
  ];
  const owners = { made: 0, a1: 1, a2: 1, b1: 2, b2: 2, b3: 2, c1: 3, c2: 3, c3: 3 };
  const players = [{ money: 0 }, { money: 100 }, { money: 49 }, { money: 50 }];
  const h = harness({ owners, nodes, players });
  h.run('madePay');
  assert.equal(h.state.players[0].money, 10);
  assert.equal(h.state.players[1].money, 100); // exactly 2 nodes: ineligible
  assert.equal(h.state.players[2].money, 49); // below $50: ineligible
  assert.equal(h.state.players[3].money, 43); // 15% of $50 rounds down to $7
});

test('MADE does nothing when unowned', () => {
  const h = harness({ players: [{ money: 20, intel: 2 }] });
  h.run('madePay');
  assert.equal(h.state.players[0].money, 20);
  assert.equal(h.state.players[0].intel, 2);
  assert.equal(h.payouts.length, 0);
});
