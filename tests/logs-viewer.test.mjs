import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../logs.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

function loadViewer() {
  const context = {
    document: { readyState: 'loading', addEventListener() {} },
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    Blob,
    URL,
    btoa,
    atob
  };
  vm.createContext(context);
  vm.runInContext(scripts[0][2], context, { filename: 'logs.html' });
  return context;
}

test('logs.html is a complete standalone viewer with one parseable script', () => {
  assert.equal((html.match(/<!doctype html>/gi) || []).length, 1);
  assert.equal((html.match(/<\/html>/gi) || []).length, 1);
  assert.match(html.trimEnd(), /<\/html>$/i);
  assert.equal(scripts.length, 1, 'one inline script owns the viewer');
  for (const id of ['raw', 'viewer', 'log', 'playerChips', 'catList', 'search', 'jumpTurn', 'btnShare']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'viewer has #' + id);
  }
  assert.doesNotThrow(() => new vm.Script(scripts[0][2], { filename: 'logs.html' }));
});

test('the record parser finds the table, turn blocks, players and event buckets', () => {
  const context = loadViewer();
  const record = [
    '🌅 A new board is dealt — 70 exhibits, 194 freshly rebuilt connections, 2 at the table.',
    '🎲 Seating was shuffled. First to move: ALICE.',
    '🏆 WIN CONDITION: $100 in the bank AND one of every node type. The host set the target.',
    '—— TURN 7 · ALICE ——',
    '💵 ALICE collects $12 (salary $3 + holdings $9 + synergies $0) — now $40.',
    '→ ALICE moves to THE ROCK CAN SMELL IT.',
    '🚨 REGULATOR RAID! ALICE is stripped of THE ROCK CAN SMELL IT — cameras everywhere.',
    '—— TURN 7 · BOB ——',
    '💵 BOB collects $9 (salary $3 + holdings $6 + synergies $0) — now $22.',
    '🏆 BOB banks $120 with the full set of node types — the target was $100. The con is complete.'
  ].join('\n');

  const rec = context.parseRecord(record);
  assert.deepEqual(Array.from(rec.players, (p) => p.name), ['ALICE', 'BOB']);
  assert.equal(rec.turnCount, 2);
  assert.equal(rec.firstTurn, 7);
  assert.equal(rec.lastTurn, 7);
  assert.equal(rec.turns[0].name, 'ALICE');
  assert.equal(rec.turns[1].name, 'BOB');

  const raid = rec.entries.find((e) => e.text.includes('REGULATOR RAID'));
  assert.ok(raid.cats.has('raid'), 'a raid is in the raid bucket');
  assert.deepEqual(Array.from(raid.players), ['ALICE']);
  assert.equal(raid.kind, 'raid');

  const win = rec.entries.find((e) => e.text.startsWith('🏆 BOB banks'));
  assert.ok(win.cats.has('win'), 'a banked full set is a win');
  assert.equal(win.kind, 'win');

  const setup = rec.entries.find((e) => e.text.includes('WIN CONDITION'));
  assert.ok(setup.cats.has('setup'), 'the win condition belongs to setup, not wins');
  assert.ok(!setup.cats.has('win'));

  const move = rec.entries.find((e) => e.text.startsWith('→'));
  assert.ok(move.cats.has('move'));
  assert.deepEqual(Array.from(move.players), ['ALICE']);
});

test('player matching is boundary-safe, longest-first and falls back without headers', () => {
  const context = loadViewer();

  const rec = context.parseRecord([
    '—— TURN 1 · ANA MARIA ——',
    '💵 ANA MARIA collects $5 — now $20.',
    '📈 MARKET: CALM (no modifiers).',
    '—— TURN 2 · ANA ——',
    '💵 ANA collects $1 — now $21.'
  ].join('\n'));
  assert.deepEqual(Array.from(rec.players, (p) => p.name), ['ANA MARIA', 'ANA']);
  const maria = rec.entries.find((e) => e.text.includes('ANA MARIA collects'));
  assert.deepEqual(Array.from(maria.players), ['ANA MARIA'], 'the longer name wins the overlap');
  const market = rec.entries.find((e) => e.text.includes('MARKET: CALM'));
  assert.deepEqual(Array.from(market.players), [], 'a name does not match inside a longer word');

  const fallback = context.parseRecord([
    '💵 CAROL collects $10 — now $30.',
    '💸 DAVE loses $2 — inflation bites.',
    '→ CAROL moves to ACCC.'
  ].join('\n'));
  assert.deepEqual(Array.from(fallback.players, (p) => p.name), ['CAROL', 'DAVE']);
  assert.equal(fallback.turnCount, 0);
});
