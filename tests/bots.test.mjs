/*
 * 🤖 BOT SEATS — section BT of docs/CODE_LEVEL_TEST_PLAN.md.
 *
 * A bot is a roster entry {bot:true, conn:null} driven by the host engine: every
 * mutation it causes goes through applyIntent (the same wire gate as a human
 * guest) and the only state it sees is botView() — a redacted snapshot that
 * carries nothing the wire wouldn't. The policy module (static/bots.js) is a
 * Tier-2 deterministic brain: per-seat xorshift streams seeded by
 * window.__BIGCON_BOT_SEED__ and paced-down by window.__BIGCON_TEST__.
 *
 * These tests load the shipped bot module into the same vm realm as the engine
 * and play full games on the virtual clock. An all-bot game must terminate, all
 * of its traffic must be legal, identical seeds must replay identically, and
 * the lobby must be able to seat and dismiss bots.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadEngine, makeGame, pump, snapshot, withSeedAsync, repoRoot, CHARS8 } from './helpers/harness.mjs';

const BOT_SRC = fs.readFileSync(path.join(repoRoot, 'static', 'bots.js'), 'utf8');

/* Boot an engine with the bot module loaded into the realm and instruments
   wrapped around applyIntent (intent ledger) and sysTo (rejection ledger). */
function botEngine(t, botSeed = 4242) {
  const engine = loadEngine();
  t.after(() => engine.dispose());
  engine.ctx.window.__BIGCON_TEST__ = true; /* zero bot pacing */
  engine.ctx.window.__BIGCON_BOT_SEED__ = botSeed;
  vm.runInContext(BOT_SRC, engine.ctx, { filename: 'static/bots.js' });
  engine.ctx.__rec = { intents: [], sys: [], freezeAfter: null, pre: null };
  vm.runInContext(`(() => {
    const origApply = applyIntent;
    applyIntent = async function (pi, m) {
      const rec = __rec;
      if (rec.freezeAfter && rec.freezeAfter.pi === pi && !rec.freezeAfter.hit && S && S.players[pi])
        rec.pre = { money: S.players[pi].money, intel: S.players[pi].intel, cortisol: S.players[pi].cortisol };
      await origApply(pi, m);
      rec.intents.push({ pi, act: m && m.act, id: m && m.id });
      if (rec.freezeAfter && rec.freezeAfter.pi === pi && m.act === rec.freezeAfter.act && !rec.freezeAfter.hit) {
        rec.freezeAfter.hit = true;
        if (S && !S.over) S.over = true; /* the staged effect landed — re-freeze the table */
      }
    };
    const origSys = sysTo;
    sysTo = function (pi, msg) { __rec.sys.push({ pi, msg }); return origSys(pi, msg); };
  })()`, engine.ctx, { filename: 'bots-test-instrument' });
  return engine;
}

/* Drive a bot game on the virtual clock: bot turn chains yield through 0ms
   timers (pump's macrotasks) and block on projPause chains (clock.advance).
   The loop shape is part of the determinism contract in BT-02 — keep it
   identical between runs. */
async function driveToOver(engine, S, maxIters = 6000) {
  for (let i = 0; i < maxIters && !S.over; i++) {
    await pump(2);
    if (engine.clock.pending()) engine.clock.advance(25);
  }
}

/* The engine's rejection replies a bot must never provoke. */
const REJECT_RE = /(Not your turn|red threads|afford|Not enough Intel|unavailable|cannot|Walk away)/i;

test('BT-01 an all-bot table finishes the con through the same intent gate', async t => {
  const engine = botEngine(t);
  const S = await makeGame(engine, 3, { bots: [0, 1, 2], goal: 100, seeds: [41] });
  await driveToOver(engine, S);
  assert.equal(S.over, true, 'the bot game reached a winner inside the iteration budget');

  const rec = engine.ctx.__rec;
  assert.ok(rec.intents.length > 100, 'the bots proposed a healthy number of intents (got ' + rec.intents.length + ')');
  assert.ok(rec.intents.every(it => it.pi >= 0 && it.pi < 3), 'every intent came from a seated bot');
  assert.ok(rec.intents.some(it => it.act === 'seize'), 'the bots seize nodes — they play the con, not the pass');
  assert.ok(rec.intents.some(it => it.act === 'move'), 'the bots move around the board');
  const rejects = rec.sys.filter(s => REJECT_RE.test(s.msg));
  assert.equal(rejects.length, 0, 'no engine rejections aimed at bots — got: '
    + rejects.slice(0, 4).map(r => 'seat' + r.pi + ': ' + r.msg).join(' | '));
  const botErrors = engine.consoleOut.error.filter(l => String(l).includes('bot turn error'));
  assert.equal(botErrors.length, 0, 'no bot turn crashed: ' + String(botErrors[0]).slice(0, 200));
});

