/*
 * Board hover / right-click path: shortestPath() routes over the edges the
 * viewer can see (so fog of war cannot be read off the overlay), and
 * drawHighlights() paints into the persistent #hlg layer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, makeGame } from './helpers/harness.mjs';

const setup = async (t, opts = {}) => {
  const e = await loadEngine();
  t.after(() => e.dispose());
  if (opts.fog) e.acc.Net.fogOfWar = true;
  const S = await makeGame(e, 2);
  return { e, S };
};

/* independent breadth-first distances over the full graph */
function distances(ADJ, from) {
  const d = { [from]: 0 };
  const q = [from];
  for (let i = 0; i < q.length; i++) for (const v of ADJ[q[i]] || []) if (!(v in d)) { d[v] = d[q[i]] + 1; q.push(v); }
  return d;
}

test('PH-01 shortestPath returns a contiguous route of minimal length from my seat', async t => {
  const { e } = await setup(t);
  const { shortestPath } = e.mods.ui;
  const me = e.acc.S.players[e.acc.Net.myIdx].pos;
  const dist = distances(e.acc.ADJ, me);
  const targets = Object.keys(dist).filter(id => dist[id] > 0);
  assert.ok(targets.length > 20, 'the board is one connected component with plenty of nodes');
  for (const to of targets.filter((_, i) => i % 5 === 0)) {
    const path = shortestPath(me, to);
    assert.ok(path, `a route to ${to} exists`);
    assert.equal(path[0], me);
    assert.equal(path.at(-1), to);
    assert.equal(path.length - 1, dist[to], `route to ${to} is as short as the graph allows`);
    for (let i = 0; i < path.length - 1; i++) {
      assert.ok(e.acc.ADJ[path[i]].includes(path[i + 1]), `${path[i]} → ${path[i + 1]} is a real edge`);
    }
  }
});

test('PH-02 routing to my own node is the single-node path; unknown ids give null', async t => {
  const { e } = await setup(t);
  const { shortestPath } = e.mods.ui;
  const me = e.acc.S.players[e.acc.Net.myIdx].pos;
  assert.deepEqual(shortestPath(me, me), [me]);
  assert.equal(shortestPath(me, 'no-such-node'), null);
  assert.equal(shortestPath('no-such-node', me), null);
});

test('PH-03 the route does not depend on whose turn it is', async t => {
  const { e, S } = await setup(t);
  const { shortestPath } = e.mods.ui;
  const me = e.acc.Net.myIdx;
  const rival = S.players.findIndex((_, i) => i !== me);
  S.cur = rival;
  const from = e.acc.S.players[me].pos;
  const to = Object.keys(distances(e.acc.ADJ, from)).at(-1);
  assert.ok(shortestPath(from, to), 'a route is available on the rival’s turn');
});

test('PH-04 under fog of war the route never leaks undiscovered nodes', async t => {
  const { e } = await setup(t, { fog: true });
  const { shortestPath } = e.mods.ui;
  const S = e.acc.S;
  const me = S.players[e.acc.Net.myIdx];
  assert.deepEqual(Object.keys(me.visited), ['quik']);
  const far = Object.keys(distances(e.acc.ADJ, me.pos)).at(-1);
  assert.equal(shortestPath(me.pos, far), null, 'no route through the unexplored map');
  for (const n of e.acc.ADJ[me.pos]) assert.equal(shortestPath(me.pos, n), null, 'an unvisited neighbour is not routable either');

  /* explore one step, then that node is routable and nothing past it is */
  const step = e.acc.ADJ[me.pos][0];
  me.visited[step] = true;
  assert.deepEqual(shortestPath(me.pos, step), [me.pos, step]);
  assert.equal(shortestPath(me.pos, far), null);
});

test('PH-05 drawHighlights paints only into the persistent #hlg layer and tolerates a missing layer', async t => {
  const { e } = await setup(t);
  const { drawHighlights } = e.mods.ui;
  assert.doesNotThrow(() => drawHighlights(), 'no #hlg layer yet (board not rendered in the stub DOM)');
  const layer = e.env.document.getElementById('hlg');
  layer.innerHTML = '<g/>';
  drawHighlights();
  assert.equal(layer.innerHTML, '', 'nothing hovered or pinned draws nothing');
});
