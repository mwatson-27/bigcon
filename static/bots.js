/*
 * THE BIG CON — bot seat policy (planner + lookahead + exact event EV).
 *
 * Loaded as a classic script AFTER the inline game script, so every top-level
 * binding of the engine exists by the time these functions run. The module
 * NEVER touches engine state directly: the engine hands it a redacted per-seat
 * VIEW (a JSON snapshot carrying nothing the wire wouldn't carry — the event
 * deck order is excluded) plus a curated API of engine helpers and the one
 * mutating entrypoint, applyIntent, which is the same gate human guests
 * propose actions through.
 *
 * Determinism: all policy randomness flows through per-seat xorshift streams
 * seeded at game start (the engine calls BigConBots.resetForGame from
 * initGame), so a seeded game replays identically. Math.random is never read
 * here at decision time.
 *
 * Fairness: the policy reasons over table-visible state only (ownership,
 * positions, cash, intel, cortisol, moods, bugs, discards). Hidden information
 * (the deck) is only accessed through the same channels a human seat uses —
 * the JTPortal briefing and bought peeks — and every private prompt the engine
 * delivers to a bot seat is answered through BigConBots.answerPrompt.
 *
 * Fallback: if this file fails to load, bot seats play it quiet — the same
 * away-seat path the engine already runs (see the startTurn branch).
 */