test('BT-02 bot games are deterministic: same seed pair, same game', async t => {
  const run = async () => {
    const engine = botEngine(t, 4242);
    const S = await makeGame(engine, 3, { bots: [0, 1, 2], goal: 100, seeds: [41] });
    /* the realm shares the host Math, so this seeds every gameplay roll */
    await withSeedAsync(777, () => driveToOver(engine, S));
    const snap = snapshot(engine);
    engine.dispose();
    return snap;
  };
  const a = await run();
  const b = await run();
  assert.deepStrictEqual(b, a, 'two runs with the same engine+bot seeds play identical games');
});

test('BT-03 botView is redacted: no deck order, log or chat ever leaves the engine', async t => {
  const engine = botEngine(t);
  const S = await makeGame(engine, 3, { bots: [0, 1, 2], goal: 100, seeds: [41] });
  /* plant secrets a cheat would love to see */
  S.deck = ['quiet', 'quiet'];
  S.log.push('SECRET-LOG-MARKER');
  S.chat.push({ who: 'x', msg: 'SECRET-CHAT-MARKER' });

  const v = engine.ctx.botView(1);
  assert.ok(v, 'botView returns a view for a live game');
  for (const k of ['deck', 'log', 'chat']) assert.ok(!(k in v), k + ' is redacted from the bot view');
  const json = JSON.stringify(v);
  assert.ok(!json.includes('SECRET-LOG-MARKER'), 'the log never reaches the bot');
  assert.ok(!json.includes('SECRET-CHAT-MARKER'), 'the chat never reaches the bot');

  /* the view contract the policy module is compiled against — an engine
     refactor that drops one of these must fail here, loudly */
  for (const k of ['pi', 'curSeat', 'players', 'phase', 'steps', 'turn', 'goal', 'over', 'owner', 'bugs',
    'nodes', 'nmap', 'edges', 'cardIds', 'discardIds', 'country', 'oilIds', 'moodRate',
    'geo', 'geoUsed', 'seizePrice', 'takePrice', 'flatSeize', 'missingTypes']) {
    assert.ok(k in v, 'botView carries ' + k);
  }
  assert.equal(v.curSeat, S.cur, 'curSeat mirrors the engine cursor');
  assert.equal(v.nmap.us.id, 'us', 'nmap is keyed by node id');
  assert.ok(v.nmap.us.type, 'nmap entries carry the node type');
  assert.equal(typeof v.missingTypes(1).length, 'number', 'missingTypes helper answers');
  assert.ok(Number.isFinite(v.seizePrice(1, 'us')), 'seizePrice helper answers with a number');
});

