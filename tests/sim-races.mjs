#!/usr/bin/env node
/* Race simulator — NOT a node:test file.
 *
 * Runs N seeded all-bot games headless and reports per-character win rates,
 * average game length and stalls, so strategy profiles can be compared.
 *
 *   node tests/sim-races.mjs [--games 24] [--table 4] [--goal 100]
 *                           [--geo 0] [--chars a,b,c] [--variant baseline]
 *                           [--json out.json]
 *
 * --variant scales every per-character profile uniformly (BigConBots.setVariant):
 * the point is to race plan-first vs aggression-first vs cash-first temperaments
 * and bake the winner into static/bots.js. Same games (seeds + rosters) for every
 * variant, so the comparison is apples to apples.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadEngine, pump, repoRoot, withSeedAsync } from './helpers/harness.mjs';

const BOT_SRC = fs.readFileSync(path.join(repoRoot, 'static', 'bots.js'), 'utf8');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; if (args[a.slice(2)] !== true) i++; }
}
const GAMES = Number(args.games || 24);
const TABLE = Number(args.table || 4);
const GOAL = Number(args.goal || 100);
const GEO = args.geo === '1' || args.geo === 'true';
const VARIANT = String(args.variant || 'baseline');
const ROSTER = String(args.chars || 'markwatson,bessock,DJT,denialswan,tomkins,thousandyardwax,thebigag,japsnchen').split(',').map(s => s.trim()).filter(Boolean);
const OUT = args.json || null;
const TURN_CAP = 400; /* a game past this counts as a stall */

/* All-bot makeGame: explicit character roster, no seat-retry rigamarole (flow
   tests need the host on seat 0; sims do not care about seating). */
async function simGame(engine, chars, seed) {
  const Net = engine.acc.Net;
  Net.role = 'host';
  Net.myIdx = 0;
  Net.goal = GOAL;
  Net.dlcGeo = GEO;
  Net.started = false;
  Net.begun = true;
  Net.lobbyChat = [];
  Net.roster = [];
  Net.conns = [];
  const defs = chars.map((id, i) => ({ name: 'BOT ' + (i + 1) + ' ' + id, playerId: 'sim-' + seed + '-' + i, conn: null, char: id, bot: true }));
  engine.ctx.window.__BIGCON_BOT_SEED__ = 1000 + seed;
  await withSeedAsync(seed, () => engine.f.initGame(defs));
  return engine.acc.S;
}

async function driveToOver(engine, S) {
  for (let i = 0; i < 30000 && !S.over; i++) {
    await pump(2);
    if (engine.clock.pending()) engine.clock.advance(25);
  }
}

const stats = {};   /* char -> { games, wins, winTurns } */
let totalTurns = 0, finished = 0, stalled = 0, totalIntents = 0;

for (let g = 0; g < GAMES; g++) {
  const engine = loadEngine();
  try {
    engine.ctx.window.__BIGCON_TEST__ = true; /* zero pacing — pure simulation speed */
    vm.runInContext(BOT_SRC, engine.ctx, { filename: 'static/bots.js' });
    engine.ctx.window.BigConBots.setVariant(VARIANT);
    engine.ctx.__simIntents = 0;
    vm.runInContext(`(() => {
      const oa = applyIntent;
      applyIntent = async function (pi, m) { __simIntents++; return oa(pi, m); };
    })()`, engine.ctx, { filename: 'sim-instrument' });

    /* rotate the roster so every character sees every seat over the run */
    const chars = [];
    for (let i = 0; i < TABLE; i++) chars.push(ROSTER[(g + i) % ROSTER.length]);

    const S = await simGame(engine, chars, g);
    await driveToOver(engine, S);

    const intents = engine.ctx.__simIntents;
    totalIntents += intents;
    const turns = S.turn;
    for (const id of chars) {
      const st = stats[id] || (stats[id] = { games: 0, wins: 0, winTurns: [] });
      st.games++;
    }
    let winnerId = null;
    if (S.over) {
      finished++;
      totalTurns += turns;
      /* the winCheck winner announced in the log: "🏆 <name> banks $N ..." */
      const last = S.log[S.log.length - 1] || '';
      const m = last.match(/🏆\s*(.+?)\s+banks \$/);
      if (m) {
        const seat = S.players.findIndex(p => p.name === m[1]);
        if (seat >= 0) {
          const ch = S.players[seat].char;
          winnerId = ch;
          if (stats[ch]) { stats[ch].wins++; stats[ch].winTurns.push(turns); }
        }
      }
    } else {
      stalled++;
    }
    process.stdout.write(`game ${String(g + 1).padStart(3)}  turns ${String(turns).padStart(3)}  intents ${String(intents).padStart(5)}  ${S.over ? 'WIN ' + String(winnerId).padEnd(16) : 'STALL'}  [${chars.join(', ')}]\n`);
  } finally {
    engine.dispose();
  }
}

console.log('\n=== variant: ' + VARIANT + ' — ' + GAMES + ' games, table of ' + TABLE + ', goal $' + GOAL + (GEO ? ', geo DLC' : '') + ' ===');
console.log('finished ' + finished + '/' + GAMES + '  stalls ' + stalled + '  avg turns ' + (finished ? (totalTurns / finished).toFixed(1) : '-') + '  avg intents ' + Math.round(totalIntents / GAMES));
const rows = Object.keys(stats).map(id => {
  const st = stats[id];
  const wts = st.winTurns.length ? (st.winTurns.reduce((a, b) => a + b, 0) / st.winTurns.length).toFixed(1) : '-';
  return { id, games: st.games, wins: st.wins, pct: ((st.wins / st.games) * 100).toFixed(1), avgTurns: wts };
});
rows.sort((a, b) => b.wins - a.wins);
console.log('\nchar                 games  wins  win%   avg win turns');
for (const r of rows) console.log(r.id.padEnd(20) + String(r.games).padStart(5) + String(r.wins).padStart(6) + String(r.pct).padStart(6) + '%  ' + r.avgTurns);

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ variant: VARIANT, games: GAMES, table: TABLE, goal: GOAL, geo: GEO, finished, stalled, avgTurns: finished ? totalTurns / finished : null, stats }, null, 2));
  console.log('\nwrote ' + OUT);
}