(function () {
  'use strict';

  const B = {
    enabled: true,
    paceMs: 0,        /* human-ish pacing between intents; 0 under test */
    mode: 'smart',    /* 'smart' | 'random' — random is the uplift control */
    stats: { turns: 0, intents: 0, answers: 0, replans: 0 },
    known: {},        /* seat -> {card, at} — deck knowledge bought fairly */
    streams: {},      /* seat -> xorshift32 state, re-seeded per game */
    lastChat: {},     /* seat -> last turn this bot said something */
    memory: {},       /* seat -> {grudge:{seat:n}, guard:seat} across turns */
    lastView: {},     /* seat -> {mine:[nid]} — the attribution snapshot */
    seed: 1,
    turnStamp: 1,
  };
  try { window.BigConBots = B; } catch (e) { /* non-window realm */ }
  const isTest = (typeof window !== 'undefined' && window.__BIGCON_TEST__ === true);
  /* 650 made a ~1k-intent game take 18+ minutes; 150 keeps it human (~4 min)
     without feeling robotic. Background tabs clamp timers to ~1s — pace()
     detects the clamp and drops to one beat per turn so the con still ends. */
  if (!isTest) B.paceMs = 150;
  B.throttle = false;  /* a measured timer clamp this session */
  B.pacedTurn = {};    /* per-seat "already beat once this turn" flags */

  /* ---------- deterministic randomness ---------- */
  function r32(pi) {
    let st = B.streams[pi];
    if (st === undefined) { st = (B.seed + ((pi + 2) * 0x9E3779B9)) >>> 0 || 1; }
    st ^= st << 13; st >>>= 0;
    st ^= st >>> 17;
    st ^= st << 5; st >>>= 0;
    B.streams[pi] = st;
    return st / 4294967296;
  }
  function botSeed(pi) { B.streams[pi] = ((B.seed + pi * 7919 + B.turnStamp * 104729) >>> 0) || 1; }
  function sleep(ms) {
    if (!ms) return Promise.resolve();
    return new Promise(res => {
      const t0 = Date.now();
      try {
        setTimeout(() => {
          /* a background tab answers a 150ms timer a second or a minute late;
             remember the clamp so pace() stops paying it once per intent */
          if (Date.now() - t0 > ms + 700) B.throttle = true;
          res();
        }, ms);
      } catch (e) { res(); }
    });
  }
  function pace(pi) {
    if (!B.paceMs) return Promise.resolve();
    if (B.throttle) {
      /* throttled table: one beat per turn, not one per intent */
      if (B.pacedTurn[pi]) return Promise.resolve();
      B.pacedTurn[pi] = true;
    }
    return sleep(B.paceMs + r32(pi) * B.paceMs);
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ================= EXACT EVENT-CARD EV =================
     Hand-derived from CARDS[].run() sources; returns MY delta for a seat.
     Each entry: (view, seat) -> {money, fire, intel, mood, tool?} */
  const OWN = (v, id) => v.owner[id];
  function ownersOf(v, pred) {
    const out = [];
    for (const id in v.owner) {
      const o = v.owner[id];
      if (typeof o !== 'number') continue;
      const n = v.nmap[id];
      if (n && pred(n)) out.push({ id, owner: o });
    }
    return out;
  }
  const mineWhere = (v, seat, pred) => ownersOf(v, pred).filter(x => x.owner === seat).map(x => x.id);
  const chartsOwned = (v, s) => mineWhere(v, s, n => n.type === 'CHART').length;
  const banksOwned = (v, s) => mineWhere(v, s, n => n.type === 'BANK').length;
  const nodeCount = (v, s) => mineWhere(v, s, () => true).length;
  function isMaxFire(v, seat) {
    let mx = 0; for (const p of v.players) if (p.cortisol > mx) mx = p.cortisol;
    return mx > 0 && v.players[seat].cortisol === mx;
  }
  function isMaxNodes(v, seat) {
    let mx = 0; for (let i = 0; i < v.players.length; i++) mx = Math.max(mx, nodeCount(v, i));
    return mx > 0 && nodeCount(v, seat) === mx;
  }

  const CARD_EV = {
    oilspike: (v, s) => {
      const has = n => OWN(v, n) === s;
      let d = 0;
      if (has('oil')) d += 6;
      if (has('oilgraph')) d += 2;
      if (has('tanker')) d += 3;
      if (has('petronas')) d += 3;
      if (has('barrels')) d += 2;
      const q = OWN(v, 'quik');
      if (q == null) d -= 1;                       /* nobody minds the till */
      else if (q !== s) d -= 1;                    /* fuel costs → QuikStop */
      else d += v.players.length - 1;              /* I own the pump */
      return { money: d, fire: 0, intel: 0, mood: 'BOOM' };
    },
    coalrush: (v, s) => {
      const has = n => OWN(v, n) === s;
      let d = 0;
      if (has('port')) d += 4;
      if (has('train')) d += 2;
      if (has('tanker')) d += 3;
      if (has('coal')) d += 2;
      if (has('forklift')) d += 1;
      if (has('bhp')) d += 3;
      return { money: d, fire: 0, intel: 0, mood: 'BOOM' };
    },
    rates: (v, s) => {
      let d = 0;
      if (OWN(v, 'rba') !== s && OWN(v, 'bullock') !== s) d -= 2;
      if (OWN(v, 'cash') === s) d += 2;
      if (OWN(v, 'jim') === s) d += 2;
      if (OWN(v, 'bess') === s) d += 2;
      if (OWN(v, 'herald') === s) d += 2;
      return { money: d, fire: 0, intel: 0, mood: 'CALM' };
    },
    bondrevolt: (v, s) => {
      const b = banksOwned(v, s);
      const bd = OWN(v, 'bond');
      let d = -2 * b;
      if (bd === s) { for (let i = 0; i < v.players.length; i++) if (i !== s) d += 2 * banksOwned(v, i); }
      for (const c of v.country) if (OWN(v, c) === s) d += (c === 'japan' ? 3 : 1);
      if (OWN(v, 'tenyear') === s) d += 2;
      if (OWN(v, 'bess') === s) d += 2;
      if (OWN(v, 'brad') === s) d += 2;
      if (OWN(v, 'bigshort') === s) d += 3;
      if (OWN(v, 'leak') === s) d += 2;
      return { money: d, fire: 0, intel: 0, mood: 'PANIC' };
    },
    ceophoto: (v, s) => {
      if (OWN(v, 'coal') !== s) return { money: 0, fire: 0, intel: 0, mood: 'FRENZY' };
      if (OWN(v, 'watson') === s) return { money: 0, fire: 0, intel: 0, mood: 'FRENZY' };
      if (OWN(v, 'port') === s) return { money: 5, fire: 0, intel: 0, mood: 'FRENZY' };
      if (OWN(v, 'press') === s || OWN(v, 'fox') === s) return { money: 3, fire: 0, intel: 0, mood: 'FRENZY' };
      return { money: 0, fire: 3, intel: 0, mood: 'FRENZY' };
    },
    tariffs: (v, s) => {
      const oilChain = ['oil', 'oilgraph', 'barrels', 'tanker', 'petronas'];
      const coalChain = ['coal', 'train', 'port', 'watson', 'forklift', 'bhp'];
      const chainVal = list => list.reduce((a, n) => a + (OWN(v, n) === s ? 3 : 0), 0) + (OWN(v, 'us') === s ? 2 : 0);
      const oilWin = chainVal(oilChain), coalWin = chainVal(coalChain);
      const best = Math.max(oilWin, coalWin);
      const t = OWN(v, 'trump');
      /* my pick when I hold trump; a rival's pick is a coin flip to me */
      const ex = t === s ? best : (oilWin + coalWin) / 2;
      const winner = t === s ? ex > 0 : ex >= 2; /* winners skip the $1 tariff bill */
      return { money: ex - (winner ? 0 : 1), fire: 0, intel: 0, mood: 'PANIC' };
    },
    besspeak: (v, s) => {
      let d = 0;
      if (OWN(v, 'bessent') === s) d += 3;
      if (OWN(v, 'bond') === s) d += 2;
      if (OWN(v, 'tenyear') === s) d += 2;
      if (OWN(v, 'brad') === s) d += 2;
      return { money: d, fire: 0, intel: 0, mood: 'CALM' };
    },
    budget: (v, s) => {
      let d = 0, holder = false;
      if (OWN(v, 'chalmers') === s) { d += 2; holder = true; }
      if (OWN(v, 'jim') === s) { d += 2; holder = true; }
      if (OWN(v, 'herald') === s) { d += 2; holder = true; }
      if (OWN(v, 'albo') === s) { d += 1; holder = true; }
      return { money: holder ? d : -1, fire: 0, intel: 0, mood: 'CALM' };
    },
    mpcfinals: (v, s) => {
      const has = n => OWN(v, n) === s;
      let money = 0, intel = 0;
      if (has('mpc')) { money += 4; intel += 1; }
      if (has('school')) money += 2;
      if (has('ib')) money += 2;
      if (has('jt')) intel += 1;
      return { money, fire: 0, intel, mood: 'BOOM' };
    },
    sisyroll: (v, s) => {
      if (OWN(v, 'sisy') === s) return { money: 0, fire: 0, intel: 0, mood: 'CALM' };
      return isMaxNodes(v, s) ? { money: -2, fire: 0, intel: 0, mood: 'CALM' } : { money: 0, fire: 0, intel: 0, mood: 'CALM' };
    },
    goldrush: (v, s) => {
      let money = 0;
      if (OWN(v, 'gold') === s) money += 5;
      if (OWN(v, 'bhp') === s) money += 3;
      if (money === 0) money -= 1;
      return { money, fire: 0, intel: 0, mood: 'BOOM' };
    },
    rockcooks: (v, s) => (OWN(v, 'rock') === s
      ? { money: 3, fire: -1, intel: 0, mood: 'CALM' }
      : { money: 0, fire: 0, intel: 0, mood: 'CALM' }),
    davos: (v, s) => {
      let money = 0;
      if (OWN(v, 'wef') === s) money += 3;
      if (OWN(v, 'bessent') === s) money += 2;
      for (const nid in v.bugs) if (v.bugs[nid] === s) money += 1;
      return { money, fire: 0, intel: 0, mood: 'FRENZY' };
    },
    quikrob: (v, s) => {
      let money = 0;
      const q = OWN(v, 'quik');
      if (q == null) money -= 1;
      else if (q === s) money -= 2;
      if (OWN(v, 'bond007') === s) money += 2;
      return { money, fire: 0, intel: 0, mood: 'CALM' };
    },
    ibexams: (v, s) => {
      let intel = 0;
      if (OWN(v, 'ib') === s) intel += 2;
      if (OWN(v, 'school') === s) intel += 1;
      const held = intel > 0;
      if (!held && chartsOwned(v, s) === 0 && v.players[s].intel > 0) intel -= 1;
      return { money: 0, fire: 0, intel, mood: 'CALM' };
    },
    profit: (v, s) => ({ money: OWN(v, 'quik') === s ? 4 : 0, fire: 0, intel: 0, mood: 'CALM' }),
    quiet: () => ({ money: 2, fire: 0, intel: 0, mood: 'CALM' }),
    snoop: (v, s) => (isMaxFire(v, s) ? { money: 0, fire: 1, intel: 0, mood: 'CALM' } : { money: 0, fire: 0, intel: 0, mood: 'CALM' }),
    tip: () => ({ money: 0, fire: 0, intel: 1, mood: 'CALM' }),
    frenzy: (v, s) => {
      const p = OWN(v, 'press');
      if (p === s) return { money: 0, fire: 0, intel: 0, mood: 'FRENZY', tool: 'frenzy' };
      if (p != null && v.players.length > 1) return { money: 0, fire: 2 / (v.players.length - 1), intel: 0, mood: 'FRENZY' };
      return { money: 0, fire: 0, intel: 0, mood: 'FRENZY' };
    },
    crackdown: (v, s) => {
      const bs = OWN(v, 'bigshort') === s ? 3 : 0;
      if (isMaxFire(v, s)) return { money: -4 + bs, fire: 0, intel: 0, mood: 'PANIC' };
      return { money: bs, fire: 0, intel: 0, mood: 'PANIC' };
    },
    tapes: (v, s) => {
      let intel = 0;
      if (OWN(v, 'whistle') === s || OWN(v, 'jt') === s) intel += 2;
      else if (v.players[s].intel > 0) intel -= 1;
      return { money: 0, fire: 0, intel, mood: 'CALM' };
    },
    bigscreen: (v, s) => {
      let money = 0;
      if (OWN(v, 'bigshort') === s) money += 3;
      if (OWN(v, 'brad') === s) money += 2;
      if (OWN(v, 'hedge') === s) money += 2;
      return { money, fire: 0, intel: 0, mood: 'FRENZY' };
    },
    madeout: () => ({ money: 0, fire: 0, intel: 0, mood: null, made: true }),
  };

  function cardEV(cardId, view, seat) {
    const f = CARD_EV[cardId];
    if (!f) return { money: 0, fire: 0, intel: 0, mood: null };
    try { return f(view, seat); } catch (e) { return { money: 0, fire: 0, intel: 0, mood: null }; }
  }

  /* Expected next draw: uniform over the unseen multiset — what the wire
     legitimately exposes (deckCount plus the public discard pile). */
  function deckEV(view, seat) {
    const counts = {};
    for (const id of view.cardIds) counts[id] = (counts[id] || 0) + 1;
    const discard = view.discardIds || [];
    const unseen = view.cardIds.filter(id => (counts[id] || 0) - discard.filter(d => d === id).length > 0);
    let money = 0, fire = 0, intel = 0;
    for (const id of unseen) {
      const ev = cardEV(id, view, seat);
      money += ev.money; fire += ev.fire; intel += ev.intel;
    }
    const n = Math.max(1, unseen.length);
    return { money: money / n, fire: fire / n, intel: intel / n, n: unseen.length };
  }

  /* ================= WEIGHTS & EVALUATION ================= */
  const W = {
    money: 1,
    intel: 1.1,
    incomeTurns: 26,       /* $1/turn of income is worth ~26 to the win race */
    fire: 0.55,            /* hazard per cortisol² — ramps hard near 9 */
    setBonus: 24,          /* first node of a missing win type */
    regScarcity: 12,       /* extra premium: only four REGULATORS exist */
    stepNode: 8,           /* movement-power nodes */
    intelNode: 30,        /* +1🛈 at start of turn */
    raidWall: 150,         /* never step into raid range on purpose */
  };
  function hazardFire(cur) { const c = clamp(cur, 0, 9); return W.fire * c * c; }

  /* ================= PER-CHARACTER STRATEGIES =================
     Every face plays its own con: `nodes`/`types` are the industries the
     character pursues (bought at a premium via nodeOwnValue), `aggr` scales
     hostile actions, `risk` divides the seat's own cortisol fear (above 1 is
     braver), `cash` scales pure cash plays (sisyphus pushes, intel sales).
     Unknown faces fall back to the all-rounder below. */
  const STRATEGIES = {
    markwatson:       { label: 'coal baron',     nodes: ['coal', 'watson', 'train', 'port', 'bhp', 'tanker', 'forklift'], types: ['COMMODITY', 'CORPORATE'], nodeBoost: 1.5, typeBoost: 1.25, aggr: 1.15, risk: 1.25, cash: 1.2, accc: 0.5 },
    tomkins:          { label: 'servo empire',   nodes: ['quik', 'market', 'sisy', 'f1'],                               types: ['CORPORATE'],  nodeBoost: 1.3,  typeBoost: 1.1,  aggr: 0.9,  risk: 1.0,  cash: 1.6 },
    jimchalmers:      { label: 'the treasurer',  nodes: ['chalmers', 'jim', 'gov', 'herald', 'rba'],                     types: ['REGULATOR', 'MEDIA'], nodeBoost: 1.3, typeBoost: 1.15, aggr: 0.95, risk: 0.9, cash: 1 },
    bessock:          { label: 'the RBA',        nodes: ['rba', 'bullock', 'bond', 'cash', 'tenyear'],                   types: ['REGULATOR', 'CHART'], nodeBoost: 1.45, typeBoost: 1.2, aggr: 0.8, risk: 0.85, cash: 1 },
    calvinathanasius: { label: 'old money',      nodes: ['citi', 'golf', 'bond007', 'hedge'],                            types: ['BANK'],       nodeBoost: 1.35, typeBoost: 1.15, aggr: 0.95, risk: 1.0,  cash: 1 },
    denialswan:       { label: 'chart watcher',  nodes: ['tenyear', 'us', 'japan', 'uk', 'aus', 'stock', 'ib', 'term'],  types: ['CHART'],      nodeBoost: 1.45, typeBoost: 1.2,  aggr: 0.8,  risk: 0.85, cash: 1 },
    japsnchen:        { label: 'the leak',       nodes: ['leak', 'insider', 'news', 'wef', 'photo'],                     types: ['MEDIA'],      nodeBoost: 1.3,  typeBoost: 1.15, aggr: 1.15, risk: 1.0,  cash: 1 },
    thousandyardwax:  { label: 'the sniper',     nodes: ['trump', 'term', 'whistle'],                                    types: [],             nodeBoost: 1.2,  typeBoost: 1.0,  aggr: 1.5,  risk: 1.35, cash: 1, accc: 0.8 },
    Alexander_Lane:   { label: 'toktimer',       nodes: ['toktimer', 'iface', 'term', 'school', 'mpc'],                  types: ['WILD'],       nodeBoost: 1.3,  typeBoost: 1.15, aggr: 0.9,  risk: 0.95, cash: 1 },
    DJT:              { label: 'tariff man',     nodes: ['trump', 'fox', 'press', 'oil'],                                types: ['MEDIA'],      nodeBoost: 1.3,  typeBoost: 1.15, aggr: 1.6,  risk: 1.4,  cash: 1 },
    thebigag:         { label: 'big agriculture', nodes: ['bhp', 'barrels', 'forklift', 'oil', 'gold'],                  types: ['COMMODITY'],  nodeBoost: 1.35, typeBoost: 1.2,  aggr: 1.2,  risk: 1.1,  cash: 1, accc: 0.75 },
    thebigwegrzyn:    { label: 'the banker',     nodes: ['bessent', 'brad', 'bigshort', 'nab', 'commbank'],              types: ['BANK'],       nodeBoost: 1.35, typeBoost: 1.15, aggr: 1.0,  risk: 1.0,  cash: 1 },
  };
  const FALLBACK_STRAT = { label: 'wilder', nodes: [], types: [], nodeBoost: 1, typeBoost: 1, aggr: 1, risk: 1, cash: 1, accc: 1 };
  function strategyOf(v, seat) {
    const p = v.players && v.players[seat];
    return (p && STRATEGIES[p.char]) || FALLBACK_STRAT;
  }

  /* Simulation variants — scale every profile uniformly so a race can tell a
     plan-first table from an aggression-first one. The 40-game race in
     tests/sim-races.mjs picked 'affinity' (fast games, most balanced field:
     every archetype viable) and it is baked in as the shipped baseline;
     'stock' preserves the pre-tuning temperament for repro. */
  const VARIANTS = {
    baseline: { nodeBoost: 1.6, typeBoost: 1.45, aggr: 1, risk: 1, cash: 1 },
    stock: { nodeBoost: 1, typeBoost: 1, aggr: 1, risk: 1, cash: 1 },
    aggro: { nodeBoost: 1, typeBoost: 1, aggr: 1.7, risk: 1.25, cash: 1 },
    turtle: { nodeBoost: 1, typeBoost: 1.2, aggr: 0.45, risk: 0.7, cash: 0.8 },
    sprint: { nodeBoost: 1, typeBoost: 1, aggr: 1, risk: 1, cash: 2.2 },
  };
  let variant = VARIANTS.baseline;
  B.variant = variant;
  B.setVariant = name => { variant = VARIANTS[name] || VARIANTS.baseline; B.variant = variant; return variant; };
  function strOf(v, seat) {
    const s = strategyOf(v, seat);
    return {
      nodes: s.nodes, types: s.types,
      nodeBoost: s.nodeBoost * variant.nodeBoost,
      typeBoost: s.typeBoost * variant.typeBoost,
      aggr: s.aggr * variant.aggr,
      risk: s.risk * variant.risk,
      cash: s.cash * variant.cash,
      accc: s.accc == null ? 1 : s.accc,
    };
  }
  /* a seat's own fear of the raid threshold, through its risk tolerance */
  function fireOf(v, seat, cur) { return hazardFire(cur) / (strOf(v, seat).risk || 1); }

  function myNodes(v, seat) {
    const out = [];
    for (const id in v.owner) if (v.owner[id] === seat) out.push(id);
    return out;
  }
  function vulnerable(v, seat) { return myNodes(v, seat).length >= 2; } /* addCortisol's ≤1-node quirk */

  /* Income projection — a faithful mirror of the engine's income() for the
     deterministic parts (salary + holdings + synergies + mood), with the MADE
     1-in-3 gate modeled as expectation. Bug skim is private-timed and ignored. */
  function projectIncome(v, seat) {
    const p = v.players[seat];
    const own = id => v.owner[id] === seat;
    const me = myNodes(v, seat);
    const cnt = t => me.filter(id => v.nmap[id] && v.nmap[id].type === t).length;
    let salary = own('infl') ? 4 : 3;
    let holds = 0;
    for (const id of me) {
      const n = v.nmap[id];
      if (!n) continue;
      let inc = n.income;
      if (n.type === 'CHART' && own('ib')) inc *= 2;
      if (id === 'qantas' && v.geo && v.geo.qantasGrounded) inc = 0;
      holds += inc;
    }
    const corp = cnt('CORPORATE'), bank = cnt('BANK'), chart = cnt('CHART'),
      comm = cnt('COMMODITY'), reg = cnt('REGULATOR'), med = cnt('MEDIA');
    let syn = 0;
    if (own('citi') && corp) syn += corp;
    if (own('commbank') && bank > 1) syn += 2;
    if (own('westpac') && reg) syn += reg;
    if (own('anz') && chart) syn += chart;
    if (own('bhp') && own('train')) syn += 1;
    if (own('tenyear') && chart > 1) syn += 3 * (chart - 1);
    for (const c of v.country) if (own(c) && own('tenyear')) syn += 1;
    if (own('mpc') && own('school') && own('ib')) syn += 2;
    if (own('stock') && (own('term') || own('fox'))) syn += 1;
    if (own('notes') && bank) syn += bank; /* dead node — kept for parity */
    if (own('barrels') && own('forklift')) syn += 1;
    if (own('forklift') && comm) syn += comm;
    if (own('market') && own('quik')) syn += 2;
    if (own('rock')) syn += new Set(me.map(id => v.nmap[id].type)).size;
    if (own('bessent') && bank) syn += bank;
    if (own('chalmers') && reg) syn += reg;
    if (own('watson') && own('coal')) syn += 2;
    if (own('mpc') && chart) syn += chart;
    if (v.geo && own('geo_pyoncity')) syn += me.filter(id => id.indexOf('geo_') === 0 && id !== 'geo_pyoncity').length;
    if (v.mood === 'BOOM' && comm > 0) syn += comm;
    if (v.mood === 'FRENZY' && med > 0) syn += med;
    if (v.mood === 'PANIC' && bank > 0) syn -= bank;
    const madeGain = own('made') ? (10 + 4) / 3 : 0;
    const madeCut = (me.length > 2 && p.money >= 50) ? Math.floor(p.money * 0.15) / 3 : 0;
    return salary + holds + syn + madeGain - madeCut;
  }

  function evalSeat(v, seat) {
    const p = v.players[seat];
    const inc = projectIncome(v, seat);
    const missing = v.missingTypes(seat);
    let setB = 0;
    for (const t of missing) setB += (t === 'REGULATOR' ? W.setBonus + W.regScarcity : W.setBonus) * 0.22;
    const deck = deckEV(v, seat);
    return {
      score: p.money * W.money + inc * W.incomeTurns - fireOf(v, seat, p.cortisol)
        + setB + p.intel * W.intel * 4 + deck.money * 3 - deck.fire * 6,
      income: inc, missing,
    };
  }
  function progressTowardWin(v, seat) { return v.players[seat].money - v.goal * 0.9; }
  function strongestSeat(v, exclude) {
    let top = -1, topSc = -Infinity;
    for (let i = 0; i < v.players.length; i++) {
      if (i === exclude || !vulnerable(v, i)) continue;
      const s = evalSeat(v, i).score;
      if (s > topSc) { topSc = s; top = i; }
    }
    return top;
  }

  /* ================= MOVEMENT PLANNING ================= */
  function buildAdj(v) {
    const A = {};
    for (const e of v.edges) {
      if (!e || e.length < 2) continue;
      const a = e[0], b = e[1];
      (A[a] || (A[a] = [])).push(b);
      (A[b] || (A[b] = [])).push(a);
    }
    return A;
  }
  function tollFor(v, seat, nid) {
    const o = v.owner[nid];
    if (o == null || o === seat) return 0;
    if (v.owner['bond007'] === seat) return 0; /* 007 is on the payroll */
    return v.owner['albo'] === o ? 2 : 1;
  }
  function passable(v, nid) {
    if (v.rubble && v.rubble[nid]) return false;               /* rebuild first */
    if (v.blockades && v.blockades[nid] > v.turn) return false; /* walled off */
    if (nid === 'qantas' && v.geo && v.geo.qantasGrounded) return false;
    return true;
  }
  /* Dijkstra over (toll cost, hop) within the movement budget. */
  function planGraph(v, seat, budget) {
    const A = buildAdj(v);
    const start = v.players[seat].pos;
    const best = { [start]: { cost: 0, hops: 0, path: [] } };
    let frontier = [{ id: start, cost: 0, hops: 0, path: [] }];
    while (frontier.length) {
      const next = [];
      for (const f of frontier) {
        for (const nb of (A[f.id] || [])) {
          if (!passable(v, nb)) continue;
          if (f.hops + 1 > budget) continue;
          const toll = tollFor(v, seat, nb);
          const cost = f.cost + toll;
          if (cost > v.players[seat].money) continue;
          const prev = best[nb];
          if (prev && (prev.cost < cost || (prev.cost === cost && prev.hops <= f.hops + 1))) continue;
          const rec = { cost, hops: f.hops + 1, path: f.path.concat(nb) };
          best[nb] = rec;
          next.push({ id: nb, cost, hops: rec.hops, path: rec.path });
        }
      }
      frontier = next;
    }
    return best;
  }

  /* ================= NODE & SEIZURE VALUE ================= */
  /* ACCC/ASIC concentration, mirrored from the engine's INDUSTRIES table.
     The engine investigates any industry where a seat holds MORE THAN TWO
     nodes (33% chance: forced divestment of the lot). The view carries the
     industry groups as id lists (botView.industryIds). */
  function industryCounts(v, seat, extraNid) {
    const counts = {};
    if (!v.industryIds) return counts;
    const owned = {};
    for (const id in v.owner) if (v.owner[id] === seat) owned[id] = true;
    if (extraNid && v.nmap[extraNid]) owned[extraNid] = true;
    for (const g of v.industryIds) {
      let n = 0;
      for (const id of g.ids) if (owned[id]) n++;
      if (n > 2) counts[g.id] = n;
    }
    return counts;
  }
  function penaltyOf(n) { return 9 * (n - 2) + (n > 3 ? 26 * (n - 3) : 0); }
  function acccExposure(v, seat, extraNid) {
    const counts = industryCounts(v, seat, extraNid);
    let pen = 0;
    const tol = strOf(v, seat).accc; /* personalities differ on risk tolerance */
    for (const id in counts) {
      if (id === 'coal' && v.owner['watson'] === seat) continue; /* the watson exemption */
      pen += penaltyOf(counts[id]) * tol;
    }
    return pen;
  }
  function nodeOwnValue(v, seat, nid) {
    const n = v.nmap[nid];
    if (!n) return 0;
    const mine = myNodes(v, seat);
    const cnt = ty => mine.concat([nid]).filter(id => v.nmap[id] && v.nmap[id].type === ty).length;
    let v2 = n.income * W.incomeTurns;
    const own = id => v.owner[id] === seat || id === nid;
    let syn = 0;
    if (nid === 'citi') syn += cnt('CORPORATE');
    if (nid === 'commbank' && cnt('BANK') > 1) syn += 2;
    if (nid === 'westpac') syn += cnt('REGULATOR');
    if (nid === 'anz') syn += cnt('CHART');
    if (nid === 'bhp' && own('train')) syn += 1;
    if (nid === 'tenyear' && cnt('CHART') > 1) syn += 3 * (cnt('CHART') - 1);
    if (nid === 'rock') syn += new Set(mine.map(id => v.nmap[id].type).concat([n.type])).size - 1;
    if (nid === 'bessent') syn += cnt('BANK');
    if (nid === 'chalmers') syn += cnt('REGULATOR');
    if (nid === 'watson' && own('coal')) syn += 2;
    if (nid === 'mpc') syn += cnt('CHART');
    if (nid === 'barrels' && own('forklift')) syn += 1;
    if (nid === 'forklift') syn += cnt('COMMODITY');
    if (nid === 'market' && own('quik')) syn += 2;
    v2 += syn * W.incomeTurns;
    if (['coal', 'train', 'bullet', 'asics'].indexOf(nid) >= 0) v2 += W.stepNode * W.incomeTurns * 0.25;
    if (['whistle', 'bullock', 'jt', 'mpc', 'geo_kim'].indexOf(nid) >= 0) v2 += W.intelNode;
    const t = n.type;
    /* the win set: a node of a still-missing type IS the race — the con only
       pays out with all types held. The closer to the full set, the hungrier:
       the last two missing types are worth more than any income math. */
    const missing = v.missingTypes(seat);
    if (missing.indexOf(t) >= 0) {
      v2 += (t === 'REGULATOR' ? W.setBonus + W.regScarcity : W.setBonus)
        + (missing.length <= 2 ? 42 : missing.length === 3 ? 18 : 0);
    }
    /* the character's own plan: loved nodes and loved industries pay a premium
       (also read for rival seats — it measures what the node means to THEM).
       The premium is for ENTERING an industry, not for stacking a fourth copy:
       a duplicate type adds income but no set progress, and letting the
       multiplier scale with income made the high-income archetypes (coal,
       big ag) over-buy their own book and lose the $100 race. */
    const str = strOf(v, seat);
    const dupType = cnt(t) > 1; /* already hold this type */
    const damp = b => (dupType ? 1 + (b - 1) * 0.35 : b);
    if (str.nodes.indexOf(nid) >= 0) v2 = v2 * damp(str.nodeBoost) + 8;
    else if (str.types.indexOf(t) >= 0) v2 = v2 * damp(str.typeBoost);
    if (dupType) v2 -= 8; /* income only — it does not move the win set */
    /* ACCC exposure: a third holding in one tracked INDUSTRIES group invites
       the 33% divestment — the more nodes past two, the worse the books look.
       The Mark Watson face exempts COAL entirely; holding watson shields it. */
    v2 -= acccExposure(v, seat, nid);
    if (nid === 'watson' && v.owner['watson'] !== seat) {
      const coal = industryCounts(v, seat, null).coal;
      if (coal > 2) v2 += penaltyOf(coal) * 0.8; /* the shield itself has value */
    }
    /* cooling nodes are fire extinguishers — worth more the hotter the seat
       runs (gold cools passively every income phase) */
    const relief = nid === 'gold' ? 2 : (nid === 'rock' || nid === 'asics') ? 3 : (nid === 'geo_wonsan' || nid === 'geo_venice') ? 2 : 0;
    if (relief) {
      const cur = v.players[seat].cortisol;
      if (cur >= 2) v2 += (fireOf(v, seat, cur) - fireOf(v, seat, Math.max(0, cur - relief))) * 4;
    }
    return v2;
  }
  function seizeCandidate(v, seat, nid) {
    const n = v.nmap[nid];
    if (!n || v.rubble[nid]) return null;
    const prev = v.owner[nid];
    if (prev === seat) return null;
    if (v.geo && ((nid === 'geo_shahed' && v.owner['geo_missile'] === seat) || (nid === 'geo_missile' && v.owner['geo_shahed'] === seat))) return null;
    const base = v.seizePrice(seat, nid);
    const isTake = prev != null;
    let cost = isTake ? v.takePrice(seat, nid, base) : base;
    if (v.slipped && v.owner['f1'] === seat) cost = Math.max(1, cost - 2);
    const p = v.players[seat];
    const backCover = v.owner['back'] === seat ? Math.min(3, p.intel) : 0;
    if (p.money + backCover < cost) return null;
    const cort = isTake ? 2 : 1;
    if (p.cortisol + cort >= 9) return null; /* never raid myself on purpose */
    const heat = fireOf(v, seat, p.cortisol + cort) - fireOf(v, seat, p.cortisol);
    let val = nodeOwnValue(v, seat, nid) - heat;
    /* the soft wall: at +1/+2 from a raid the caution turn is not worth it
       unless the node is a prize */
    if (p.cortisol + cort >= 8) val -= W.raidWall * 0.35;
    if (!isTake) {
      val -= base * W.money;
    } else {
      /* hostile: the inflation premium burns, the victim pockets list price */
      val -= (cost - base) * W.money;
      if (v.owner['accc'] === prev) val -= 2;
      val -= base * 0.4;                            /* their refund funds their race */
      val += nodeOwnValue(v, prev, nid) * 0.5;      /* denial: what it hurts them */
      /* set denial: taking a node a near-complete rival still NEEDS outranks
         the income math — one node now or they finish the set and bank */
      const theirMissing = v.missingTypes(prev);
      if (theirMissing.length && theirMissing.indexOf(n.type) >= 0) {
        val += theirMissing.length === 1 ? 70 : 34;
      }
      /* raid-window victims: pushing them to 9 hands their book to the table */
      if (p.cortisol + cort >= 9) val += 60;
    }
    /* intel cover spends armory intel — price it */
    if (p.money < cost) val -= (cost - p.money) * W.intel * 2 + 2;
    /* the dossier prelude: taking at list beats paying the doubling */
    if (isTake && !v.dossier && !v.flatSeize(nid) && p.intel >= 3) {
      const saved = cost - base;
      if (saved >= 3) val += saved * W.money - 3 * W.intel * 2 + 4;
    }
    return { kind: 'seize', nid, cost, base, isTake, val };
  }

  /* ================= TURN DRIVER ================= */
  function knowledge(v) {
    const k = B.known[v.pi];
    return (k && k.at === v.turn) ? k.card : null;
  }

  /* ================= CROSS-TURN MEMORY =================
     The wire does not attribute a leak or a raid, but it does show ownership.
     So a node that was mine last turn and is a rival's now WAS taken by that
     rival — the one attributable attack, and it is remembered. A rival one
     missing type from the win is put on guard duty until they are stopped. */
  function updateMemory(v, pi) {
    const mem = B.memory[pi] || (B.memory[pi] = { grudge: {}, guard: null });
    const prev = B.lastView[pi];
    if (prev) {
      const stolen = [];
      for (const nid of prev.mine) {
        const o = v.owner[nid];
        if (o != null && o !== pi) stolen.push(o);
      }
      /* ACCC divestment moves several nodes to different rivals at once —
         that is the regulator, not a heist. Only a single takeover stings. */
      if (stolen.length === 1) mem.grudge[stolen[0]] = (mem.grudge[stolen[0]] | 0) + 1;
      for (const k in mem.grudge) {
        mem.grudge[k] *= 0.85;
        if (mem.grudge[k] < 0.05) delete mem.grudge[k];
      }
    }
    mem.guard = null;
    for (let i = 0; i < v.players.length; i++) {
      if (i === pi) continue;
      const miss = v.missingTypes(i);
      if (miss.length === 1 && v.players[i].money >= v.goal * 0.5) { mem.guard = i; break; }
    }
    B.lastView[pi] = { mine: myNodes(v, pi) };
  }
  function grudgeOf(pi, victim) {
    const mem = B.memory[pi];
    return mem && mem.grudge ? (mem.grudge[victim] | 0) : 0;
  }

  async function takeTurn(pi, view, api) {
    B.stats.turns++;
    B.turnStamp = view.turn;
    botSeed(pi);
    updateMemory(view, pi);
    B.pacedTurn[pi] = false; /* the throttle beat refreshes each turn */
    try {
      maybeChat(pi, view, api);
      if (view.phase === 'move') {
        const best = B.mode === 'random' ? randomMovement(view, pi) : pickMovement(view, pi);
        if (best && best.flyTo) {
          await tryIntent(api, pi, { act: 'flymode' });
          await tryIntent(api, pi, { act: 'fly', id: best.flyTo });
        } else if (best && best.rec) {
          await walkPath(pi, best, api);
        } else {
          await tryIntent(api, pi, { act: 'endmove' });
        }
        /* movement leftovers can never linger */
        let v2 = api.viewOf(pi);
        if (v2 && !v2.over && v2.curSeat === pi && v2.phase === 'move') await tryIntent(api, pi, { act: 'endmove' });
      }
      /* ---- action phase ---- */
      let v = api.viewOf(pi);
      let guard = 0;
      while (v && !v.over && v.curSeat === pi && v.phase === 'action' && guard < 10) {
        const pick = B.mode === 'random' ? pickRandomAction(v, pi) : pickAction(v, pi);
        if (!pick) break;
        await dispatchAction(v, pi, pick, api);
        guard++;
        v = api.viewOf(pi);
        /* most actions ended the turn inside the engine (phase left 'action');
           free ops (spy/dossier) come back with the phase still ours — repick */
      }
      /* last-chance pass so a drifted decision can never hang the table */
      const fv = api.viewOf(pi);
      if (fv && !fv.over && fv.curSeat === pi && (fv.phase === 'move' || fv.phase === 'action')) {
        if (fv.phase === 'move') await tryIntent(api, pi, { act: 'endmove' });
        const av = api.viewOf(pi);
        if (av && av.phase === 'action') {
          await tryIntent(api, pi, { act: 'laylow', choice: av.players[pi].cortisol >= 4 ? 'cool' : 'cash' });
        }
      }
    } catch (err) {
      /* the engine's runBotTurn wrapper owns the quiet fallback */
      throw err;
    }
  }

  function computeBudgets(v, pi) {
    const me = v.players[pi];
    return {
      steps: v.steps,
      favor: !v.extraStep && me.intel >= 1,
      slip: v.owner['f1'] === pi && me.money >= 2 && !v.slipped,
      fly: v.owner['qantas'] === pi && me.money >= 3 && !(v.geo && v.geo.qantasGrounded),
    };
  }

  function pickMovement(v, pi) {
    const budgets = computeBudgets(v, pi);
    let best = { val: -Infinity, rec: null, flyTo: null, variant: null };
    const variants = [{ budget: budgets.steps, cost: 0, useFavor: false, useSlip: false }];
    if (budgets.favor && budgets.steps < 9) variants.push({ budget: budgets.steps + 1, cost: W.intel * 4, useFavor: true, useSlip: false });
    if (budgets.slip) variants.push({ budget: budgets.steps + 2, cost: 2 * W.money, useFavor: false, useSlip: true });
    if (budgets.favor && budgets.slip && budgets.steps < 8) variants.push({ budget: budgets.steps + 3, cost: W.intel * 4 + 2 * W.money, useFavor: true, useSlip: true });
    for (const variant of variants) {
      const reach = planGraph(v, pi, variant.budget);
      for (const nid in reach) {
        const cand = scoreStanding(v, pi, nid);
        if (!cand) continue;
        const rec = reach[nid];
        let val = cand.val - rec.cost * 1.4 - variant.cost;
        /* toll politics: a toll paid to a rival in the home stretch funds
           their race — the walk costs more than its number */
        for (const hop of (rec.path || [])) {
          const o = v.owner[hop];
          if (o != null && o !== pi && progressTowardWin(v, o) > -14) val -= 2.5;
        }
        if (rec.hops > 0) val += 0.3; /* a gentle bias to actually move */
        if (val > best.val) best = { val, rec, flyTo: null, variant };
      }
    }
    if (budgets.fly) {
      for (const n of v.nodes) {
        if (n.id === v.players[pi].pos) continue;
        if (!passable(v, n.id)) continue;
        const cand = scoreStanding(v, pi, n.id);
        if (!cand) continue;
        const val = cand.val - 3 * W.money - 1.5;
        if (val > best.val + 2) best = { val: val - 2, rec: null, flyTo: n.id, variant: null };
      }
    }
    return best.val === -Infinity ? null : best;
  }

  function randomMovement(v, pi) {
    const budgets = computeBudgets(v, pi);
    const reach = planGraph(v, pi, budgets.steps);
    const keys = Object.keys(reach);
    const pick = keys[Math.floor(r32(pi) * keys.length)];
    if (r32(pi) < 0.3 && budgets.fly) {
      const nodes = v.nodes.filter(n => passable(v, n.id) && n.id !== v.players[pi].pos);
      if (nodes.length) return { val: 0, rec: null, flyTo: nodes[Math.floor(r32(pi) * nodes.length)].id, variant: null };
    }
    return { val: 0, rec: reach[pick], flyTo: null, variant: { useFavor: false, useSlip: false } };
  }

  function scoreStanding(v, pi, nid) {
    const me = v.players[pi];
    const n = v.nmap[nid];
    if (!n) return null;
    let val = 0;
    const seize = seizeCandidate(v, pi, nid);
    if (seize) val += seize.val;
    if (v.owner[nid] === pi) {
      if (nid === 'sisy') val += (v.sisyPayout || 10) * W.money * strOf(v, pi).cash;
      /* standing on a cooling node while hot — the relief is free once there */
      if (nid === 'asics' && me.cortisol >= 2) val += (fireOf(v, pi, me.cortisol) - fireOf(v, pi, me.cortisol - 1)) * 1.5;
      if (v.geo && nid === 'geo_wonsan' && me.cortisol >= 3) val += (fireOf(v, pi, me.cortisol) - fireOf(v, pi, me.cortisol - 2)) * 1.5;
      if (v.geo && nid === 'geo_venice' && me.cortisol >= 3) val += (fireOf(v, pi, me.cortisol) - fireOf(v, pi, me.cortisol - 1)) * 1.5;
      if (nid === 'rock' && me.cortisol >= 4 && !v.cooked) val += fireOf(v, pi, me.cortisol) - fireOf(v, pi, me.cortisol - 3);
    }
    /* the cash rush walks to the boulder: $4 to own, then pushes double forever */
    if (nid === 'sisy' && v.owner[nid] == null && me.money >= v.goal * 0.72 && v.turn >= 30) val += 14;
    /* positioning support: stand where a bug or a missile becomes available */
    if (me.intel >= 1) {
      const A = buildAdj(v);
      for (const nb of (A[nid] || [])) {
        const o = v.owner[nb];
        if (o != null && o !== pi && v.bugs[nb] == null && !v.rubble[nb]) { val += 2.2; break; }
      }
    }
    if (canFireFromPos(v, pi, nid) && !canFireFromPos(v, pi, me.pos) && !v.geoMissiled
      && me.money >= 4 && me.intel >= 1) val += 3.5;
    return { val };
  }
  /* the engine's canFireMissileFrom, mirrored in view terms */
  function canFireFromPos(v, pi, pos) {
    if (!v.geo) return false;
    if (pos === 'geo_missile' && v.owner['geo_missile'] === pi) return true;
    if (pos === 'geo_shahed' && v.owner['geo_shahed'] === pi) return true;
    return v.owner['geo_kim'] === pi;
  }

  async function walkPath(pi, best, api) {
    if (best.variant && best.variant.useFavor) await tryIntent(api, pi, { act: 'favor' });
    if (best.variant && best.variant.useSlip) await tryIntent(api, pi, { act: 'slip' });
    let v = api.viewOf(pi);
    if (!v || v.over || v.curSeat !== pi || v.phase !== 'move') return;
    const plan = best.rec ? best.rec.path.slice() : [];
    for (const nid of plan) {
      v = api.viewOf(pi);
      if (!v || v.over || v.curSeat !== pi || v.phase !== 'move') return;
      if (v.steps <= 0) break;
      if (v.players[pi].pos === nid) continue;
      const before = v.players[pi].pos;
      await tryIntent(api, pi, { act: 'move', id: nid });
      v = api.viewOf(pi);
      if (!v || v.players[pi].pos === before) { await replanOrEnd(api, pi); return; }
    }
    v = api.viewOf(pi);
    if (v && !v.over && v.curSeat === pi && v.phase === 'move') await tryIntent(api, pi, { act: 'endmove' });
  }

  async function replanOrEnd(api, pi) {
    B.stats.replans++;
    const v = api.viewOf(pi);
    if (!v || v.over || v.curSeat !== pi || v.phase !== 'move') return;
    if (v.steps <= 0) { await tryIntent(api, pi, { act: 'endmove' }); return; }
    const best = B.mode === 'random' ? randomMovement(v, pi) : pickMovement(v, pi);
    if (best && best.rec) await walkPath(pi, best, api);
    else {
      const v2 = api.viewOf(pi);
      if (v2 && !v2.over && v2.curSeat === pi && v2.phase === 'move') await tryIntent(api, pi, { act: 'endmove' });
    }
  }

  async function tryIntent(api, pi, m) {
    B.stats.intents++;
    await pace(pi);
    try { await api.applyIntent(pi, m); } catch (e) { /* the engine's own gates reject */ }
  }

  /* ================= TABLE BANTER =================
     One line at most per turn, ~7% of turns plus rare event reactions — dry,
     state-driven, drawn from the same deterministic stream as the play. */
  const CHAT = {
    flavor: [
      'quite frankly, this board is a scam and I am the scam',
      'anyone else smell that? regulators. everywhere.',
      'i am not saying I planned this. I planned this.',
      'the boulder pays. just saying.',
      'cot Report: my cortisol and my portfolio disagree',
      'who built this collage. be honest.',
      'buy low, seize lower',
      'the wire says quiet. the wire lies.',
      'i miss the servo already',
      'red threads everywhere. not walking them.',
    ],
    rich: [
      'i could buy the whole board but where is the fun in that',
      'the number in my sidebar is doing great things for my skin',
      'money can’t buy happiness but it can buy CHARTS',
      'someone stop me. no? noted.',
    ],
    broke: [
      'my net worth is vibes at this point',
      'living paycheck to paycheck like a public servant',
      'if anyone needs me I will be at the servo',
      'the boulder is my only income stream',
    ],
    stress: [
      'i am FINE. the cortisol is FINE.',
      'nine is just a number. a raid is just a lifestyle.',
      'whoever is leaking dirt on me: jokes are legal now',
      'my brand manager has resigned',
    ],
    taunt: [
      'nice portfolio. would be a shame if someone leaked on it',
      'i have a missile and a dream',
      'the ACCC loves my paperwork. keep an eye on YOURS.',
      'collecting regulators like stamps, cheers',
      'you lot are renting. I am EXPROPRIATING.',
    ],
    raid: [
      'a raid builds CHARACTER. and rubble.',
      'my two best nodes died doing what they loved',
      'the regulators sent their regards. and a fine.',
      'rebuilding. emotionally and financially.',
    ],
    panic: [
      'PANIC? I call it a buying opportunity with extra steps',
      'the wire says panic. my book says discount.',
      'everyone stay calm. I am already calm. I AM CALM.',
      'markets are down. I am up. coincidence? yes.',
    ],
    hype: [
      'the frenzy is a lifestyle. I am simply on trend.',
      'front page or nothing, baby',
      'trending. unspecified on what.',
      'my brand manager says strike while the mood is FRENZY',
    ],
    bs: [
      'just saw a dog in a suit outside. anyway. buying charts.',
      'thinking about the boulder again',
      'my horoscope said seize. who am I to argue.',
      'does anyone else hear the yield curve whispering',
      'I do not have a plan. I have VISION. and also a plan.',
      'putting everything in blue barrels and faith',
      'the servo pie is still warm. financially speaking.',
      'big if true. small if false. medium if uncertain.',
      'I am not locked in here with you. you are locked in here with ME.',
      'someone moved my terminal. was it you. it was you.',
      'cortisol is just spicy confidence',
      'not to be dramatic but the board is my entire personality',
      'every node I seize is a node that believed in me',
      'reading the deck like a diary. it is MY diary.',
    ],
    grudge: [
      'I know who took my node. I have the receipts.',
      'this is a grudge match now. it always was.',
      'someone is about to learn what a toll feels like',
      'I am not mad. I am rebuilding a list.',
    ],
  };
  function pickLine(v, pi, bucket) {
    const arr = CHAT[bucket];
    return arr[Math.floor(r32(pi) * arr.length)];
  }

  /* ================= LOBBY CHATTER =================
     In-character lobby lines — cosmetic only, so unlike the play these may
     read Math.random: nothing here ever touches game state or the streams. */
  const LOBBY_LINES = {
    markwatson: [
      'just here for the coal. the coal and the vibes.',
      'watson keeps the ACCC off my coal. beautiful legislation.',
      'they say diversify. I say dig.',
      'if the board has coal on it, the board is already won',
    ],
    tomkins: [
      'the market opens when I finish polishing the silver',
      'I have served three cons and outlived them all',
      'tea first. treason second.',
      'I do not run. I arrive, slightly early.',
    ],
    jimchalmers: [
      'the budget is fine. trust me. I wrote it.',
      'fiscal discipline is when YOU spend less',
      'my portfolio is a coalition of the willing',
      'surplus incoming. do not ask what kind.',
    ],
    bessock: [
      'the news is whatever I say it is. today: good.',
      'breaking: me, doing great',
      'I do not spin stories. I curate reality.',
      'buy my narrative. shares still cheap.',
    ],
    calvinathanasius: [
      'I wore this suit to seize nodes',
      'one does not simply play the con. one INHABITS it.',
      'the gold cools my cortisol and my temperament',
      'a con without style is just a transaction',
    ],
    denialswan: [
      'I deny everything. preemptively.',
      'there is no conspiracy. there is a TABLE though.',
      'whatever happened, I was elsewhere',
      'the numbers are misleading and I am honest',
    ],
    japsnchen: [
      'small mercies, big margins',
      'I put the con in econ',
      'the supply chain ends at my seat',
      'quiet hands, loud portfolios',
    ],
    thousandyardwax: [
      'I saw this lobby three days ago',
      'the wire told me your pick already. no spoilers.',
      'a thousand yards is also my buyout range',
      'everything on this board already happened. I watched.',
    ],
    Alexander_Lane: [
      'toktimer says the con starts in forty seconds. it is never wrong.',
      'I clock events for a living. yours is coming.',
      'the ticker never sleeps. neither do I. help.',
      'timestamped, filed, and coming for the boulder',
    ],
    DJT: [
      'quite frankly, this lobby has the best seats. tremendous seats.',
      'nobody cons bigger than me. nobody.',
      'the jt portal is my portal. I barely use it.',
      'they are eating the nodes. the nodes. of the con.',
    ],
    thebigag: [
      'the land is patient. so am I.',
      'commodities feed you. I prefer owning the feeding.',
      'barrels and forklifts. a love story.',
      'I grew this portfolio. literally.',
    ],
    thebigwegrzyn: [
      'Seth Wegrzyn enters. the room improves.',
      'I am not a big con. I am THE big wegrzyn.',
      'the boulder knows my name now',
      'you will remember this lobby. everyone does.',
    ],
    _generic: [
      'the con is on. act natural.',
      'waiting for the mark. the mark is you.',
    ],
  };
  function lobbyLine(id) {
    const arr = LOBBY_LINES[id] || LOBBY_LINES._generic;
    return arr[Math.floor(Math.random() * arr.length)];
  }
  function maybeChat(pi, v, api) {
    if (!api || !api.chat) return;
    const last = B.lastChat[pi] | 0;
    const gap = v.turn - last;
    const p = v.players[pi];
    /* forced reactions: a raid needs a word about it */
    if (p.raided && gap >= 3) { B.lastChat[pi] = v.turn; api.chat(pi, pickLine(v, pi, 'raid')); return; }
    /* voluntary lines: the table runs about two lines per turn total, split
       across the seats, after a short quiet gap — chatty but never spammy */
    const rate = 1.7 / Math.max(2, v.players.length);
    if (gap < 2 || r32(pi) >= rate) return;
    let bucket = 'flavor';
    const mem = B.memory[pi];
    const grudges = mem && mem.grudge ? mem.grudge : {};
    const gMax = Math.max(0, ...Object.keys(grudges).map(k => grudges[k]));
    if (p.cortisol >= 6) bucket = 'stress';
    else if (gMax >= 2) bucket = 'grudge';
    else if (p.money < 5) bucket = 'broke';
    else if (p.money >= v.goal * 0.8) bucket = 'rich';
    else if (strongestSeat(v, pi) >= 0 && evalSeat(v, pi).score > evalSeat(v, strongestSeat(v, pi)).score + 60) bucket = 'taunt';
    else if (v.mood === 'PANIC') bucket = 'panic';
    else if (v.mood === 'FRENZY') bucket = 'hype';
    if (bucket === 'flavor' && r32(pi) < 0.6) bucket = 'bs';
    B.lastChat[pi] = v.turn;
    api.chat(pi, pickLine(v, pi, bucket));
  }


  /* ================= ACTION PLANNING ================= */
  function victimValue(v, me, victim, fire) {
    if (!vulnerable(v, victim)) return -2; /* the ≤1-node immunity eats it */
    const p = v.players[victim];
    let val;
    if (p.cortisol + fire >= 9) val = 120; /* pushes them into the raid */
    else {
      const near = progressTowardWin(v, victim) > -12 ? 1.6 : 1;
      val = (hazardFire(p.cortisol + fire) - hazardFire(p.cortisol)) * near * 2.2;
    }
    /* humans over bots — scaled by how close the human is to the win, so a
       losing human is not bullied over a bot about to bank. The bot flag
       rides on every view row, so this is table-visible info. */
    if (!p.bot) {
      const prog = clamp((p.money || 0) / (v.goal || 100), 0, 1);
      val = val * (1.12 + 0.5 * prog) + 4 + 4 * prog;
    }
    /* grudges (attributable takeovers) and set-threat guards */
    const g = grudgeOf(me, victim);
    if (g) val += g * 10;
    const mem = B.memory[me];
    if (mem && mem.guard === victim) val = val * 1.25 + 8;
    return val;
  }
  /* the juiciest target for a given fire load — humans are priced in above */
  function bestVictim(v, pi, fire) {
    let best = -1, bestV = -Infinity;
    for (const j of victimsOf(v, pi)) {
      const val = victimValue(v, pi, j, fire);
      if (val > bestV) { bestV = val; best = j; }
    }
    return best;
  }

  function pickAction(v, pi) {
    const me = v.players[pi];
    const list = [];
    /* ---- convergence pressure: the con has to END ----
       A game only finishes when a seat holds cash >= goal AND the full set of
       node types. So past the mid-game the whole table ramps hostility (+2%/turn),
       a rival inside the home stretch is hunted 1.7x harder, and a seat in its
       own home stretch chases raw cash — sisyphus pushes and intel sales — over
       vanity buys (spending down delays the win). Gated at turn 30 so staged
       micro-rigs and opening books stay deterministic and calm. */
    const late = v.turn >= 30;
    const nearGoal = late && me.money >= v.goal * 0.72;
    const leader = strongestSeat(v, pi);
    const leaderNear = late && leader >= 0 && v.players[leader].money >= v.goal * 0.75;
    const homeStretch = v.players.filter((pl, i) => i !== pi && progressTowardWin(v, i) > -12).length;
    const str = strOf(v, pi);
    const ramp = late ? 1 + Math.max(0, v.turn - 45) * 0.02 : 1;
    const urg = str.aggr * ramp * (leaderNear ? 1.7 : 1) * (nearGoal ? 0.6 : 1);
    const cashRush = str.cash * (nearGoal ? 2.2 : 1);
    const sz = seizeCandidate(v, pi, me.pos);
    if (sz) list.push(sz);
    /* lay low — the always-legal pass; cooling is worth a lot at high cortisol,
       and a hot seat near the raid wall cools before it schemes (the caution
       turn after a raid costs more than any single action is worth) */
    const coolNeed = me.cortisol >= 7 ? 3.2 : me.cortisol >= 5 ? 1.6 : 1;
    list.push({
      kind: 'laylow',
      val: me.cortisol >= 3 ? (fireOf(v, pi, me.cortisol) - fireOf(v, pi, Math.max(0, me.cortisol - 2))) * coolNeed : 0.5,
      choice: me.cortisol >= 3 ? 'cool' : 'cash',
    });
    /* sell intel: the market pays most when the mood is worst */
    const rate = v.moodRate;
    if (me.intel >= 3 && rate >= 3) list.push({ kind: 'sell', n: Math.min(3, me.intel), val: rate * Math.min(3, me.intel) * 0.9 });
    else if (me.intel >= 6) list.push({ kind: 'sell', n: Math.min(6, me.intel), val: rate * Math.min(6, me.intel) * 0.72 });
    /* bought knowledge (spy) — once per turn while it is still unknown */
    if (me.intel >= 2 && !knowledge(v)) list.push({ kind: 'spy', val: 2.4, continuing: true });
    /* counter-intelligence: rival bugs sitting on MY nodes are a rival income
       stream — sweeping them is the office being cleaned (see the engine's
       "remove every bug on your nodes" contract) */
    if (me.intel >= 2) {
      let rivalBugs = 0;
      for (const id of myNodes(v, pi)) if (v.bugs[id] != null && v.bugs[id] !== pi) rivalBugs++;
      if (rivalBugs) list.push({ kind: 'sweep', val: rivalBugs * 20 * W.money - 2 * W.intel * 2 });
    }
    /* attacks — only at victims the cortisol quirk lets us touch; the target
       is the best-valued victim, humans over bots (see victimValue) */
    if (victimsOf(v, pi).length) {
      const top = bestVictim(v, pi, 2);
      if (top >= 0) {
        if (me.intel >= 2) list.push({ kind: 'leak', target: top, val: victimValue(v, pi, top, 2) - 2 * W.intel * 2 });
        if (v.owner['asic'] === pi && me.money >= 4 && !v.audited) {
          list.push({ kind: 'audit', target: top, val: victimValue(v, pi, top, 1) - 4 * W.money });
        }
        const tv = v.players[top];
        if (v.owner['trump'] === pi && me.money >= 2 && tv.intel >= 4) {
          const loss = Math.min(tv.intel, Math.max(3, Math.ceil(tv.intel * 0.5)));
          list.push({ kind: 'tweet', target: top, val: loss * W.intel * 2 - 2 * W.money });
        }
        const spinKind = v.owner['fox'] === pi ? 'fox' : (v.owner['press'] === pi ? 'press' : null);
        if (spinKind && !v.spun && me.money >= (spinKind === 'fox' ? 2 : 3)) {
          list.push({ kind: 'roast', target: top, val: victimValue(v, pi, top, 1) - (spinKind === 'fox' ? 2 : 3) * W.money });
        }
      }
    }
    if (v.owner['rock'] === pi && me.cortisol >= 3 && me.money >= 3 && !v.cooked) {
      list.push({ kind: 'cook', val: (fireOf(v, pi, me.cortisol) - fireOf(v, pi, me.cortisol - 3) - 3 * W.money) * 1.5 });
    }
    /* free-ish self-care at owned cooling nodes — a hot seat should nearly
       always take the free relief standing right there */
    if (me.pos === 'asics' && v.owner['asics'] === pi && me.cortisol >= 2) {
      list.push({ kind: 'jog', val: (fireOf(v, pi, me.cortisol) - fireOf(v, pi, me.cortisol - 1)) * 1.4 });
    }
    if (v.geo && me.pos === 'geo_wonsan' && v.owner['geo_wonsan'] === pi && me.cortisol >= 2 && !v.geoBeach) {
      list.push({ kind: 'beach', val: (fireOf(v, pi, me.cortisol) - fireOf(v, pi, me.cortisol - 2)) * 1.4 });
    }
    if (v.geo && me.pos === 'geo_venice' && v.owner['geo_venice'] === pi && me.cortisol >= 2 && !v.geoVenice) {
      list.push({ kind: 'venicecool', val: (fireOf(v, pi, me.cortisol) - fireOf(v, pi, me.cortisol - 1)) * 1.4 });
    }
    if (v.owner['gov'] === pi && me.money >= 4 && !v.budgeted) {
      list.push({ kind: 'budget', val: (v.players.length - 1) * W.money + 6 - 3 * W.money });
    }
    if (me.pos === 'sisy' && v.owner['sisy'] === pi) {
      list.push({ kind: 'push', val: (v.sisyPayout || 10) * W.money });
    }
    if (me.intel >= 5 && me.cortisol <= 2 && v.players.some((pl, i) => i !== pi && pl.cortisol >= 6 && vulnerable(v, i))) {
      list.push({ kind: 'masspanic', val: (v.players.length - 1) * 6 });
    }
    if (me.intel >= 5 && me.money >= 7 && v.owner['made'] != null && v.owner['made'] !== pi) {
      list.push({ kind: 'divestmade', val: progressTowardWin(v, v.owner['made']) > 0 ? 12 + projectIncome(v, v.owner['made']) : 4 });
    }
    /* plant a bug — $1/turn skim (2 with the WEF) for as long as it survives */
    if (me.intel >= 1) {
      const A = buildAdj(v);
      let bb = null;
      for (const nid of (A[me.pos] || [])) {
        const o = v.owner[nid];
        if (o == null || o === pi) continue;
        if (v.bugs[nid] != null || v.rubble[nid]) continue;
        const skim = v.owner['wef'] === pi ? 2 : 1;
        /* sweep is real counter-intelligence now, so the skim does not run
           a full nine turns: a victim with a couple of nodes can spend an
           action and 2 Intel to clear it. Bots sweep eagerly (their own
           policy prices a rival bug at ~$20), humans less reliably. */
        const surv = v.players[o].bot ? 0.55 : 0.75;
        const val = 9 * skim * surv * W.money - (v.owner['insider'] === pi ? 0 : 1) * W.intel * 2
          + nodeOwnValue(v, o, nid) * (v.players[o].bot ? 0.12 : 0.18);
        if (!bb || val > bb.val) bb = { kind: 'bug', nid, val };
      }
      if (bb) list.push(bb);
    }
    /* CORTISOL OVERLOAD — 30 Intel, bypasses the one-node immunity */
    if (me.intel >= 30) {
      let top = -1, topSc = -Infinity;
      for (let j = 0; j < v.players.length; j++) {
        if (j === pi) continue;
        const s = evalSeat(v, j).score + (v.players[j].bot ? 0 : 40); /* humans first */
        if (s > topSc) { topSc = s; top = j; }
      }
      if (top >= 0) {
        const near = v.players[top].cortisol + 6 >= 9;
        const val = near ? 120 : victimValue(v, pi, top, 6) - 30 * W.intel * 2;
        if (near || progressTowardWin(v, top) > -10) list.push({ kind: 'targetpanic', target: top, val });
      }
    }
    if (v.owner['bond'] === pi && v.owner['leak'] === pi && me.money >= 16 && me.intel >= 4 && !v.bondmageddonUsed) {
      const leader = bestVictim(v, pi, 2);
      if (leader >= 0 && progressTowardWin(v, leader) > -10 && chartsOwned(v, leader) > 0) {
        list.push({ kind: 'bondmageddon', target: leader, val: 30 });
      }
    }
    if (v.owner['back'] === pi && !v.pressured && v.players.some((pl, i) => i !== pi && progressTowardWin(v, i) > -12 && vulnerable(v, i))) {
      list.push({ kind: 'pressure', val: 8 + 4 * homeStretch });
    }
    if (v.owner['albo'] === pi && !v.blockadeUsed) {
      const bd = pickBlockadeTarget(v, pi);
      if (bd) list.push({ kind: 'blockade', nid: bd, val: 12 + 4 * homeStretch });
    }
    if (v.geo) {
      /* STAGE 5 DECLINE: the richest rival skips a whole income turn */
      if (v.owner['geo_stage5'] === pi && me.intel >= 2 && !v.geoUsed.stage5) {
        const leader = strongestSeat(v, pi);
        if (leader >= 0 && v.owner['geo_pillars'] !== leader) {
          list.push({ kind: 'stage5', target: leader, val: projectIncome(v, leader) * W.incomeTurns * 0.8 });
        }
      }
      if (v.owner['geo_scs'] === pi && me.money >= 3 && !v.geoUsed.crash && countType(v, pi, 'COMMODITY') === 0) {
        const oilVictims = ownersOf(v, n => v.oilIds.indexOf(n.id) >= 0).length;
        if (oilVictims) list.push({ kind: 'oilcrash', val: oilVictims * 2 * W.money * 0.8 });
      }
      if (v.owner['geo_boeing'] === pi && me.money >= 4 && !v.geoUsed.boeing && v.owner['qantas'] != null && v.owner['qantas'] !== pi) {
        list.push({ kind: 'qantasdown', val: 10 });
      }
      /* THE MISSILE — erase the leader's best standing asset (or break the ESG
         shield). Tuvalu is never a target: the island reflects the warhead. */
      if (canFireFromPos(v, pi, me.pos) && me.money >= 4 && me.intel >= 1 && !v.geoMissiled) {
        const shielded = nid => { const o = v.owner[nid]; return o != null && o !== pi && v.owner['geo_pillars'] === o && nid !== 'geo_pillars'; };
        let bm = null;
        for (const n of v.nodes) {
          const o = v.owner[n.id];
          if (o == null || o === pi || v.rubble[n.id] || n.id === 'geo_tuvalu' || shielded(n.id)) continue;
          const val = nodeOwnValue(v, o, n.id) * (v.players[o].bot ? 0.6 : 0.85) - 4 * W.money - W.intel * 2;
          if (!bm || val > bm.val) bm = { kind: 'missile', nid: n.id, target: o, val };
        }
        if (bm && bm.val > 4) list.push(bm);
      }
      /* OVERTOURISM — the Venice owner rides a rival node for a rotation */
      if (v.owner['geo_venice'] === pi && me.money >= 2 && !v.geoVenice) {
        let bo = null;
        for (let j = 0; j < v.players.length; j++) {
          if (j === pi || !vulnerable(v, j) || progressTowardWin(v, j) <= -12) continue;
          for (const nid of myNodes(v, j)) {
            if (v.rubble[nid]) continue;
            const val = victimValue(v, pi, j, 1) * v.players.length * 0.8 - 2 * W.money;
            if (!bo || val > bo.val) bo = { kind: 'overtour', nid, target: j, val };
          }
        }
        if (bo && bo.val > 2) list.push(bo);
      }
      /* REBUILD — only with heavy spare cash: the node returns unowned, so the
         value is mostly re-opening the graph (and a missing set type) */
      if (v.rubble[me.pos]) {
        const n = v.nmap[me.pos];
        if (n && me.money >= n.cost * 2 + 10) {
          list.push({ kind: 'rebuild', val: nodeOwnValue(v, pi, me.pos) * 0.35 - n.cost * W.money - 2 });
        }
      }
    }
    /* the dossier as a takeover prelude */
    if (me.intel >= 3 && !v.dossier) {
      const take = list.filter(x => x.kind === 'seize' && x.isTake)[0];
      if (take && take.cost - take.base >= 3) {
        list.push({ kind: 'dossier', val: (take.cost - take.base) * W.money - 3 * W.intel * 2 + 2, continuing: true });
      }
    }
    /* apply the character's temperament: hostility through urg, cash plays
       through cashRush (see the convergence block at the top) */
    const ATTACK = { leak: 1, audit: 1, tweet: 1, roast: 1, targetpanic: 1, masspanic: 1, bondmageddon: 1, pressure: 1, stage5: 1, qantasdown: 1, oilcrash: 1, missile: 1, overtour: 1, divestmade: 1, blockade: 1 };
    for (const c of list) {
      if (ATTACK[c.kind]) c.val *= urg;
      else if (c.kind === 'bug') c.val *= 1 + (urg - 1) * 0.5;
      else if (c.kind === 'push' || c.kind === 'sell') c.val *= cashRush;
      else if (c.kind === 'laylow' && c.choice === 'cash' && nearGoal) c.val *= cashRush;
    }
    let best = null;
    for (const c of list) if (!best || c.val > best.val) best = c;
    if (best && best.val < 0.55) return { kind: 'laylow', choice: me.cortisol >= 3 ? 'cool' : 'cash' };
    return best;
  }

  function victimsOf(v, pi) {
    const out = [];
    for (let i = 0; i < v.players.length; i++) if (i !== pi && vulnerable(v, i)) out.push(i);
    return out;
  }
  function countType(v, seat, t) { return mineWhere(v, seat, n => n.type === t).length; }

  function pickBlockadeTarget(v, pi) {
    /* wall off the node whose loss would hurt the strongest rival most */
    let best = null, bestV = 1.2;
    for (const n of v.nodes) {
      if (!passable(v, n.id)) continue;
      const o = v.owner[n.id];
      if (o === pi) continue;
      if (o != null) {
        const bias = v.players[o].bot ? 1 : 1.35;
        const denial = (nodeOwnValue(v, o, n.id) * 0.5 - nodeOwnValue(v, pi, n.id) * 0.1) * bias;
        if (denial > bestV) { bestV = denial; best = n.id; }
      } else {
        for (const j of victimsOf(v, pi)) {
          if (progressTowardWin(v, j) <= -16) continue;
          const would = nodeOwnValue(v, j, n.id) * (v.players[j].bot ? 1 : 1.35);
          if (would > bestV) { bestV = would; best = n.id; }
        }
      }
    }
    return best;
  }

  function pickRandomAction(v, pi) {
    const me = v.players[pi];
    const opts = [];
    const sz = seizeCandidate(v, pi, me.pos);
    if (sz) opts.push(sz);
    const rivals = victimsOf(v, pi);
    if (me.intel >= 2 && rivals.length) opts.push({ kind: 'leak', target: rivals[Math.floor(r32(pi) * rivals.length)] });
    if (me.intel >= 2) opts.push({ kind: 'spy', continuing: true });
    if (me.intel >= 3 && v.moodRate >= 3) opts.push({ kind: 'sell', n: 2 });
    opts.push({ kind: 'laylow', choice: me.cortisol >= 5 ? 'cool' : 'cash' });
    return opts[Math.floor(r32(pi) * opts.length)];
  }

  async function dispatchAction(v, pi, pick, api) {
    switch (pick.kind) {
      case 'seize': {
        /* the engine seizes wherever the seat STANDS — never fire at a stale plan */
        if (v.players[pi].pos !== pick.nid) return false;
        await tryIntent(api, pi, { act: 'seize' });
        /* the waspish one-liner when a hostile takeover actually lands */
        const sv = api.viewOf(pi);
        const victim = v.owner[pick.nid];
        if (pick.isTake && sv && sv.owner[pick.nid] === pi && typeof victim === 'number' && victim !== pi
          && (B.lastChat[pi] | 0) !== sv.turn && r32(pi) < 0.35) {
          B.lastChat[pi] = sv.turn;
          if (api.chat) api.chat(pi, pickLine(v, pi, 'taunt'));
        }
        return true;
      }
      case 'laylow':
        await tryIntent(api, pi, { act: 'laylow', choice: pick.choice });
        return true;
      case 'sell':
        if (pick.n >= v.players[pi].intel) await tryIntent(api, pi, { act: 'sellall' });
        else await tryIntent(api, pi, { act: 'sell', n: pick.n });
        return true;
      case 'spy': await tryIntent(api, pi, { act: 'spy' }); return false;
      case 'dossier': await tryIntent(api, pi, { act: 'dossier' }); return false;
      case 'leak':
        if (v.players[pi].intel >= 2) {
          await tryIntent(api, pi, { act: 'leakmode' });
          await tryIntent(api, pi, { act: 'leak', target: pick.target });
          return true;
        }
        return false;
      case 'audit':
        if (v.owner['asic'] === pi) {
          await tryIntent(api, pi, { act: 'auditmode' });
          await tryIntent(api, pi, { act: 'audit', target: pick.target });
          return true;
        }
        return false;
      case 'tweet':
        if (v.owner['trump'] === pi) {
          await tryIntent(api, pi, { act: 'tweetmode' });
          await tryIntent(api, pi, { act: 'tweet', target: pick.target });
          return true;
        }
        return false;
      case 'roast': {
        await tryIntent(api, pi, { act: 'spin', kind: v.owner['fox'] === pi ? 'fox' : 'press' });
        /* the spin prompt is answered through answerPrompt — roast mode only
           exists if the answer chose 'cortisol'; the engine ignores a stray
           roast otherwise and the final pass closes the turn. */
        const rv = api.viewOf(pi);
        if (rv && rv.mode === 'roast') await tryIntent(api, pi, { act: 'roast', target: pick.target });
        return true;
      }
      case 'cook': await tryIntent(api, pi, { act: 'cook' }); return true;
      case 'jog': await tryIntent(api, pi, { act: 'jog' }); return true;
      case 'beach': await tryIntent(api, pi, { act: 'beach' }); return true;
      case 'venicecool': await tryIntent(api, pi, { act: 'venicecool' }); return true;
      case 'budget': await tryIntent(api, pi, { act: 'budget' }); return true;
      case 'push': await tryIntent(api, pi, { act: 'push' }); return true;
      /* sweep exists in the engine but only ever removes the SWEEPER'S OWN
         bugs (S.bugs is keyed by planter) — nothing emits it on purpose */
      case 'sweep': await tryIntent(api, pi, { act: 'sweep' }); return true;
      case 'masspanic': await tryIntent(api, pi, { act: 'masspanic' }); return true;
      case 'targetpanic': await tryIntent(api, pi, { act: 'targetpanic' }); return true;
      case 'divestmade': await tryIntent(api, pi, { act: 'divestmade' }); return true;
      case 'pressure': await tryIntent(api, pi, { act: 'pressure' }); return true;
      case 'stage5': await tryIntent(api, pi, { act: 'stage5' }); return true;
      case 'oilcrash': await tryIntent(api, pi, { act: 'oilcrash' }); return true;
      case 'qantasdown': await tryIntent(api, pi, { act: 'qantasdown' }); return true;
      case 'rebuild': await tryIntent(api, pi, { act: 'rebuild' }); return true;
      case 'bug': {
        await tryIntent(api, pi, { act: 'bugmode' });
        const bv = api.viewOf(pi);
        if (!bv || bv.mode !== 'bug') return false;
        await tryIntent(api, pi, { act: 'bug', id: pick.nid });
        return true;
      }
      case 'missile': {
        await tryIntent(api, pi, { act: 'missilemode' });
        const mv = api.viewOf(pi);
        if (!mv || mv.mode !== 'missile') return false;
        await tryIntent(api, pi, { act: 'missile', id: pick.nid });
        return true;
      }
      case 'overtour': {
        await tryIntent(api, pi, { act: 'overmode' });
        const ov = api.viewOf(pi);
        if (!ov || ov.mode !== 'overtour') return false;
        await tryIntent(api, pi, { act: 'overtour', id: pick.nid });
        return true;
      }
      case 'blockade':
        await tryIntent(api, pi, { act: 'blockmode' });
        await tryIntent(api, pi, { act: 'blockade', id: pick.nid });
        return true;
      case 'bondmageddon':
        await tryIntent(api, pi, { act: 'bondmageddon', target: pick.target });
        return true;
      default: return false;
    }
  }

  /* ================= PROMPT ANSWERS ================= */
  /* Every private prompt the engine delivers to a bot seat comes through here.
     Same fairness contract as turn decisions: table knowledge only, except
     where the prompt itself IS the (fairly bought) information. */
  function answerPrompt(pi, opt, api) {
    const def = opt.def !== undefined ? opt.def : (opt.options && opt.options[0] ? opt.options[0].v : undefined);
    B.stats.answers++;
    let view = null;
    try { view = api.viewOf(pi); } catch (e) { view = null; }
    let answer;
    try { answer = chooseAnswer(pi, opt, view); } catch (e) { answer = undefined; }
    const val = answer === undefined ? def : answer;
    if (!B.paceMs) return Promise.resolve(val); /* tests: the virtual clock never advances */
    return new Promise(res => {
      try { setTimeout(() => res(val), 400 + r32(pi) * 900); } catch (e) { res(val); }
      setTimeout(() => res(val), 15000); /* never hold the table for a bot */
    });
  }
  function chooseAnswer(pi, opt, view) {
    const title = opt.title || '';
    const byTitle = t => title.indexOf(t) === 0;
    /* knowledge prompts first: record what the bot now fairly knows */
    if (opt.meta && opt.meta.card && opt.meta.kind === 'peek') {
      B.known[pi] = { card: opt.meta.card, at: view.turn };
      const ev = cardEV(opt.meta.card, view, pi);
      if (ev.fire >= 1 || ev.money <= -4) return 'bury';
      return 'keep';
    }
    if (opt.meta && opt.meta.card && opt.meta.kind === 'brief') {
      B.known[pi] = { card: opt.meta.card, at: view.turn };
      return undefined; /* falls through to the default ('Noted') */
    }
    if (byTitle('JTPORTAL INTERVENES?')) {
      const known = knowledge(view);
      if (known) {
        const ev = cardEV(known, view, pi);
        if (ev.money <= -5 || ev.fire >= 2) return 1;
      }
      return 0;
    }
    if (byTitle('BACKROOM DEALS')) {
      /* a seizure is mid-flight: cover the shortfall if Backroom is mine */
      return view.owner['back'] === pi ? 1 : 0;
    }
    if (byTitle('DIVEST MADE')) {
      const mo = view.owner['made'];
      return (mo != null && mo !== pi && progressTowardWin(view, mo) > -8) ? 1 : 0;
    }
    if (byTitle('CORTISOL OVERLOAD') || byTitle('BONDMAGEDDON')) {
      const rivals = (opt.options || []).filter(o => typeof o.v === 'number' && o.v >= 0 && o.v !== pi);
      if (!rivals.length) return -1;
      let best = rivals[0];
      for (const o of rivals) if (evalSeat(view, o.v).score > evalSeat(view, best.v).score) best = o;
      return best.v;
    }
    if (byTitle('MEDIA FRENZY')) {
      const rivals = (opt.options || []).filter(o => typeof o.v === 'number' && o.v >= 0 && o.v !== pi);
      if (!rivals.length) return -1;
      let best = rivals[0];
      for (const o of rivals) if (evalSeat(view, o.v).score > evalSeat(view, best.v).score) best = o;
      return progressTowardWin(view, best.v) > -30 ? best.v : -1;
    }
    if (byTitle('TRUMP TWEETS TARIFFS')) {
      const own = id => view.owner[id] === pi;
      let oil = 0, coal = 0;
      for (const id of ['oil', 'oilgraph', 'barrels', 'tanker', 'petronas']) if (own(id)) oil++;
      for (const id of ['coal', 'train', 'port', 'watson', 'forklift', 'bhp']) if (own(id)) coal++;
      if (oil === coal) return r32(pi) < 0.5 ? 'oil' : 'coal';
      return oil > coal ? 'oil' : 'coal';
    }
    if (byTitle('FOX SPIN') || byTitle('SPIN THE PRESS')) {
      const me = view.players[pi];
      const rivals = victimsOf(view, pi);
      /* roast the strongest rival if it stings, else cool my own head */
      if (rivals.length) {
        const top = strongestSeat(view, pi);
        if (top >= 0 && progressTowardWin(view, top) > -12) return 'cortisol';
      }
      if (me.cortisol >= 3) return 'cool';
      return 'no';
    }
    return undefined;
  }

  /* ================= LIFECYCLE ================= */
  function resetForGame(seed) {
    B.seed = seed >>> 0 || 1;
    B.streams = {};
    B.known = {};
    B.lastChat = {};
    B.memory = {};
    B.lastView = {};
    B.turnStamp = 1;
    B.throttle = false;
    B.pacedTurn = {};
  }

  /* exports */
  B.cardEV = cardEV;
  B.deckEV = deckEV;
  B.evalSeat = evalSeat;
  B.projectIncome = projectIncome;
  B.takeTurn = takeTurn;
  B.answerPrompt = answerPrompt;
  B.resetForGame = resetForGame;
  B.STRATEGIES = STRATEGIES;
  B.VARIANTS = VARIANTS;
  B.strategyOf = strategyOf;
  B.lobbyLine = lobbyLine;
  B.weights = W;
})();