test('BT-04 the host lobby can seat and dismiss bots', t => {
  const engine = loadEngine();
  t.after(() => engine.dispose());
  const Net = engine.acc.Net;
  Net.role = 'host';
  Net.myIdx = 0;
  Net.roster = [{ name: 'HOST', playerId: 'host', conn: null, char: null }];
  const ctx = engine.ctx;

  ctx.addBotSeat();
  assert.equal(Net.roster.length, 2, 'a bot took the next empty seat');
  assert.equal(Net.roster[1].bot, true, 'the seat is flagged as a bot');
  assert.equal(Net.roster[1].conn, null, 'the bot has no connection');
  assert.ok(Net.roster[1].char, 'the bot picked a free face so the start button unlocks');

  ctx.addBotSeat();
  assert.notEqual(Net.roster[1].char, Net.roster[2].char, 'two bots never share a face');

  ctx.kickBotSeat(1);
  assert.equal(Net.roster.length, 2, 'kicking removes exactly the one bot');
  assert.ok(Net.roster[1].bot, 'the remaining bot slid into its place');

  ctx.kickBotSeat(0);
  assert.equal(Net.roster.length, 2, 'kicking a human seat is a no-op');
  ctx.kickBotSeat(9);
  assert.equal(Net.roster.length, 2, 'kicking an empty seat is a no-op');

  for (let i = 0; i < 10; i++) ctx.addBotSeat();
  assert.equal(Net.roster.length, engine.acc.MAXPLAYERS, 'the table fills to 8 and refuses more');
  const faces = new Set(Net.roster.map(e => e.char));
  assert.equal(faces.size, engine.acc.MAXPLAYERS, 'every seat at the full table has a unique face');

  /* the host face completes the roster and the start button unlocks */
  Net.roster[0].char = Net.roster[0].char || CHARS8[0];
  engine.f.broadcastLobby();
  assert.equal(engine.elems.get('btnStart').disabled, false, 'a full roster of faced seats unlocks START');
  const size = Net.roster.length;
  const kicked = Net.roster[1];
  ctx.kickBotSeat(1);
  assert.equal(Net.roster.length, size - 1, 'kicking while full frees the seat');
  assert.ok(!Net.roster.includes(kicked), 'the kicked bot is gone from the roster');
});

/* ---------- full coverage: every human action, rational play, banter ---------- */

/* The complete intent vocabulary a seated player (human or bot) can send —
   the engine's applyIntent gate. Every entry must appear in the bot module's
   dispatch, except the documented skips: 'sweep' (the engine keys bugs by
   planter, so sweeping only ever deletes the sweeper's own income streams —
   nothing rationally plays it) and 'cancel' (bots never strand a mode open). */
const PLAYER_ACTS = [
  'move', 'favor', 'slip', 'flymode', 'fly', 'endmove',
  'seize', 'bugmode', 'bug', 'leakmode', 'leak', 'auditmode', 'audit',
  'tweetmode', 'tweet', 'spin', 'roast', 'cook', 'pressure', 'budget', 'push',
  'jog', 'missilemode', 'missile', 'rebuild', 'beach', 'qantasdown', 'oilcrash',
  'venicecool', 'overmode', 'overtour', 'blockmode', 'blockade',
  'spy', 'dossier', 'sweep', 'masspanic', 'targetpanic', 'divestmade',
  'bondmageddon', 'sell', 'sellall', 'laylow',
];
const BOT_SKIPS = ['sweep', 'cancel'];

test('BT-05 the bot module covers the whole human action table', t => {
  const src = fs.readFileSync(path.join(repoRoot, 'static', 'bots.js'), 'utf8');
  const missing = PLAYER_ACTS.filter(a => BOT_SKIPS.indexOf(a) < 0
    && src.indexOf("act: '" + a + "'") < 0 && src.indexOf("act:'" + a + "'") < 0);
  assert.deepEqual(missing, [], 'actions with no bot dispatch: ' + missing.join(', '));
});

/* Boot a game, let the opening chains die down, then freeze the table so a
   rig can stage an exact board state and drive one bot turn by hand.
   Everything runs under a fixed Math seed so the frozen board is reproducible. */
async function rigGame(t, geo) {
  const engine = botEngine(t, 4242);
  const S = await makeGame(engine, 3, { bots: [0, 1, 2], goal: 100, geo });
  S.over = true; /* freeze: every live chain aborts on the next beat */
  for (let i = 0; i < 60 && (engine.clock.pending() || i < 4); i++) {
    await pump(2);
    if (engine.clock.pending()) engine.clock.advance(25);
  }
  return engine;
}

/* Unfreeze for exactly one hand-driven bot turn. The instrument re-freezes the
   table the moment the expected act lands, so endOfTurn cannot wake the other
   seats and let a live game run over the assertions. */
async function driveBotTurn(engine, pi, expectAct) {
  const S = engine.acc.S;
  const rec = engine.ctx.__rec;
  rec.freezeAfter = { pi, act: expectAct, hit: false };
  rec.pre = null;
  S.over = false;
  S.cur = pi;
  S.phase = 'action';
  S.mode = null;
  const turn = engine.ctx.window.BigConBots.takeTurn(pi, engine.ctx.botView(pi), engine.ctx.botAPI(engine.acc.Net.gameEpoch));
  for (let i = 0; i < 60; i++) {
    await pump(2);
    if (engine.clock.pending()) engine.clock.advance(25);
    if (rec.freezeAfter.hit) break;
  }
  await turn;
  S.over = true; /* belt and braces: nothing else may mutate the board */
  await pump(2);
}

