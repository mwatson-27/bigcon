import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, makeGame, CHARS8 } from './helpers/harness.mjs';

test('engine loads and can start a solo test game', async t => {
  const engine = loadEngine();
  t.after(() => engine.dispose());
  const S = await makeGame(engine, 1);
  assert.ok(S, 'state created');
  assert.equal(S.phase, 'move');
  assert.equal(S.players.length, 1);
  assert.equal(S.cur, 0);
  assert.equal(S.turn, 1);
  assert.equal(engine.f.abilityPhase(0), false); // move phase is not the ability phase
  S.phase = 'action';
  assert.equal(engine.f.abilityPhase(0), true);
  assert.ok(CHARS8.length >= 8);
});