test('BT-06a bots plant bugs on adjacent rival nodes', async t => {
  await withSeedAsync(555, async () => {
    const engine = await rigGame(t, false);
    const S = engine.acc.S;
    const pos = Object.keys(engine.acc.ADJ).find(k => engine.acc.ADJ[k].indexOf('us') >= 0 && k !== 'us');
    assert.ok(pos, 'some node is adjacent to the US yields chart');
    for (let j = 0; j < 3; j++) { S.players[j].money = 40; S.players[j].intel = 5; }
    S.players[1].pos = pos;
    S.owner[pos] = 1;
    S.owner.us = 0;
    for (const id in S.owner) if (id !== 'us' && id !== pos) S.owner[id] = null; /* rivals starved of attack surface */
    await driveBotTurn(engine, 1, 'bug');
    const rec = engine.ctx.__rec;
    assert.ok(rec.intents.some(it => it.pi === 1 && it.act === 'bugmode'), 'the bot opened bug mode');
    assert.ok(rec.intents.some(it => it.pi === 1 && it.act === 'bug' && it.id === 'us'), 'the bot planted on the rival chart');
    assert.equal(S.bugs.us, 1, 'the bug landed on the engine state');
    assert.equal(rec.pre.intel, 5, 'the bot held 5 Intel before the plant');
    assert.ok(S.players[1].intel <= 4, 'the 1-Intel bug cost was paid');
  });
});

test('BT-06b bots fire missiles at rival holdings (geo DLC)', async t => {
  await withSeedAsync(555, async () => {
    const engine = await rigGame(t, true);
    const S = engine.acc.S;
    for (let j = 0; j < 3; j++) { S.players[j].money = 40; S.players[j].intel = 1; }
    /* one rival holding only — the best-paying standing node on the board */
    const view = engine.ctx.botView(1);
    const target = Object.keys(view.nmap).filter(id => view.nmap[id].income > 0
      && id.indexOf('geo_') !== 0 && id !== 'qantas')
      .sort((a, b) => view.nmap[b].income - view.nmap[a].income)[0];
    assert.ok(target, 'some standing base node pays income');
    for (const id in S.owner) S.owner[id] = null;
    S.owner[target] = 0;
    S.owner.geo_missile = 1;
    S.players[1].pos = 'geo_missile';
    await driveBotTurn(engine, 1, 'missile');
    const rec = engine.ctx.__rec;
    assert.ok(rec.intents.some(it => it.pi === 1 && it.act === 'missilemode'), 'the bot opened missile mode');
    assert.ok(rec.intents.some(it => it.pi === 1 && it.act === 'missile' && it.id === target), 'the bot struck the rival holding');
    assert.equal(S.rubble[target], 1, 'the strike reduced the rival holding to rubble');
    assert.equal(S.owner[target], undefined, 'the strike expropriated the rival with no payout');
    assert.equal(rec.pre.money, 40, 'the bot held $40 before the launch');
    assert.ok(S.players[1].money <= 36, 'the $4 launch was paid');
    assert.equal(S.players[1].intel, 0, 'the 1-Intel launch price was paid');
  });
});

test('BT-06c the Venice owner sends Overtourism at a rival node (geo DLC)', async t => {
  await withSeedAsync(555, async () => {
    const engine = await rigGame(t, true);
    const S = engine.acc.S;
    S.players[1].money = 40;
    S.players[1].intel = 1; /* starve spy/leak/sell so Overtourism is the play */
    S.players[1].pos = 'quik';
    for (const id in S.owner) if (S.owner[id] === 2) S.owner[id] = null; /* seat 2 left vulnerable-less */
    for (const id in S.owner) if (id.indexOf('geo_') === 0 && id !== 'geo_venice' && S.owner[id] === 1) S.owner[id] = null; /* no launcher/boeing/stage5 */
    S.owner.quik = 1;
    S.owner.geo_venice = 1;
    S.owner.us = 0;
    S.owner.japan = 0; /* the victim needs 2 holdings for the ≤1-node quirk */
    S.rubble.japan = 1; /* the US chart is the only standing rival node */
    S.players[0].money = 88; /* close enough to race that the victim qualifies */
    S.players[0].cortisol = 4;
    for (const nb of engine.acc.ADJ['quik'] || []) { /* pre-bug every adjacent holding: no cheaper play */
      const o = S.owner[nb];
      if (o != null && o !== 1 && S.bugs[nb] == null) S.bugs[nb] = o;
    }
    await driveBotTurn(engine, 1, 'overtour');
    const rec = engine.ctx.__rec;
    assert.ok(rec.intents.some(it => it.pi === 1 && it.act === 'overmode'), 'the bot opened overtourism mode');
    assert.ok(rec.intents.some(it => it.pi === 1 && it.act === 'overtour' && it.id === 'us'), 'the bot sent the ships to the US chart');
    assert.ok(S.ov, 'overtourism is riding a rival node');
    assert.equal(S.ov.by, 1, 'the bot is the cruise-line operator');
    assert.equal(S.ov.nid, 'us', 'the ships anchor at the victim holding');
    assert.equal(S.ov.targetOwner, 0, 'the victim is the staged rival');
  });
});

test('BT-06d bots rebuild rubble under their feet when rich (geo DLC)', async t => {
  await withSeedAsync(555, async () => {
    const engine = await rigGame(t, true);
    const S = engine.acc.S;
    S.players[1].money = 500;
    S.players[1].intel = 0; /* no bugs, no spy, no leaks */
    S.players[1].pos = 'us';
    for (const id in S.owner) if (S.owner[id] === 1) S.owner[id] = null; /* the bot owns nothing else to do */
    S.owner.us = null;
    S.rubble.us = 1;
    await driveBotTurn(engine, 1, 'rebuild');
    const rec = engine.ctx.__rec;
    assert.ok(rec.intents.some(it => it.pi === 1 && it.act === 'rebuild'), 'the bot rebuilt the rubble it stood on');
    assert.ok(!S.rubble.us, 'the node came back from rubble');
    assert.equal(rec.pre.money, 500, 'the bot held its cash before the rebuild');
  });
});

test('BT-06e the 30-Intel Cortisol Overload targets the strongest rival', async t => {
  await withSeedAsync(555, async () => {
    const engine = await rigGame(t, false);
    const S = engine.acc.S;
    S.players[1].money = 40;
    S.players[1].intel = 30;
    S.players[0].cortisol = 4; /* +6 from the overload lands any chosen rival on 9 */
    S.players[2].cortisol = 4;
    await driveBotTurn(engine, 1, 'targetpanic');
    const rec = engine.ctx.__rec;
    assert.ok(rec.intents.some(it => it.pi === 1 && it.act === 'targetpanic'), 'the bot unleashed the overload');
    assert.ok(S.log.some(l => l.includes('overload')), 'the engine logged the overload');
    assert.equal(rec.pre.intel, 30, 'the bot held 30 Intel before the overload');
    assert.equal(S.players[1].intel, 0, 'the 30-Intel price was paid');
    const hit = [0, 2].some(j => S.players[j].cortisol >= 9 || S.players[j].raided === 1);
    assert.ok(hit, 'the victim hit the raid threshold');
  });
});

test('BT-07 bots banter on the table chat — one line at a time, in voice', async t => {
  const engine = botEngine(t);
  const S = await makeGame(engine, 3, { bots: [0, 1, 2], goal: 100, seeds: [41] });
  await driveToOver(engine, S);
  const botNames = new Set(S.players.filter(p => p.bot).map(p => p.name));
  const botChats = S.chat.filter(c => botNames.has(c.n));
  assert.ok(botChats.length >= 1, 'the bots said something over a full game');
  assert.equal(botChats.length, S.chat.length, 'only bots spoke (an all-bot table)');
  for (const c of botChats) assert.ok(c.t.length > 0 && c.t.length <= 140, 'chat lines are short and real');
  assert.ok(botChats.length <= S.turn * 1 + 8, 'the banter stays sparse across ' + S.turn + ' turns');
  engine.dispose();
});

test('BT-08 the host can spectate: a lobby of only bots starts and plays', async t => {
  const engine = loadEngine();
  t.after(() => engine.dispose());
  engine.ctx.window.__BIGCON_TEST__ = true; /* zero bot pacing on the virtual clock */
  engine.ctx.window.__BIGCON_BOT_SEED__ = 4242;
  vm.runInContext(BOT_SRC, engine.ctx, { filename: 'static/bots.js' });
  const Net = engine.acc.Net;
  Net.role = 'host'; Net.myIdx = 0; Net.playerId = 'host'; Net.goal = 100;
  Net.roster = [{ name: 'HOST', playerId: 'host', conn: null, char: null }];
  Net.conns = [null];
  const ctx = engine.ctx;

  /* hand the host seat to a bot */
  ctx.toggleSpectate();
  assert.equal(Net.roster.length, 1, 'the toggle converts the host row in place');
  assert.equal(Net.roster[0].bot, true, 'the host seat became a bot');
  assert.ok(Net.roster[0].char, 'the spectator bot picked a face');
  assert.ok(Net.roster[0].name.indexOf('BOT') === 0, 'the seat is named like a bot');
  assert.ok(Net.roster[0].spectated && Net.roster[0].spectated.name === 'HOST', 'the host identity is kept aside');

  /* the host row is not kickable — take the seat back instead */
  ctx.kickBotSeat(0);
  assert.equal(Net.roster.length, 1, 'kicking the spectator row is a no-op');
  assert.ok(Net.roster[0].bot, 'the spectator bot stayed seated');

  /* the seat comes back with name, player id and face intact */
  ctx.toggleSpectate();
  assert.equal(Net.roster[0].bot, false, 'the host took the seat back');
  assert.equal(Net.roster[0].name, 'HOST', 'the host name came back');
  assert.equal(Net.roster[0].playerId, 'host', 'the host player id came back');
  assert.equal(ctx.applyChar(0, CHARS8[0]), true, 'the host picked a face');
  ctx.toggleSpectate();
  assert.equal(Net.roster[0].bot, true, 'the host seat is a bot again');
  assert.equal(Net.roster[0].char, CHARS8[0], 'the spectator bot keeps the host face it was given');
  ctx.toggleSpectate();
  assert.equal(Net.roster[0].bot, false, 'the host took the seat back again');
  assert.equal(Net.roster[0].char, CHARS8[0], 'the host face came back');

  /* the real start path: the all-bot lobby goes straight through btnStart */
  ctx.toggleSpectate();
  ctx.addBotSeat(); ctx.addBotSeat();
  assert.equal(Net.roster.length, 3, 'two table bots joined the spectator bot');
  assert.equal(new Set(Net.roster.map(e => e.char)).size, 3, 'every face at the all-bot table is unique');
  engine.f.broadcastLobby();
  assert.equal(engine.elems.get('btnStart').disabled, false, 'an all-bot lobby unlocks START');
  assert.ok(String(engine.elems.get('btnStart').textContent).indexOf('ALL-BOT TABLE') >= 0, 'the start button announces the all-bot table');

  ctx.__toasts = [];
  vm.runInContext('(() => { const t = toast; toast = m => { __toasts.push(String(m)); return t(m); }; })()', engine.ctx, { filename: 'bots-test-toast' });
  const seats = Net.roster.map(e => ({ name: e.name, char: e.char, bot: !!e.bot }));
  await withSeedAsync(99, () => engine.f.initGame(seats));
  const S = engine.acc.S;
  assert.equal(Net.started, true, 'the con started');
  assert.ok(S.players.every(p => p.bot), 'every seated player is a bot — the host just watches');

  await driveToOver(engine, S);
  assert.equal(S.over, true, 'the all-bot game reached a winner');
  assert.equal(engine.ctx.__toasts.filter(x => /YOUR TURN/i.test(x)).length, 0, 'no YOUR TURN toast ever reached the spectator host');
  const errs = engine.consoleOut.error.filter(l => String(l).includes('bot turn error'));
  assert.equal(errs.length, 0, 'no bot turn crashed, including the host seat: ' + String(errs[0] || '').slice(0, 200));
});
