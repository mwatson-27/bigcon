# The Big Con — Rules-Copy vs Gameplay-Mechanics Audit

**Date:** 2026-10-17
**Scope:** every player-readable rules surface in `index.html` (help modal, node tooltips, event-card text, lobby/setup copy, log & announcement strings) checked against the authoritative inline script — claims compared to **driven behavior**, not string presence.
**Method:** read-only audit. No production code was changed. All driven probes ran the existing repo harness (`tests/helpers/harness.mjs`) through ephemeral stdin drivers (`node --input-type=module`) — no repo files were created or modified during the audit. Repro drivers are recorded verbatim at the bottom of this document.
**Ground rules:** "documented rules" = anything a player reads; source comments count as implementation, not copy. Nothing here changes the engine; each finding ends in a one-line **rule decision** for the maintainer.

**Verdicts:** `MATCH` · `MISMATCH` (mechanic exists, copy disagrees) · `DEAD-COPY` (copy references a mechanic that can never occur) · `UNDOCUMENTED` (mechanic exists, copy never mentions) · `DEAD-REF` (inert code reference with no copy claim).

**Ledger numbering:** findings below are numbered **#11–#17**, continuing the ledger in `docs/CODE_LEVEL_TEST_PLAN.md` (items 1–10). This document also extends and corrects items #6, #7 and #9 of that ledger — see "Corrections & extensions".

---

## Executive summary (new findings, one line each + rule decision)

| # | Finding | Verdict | Rule decision |
|---|---|---|---|
| 11 | Help-modal collage copy names removed nodes ("Germany by Davos", "Canada by the vault") | MISMATCH | Rewrite the placement sentence against live `NODES` |
| 12 | Advertised room-code example "HORNSBY HEIGHTS" is not in `BUZZWORDS` — the advertised example code can never resolve | MISMATCH | Add the buzzword or swap the examples in all three copy spots |
| 13 | "Sell intel — at the **Rumor Exchange**": the venue does not exist anywhere; the action is global (even the engine's own log string names the fake venue) | DEAD-COPY (venue) / MATCH (rates) | Drop venue language, or introduce the venue and gate `sell` to it |
| 14 | "Their seat auto-plays 'lay low'" — the watchdog never offers the lay-low choice; it forces +$1 **cash** and the away seat still collects **full salary** every turn | MISMATCH | Recopy to the real behavior ("auto-plays quiet: salary still paid, +$1, no action") or make away actually run a lay-low selection |
| 15 | Actions list advertises "**Scrub** (Real Yield)" — node `real` is removed; the action can never be performed | DEAD-COPY | Delete from help/lobby copy and the dead UI block, or restore the node |
| 16 | "**Mark Watson is the named monopoly exception**" — the engine instead turns Watson ownership into an *always-suspect* industry (single node ⇒ 20%/$20% fine + forced divestiture) | MISMATCH | Recopy as "holding Watson marks you for review", or implement the exemption the copy promises |
| 17 | "**Charts are exempt**" — true for the six type industries, but `MONETARY POLICY` counts two CHART nodes (`cash`, `infl`) | COPY DRIFT | Amend the copy or drop `infl`/`cash` from the monetary industry |

---

## Copy surfaces audited

| Surface | Location (verified) |
|---|---|
| Help modal `showRules()` | lines 1301–1315 |
| Lobby/goal setup markup | lines 195–226 |
| Node tooltips (`sub:` / `sp:`) | `NODES`, lines 319–398 |
| Event-card copy (`text:` fields + wire strings) | `CARDS`, lines 530–587 |
| Buzzword pool copy | lines 1721–1736, 204, 215 |
| initGame announcement log lines | 887–891 |
| Away/disconnect strings | 1489, 1941, 964 |
| ACCC / MADE / MONOPOLY announcement strings | 707–719, 722–733 |
| Character lobby copy | `CHARS` 497–511, `renderCharGrid` 1872–1885, showRules 1313 |

---

## Findings (ledger continuation #11–#17)

### #11 — Dead pins in the help modal's collage sentence — MISMATCH

- **Copy** (`showRules`, line 1306): "Charts are no longer stacked in one corner — US yields sit by Trump, Japan by the tankers, **Germany by Davos**, UK by the papers, Australia by the coat of arms, **Canada by the vault**, the 10-year master in the middle."
- **Implementation:** `REMOVED_NODE_IDS` (line 438) = `notes, vault, unid1, unid2, real, spend, can, tv, ger, timeline, econ, debt`. `ger` (Germany), `can` (Canada) and `vault` are not on the live board; no node named Davos exists as a pin either (Davos survives legitimately as the WEF *card*, lines 563–564 — that copy is fine).
- **Cross-check (static):** every other pin the sentence claims is alive and adjacency or coordinates match: `us`–`trump` edge (414), `japan`–`tanker` (414), `uk`–`press`/`news` (415, 428), `aus`–`gov` (413), `tenyear` central coordinates (337). The "new pins" list (Westpac, BHP, Herald Sun, bullet train, ASICS, Toktimer) is all-alive (325, 350, 364, 358, 396, 397).
- **Driven behavior:** n/a (existential). The engine's own initGame log tells the truth adjacent to this drift — see extension of ledger item #6 below.
- **Verdict:** MISMATCH — the sentence describes a previous board generation.
- **Rule decision:** rewrite the placement sentence against live `NODES` (e.g. drop the Germany/Davos and Canada/vault legs; UK↔press room is the verifiable neighbor).

### #12 — Advertised room-code example does not exist — MISMATCH

- **Copy:** setup screen (204): "type the one the host read out (**e.g. NESA, HORNSBY HEIGHTS, JAKE TOMKINS**)"; join error prompt (215): "e.g. NESA or HORNSBY HEIGHTS"; help modal (1303): "(NESA, HORNSBY HEIGHTS, JAKE TOMKINS…)".
- **Implementation:** `BUZZWORDS` (line 1724) holds 18 slugs; `HORNSBY HEIGHTS` is **not one of them**. `matchBuzzword` (1729–1736) returns the raw slug for unmatched input; the join path ends at "Room … not found" (2050). `genCode()` only ever issues codes from the pool.
- **Driven behavior (drive C):** `matchBuzzword('HORNSBY HEIGHTS')` → `"HORNSBYHEIGHTS"` with `in BUZZWORDS: false`; `NESA` and `JAKE TOMKINS` both resolve to themselves with `in BUZZWORDS: true`.
- **Verdict:** MISMATCH — the advertised example code can never resolve on any host.
- **Rule decision:** add `HORNSBY HEIGHTS` to `BUZZWORDS`, or swap the copy examples to actual pool entries at all three spots (204, 215, 1303).

### #13 — Sell intel: the "Rumor Exchange" venue is fiction — DEAD-COPY (venue) / MATCH (rates)

- **Copy:** help modal (1305): "**Sell intel** (your action) — **at the Rumor Exchange**: 1 🛈 = $2 calm/boom, $3 frenzy, $4 panic." The engine's own log string repeats the fiction (1119): "sold N Intel at the rumor exchange ($X/🛈)". Action-button title (1562): "cash rumors at the exchange".
- **Implementation:** the sell action's entire gate is `act==='sell' && S.phase==='action' && !S.mode && m.n>0` (1115) — **no location requirement in either direction**. No node on the board is named (or claims to be) the Rumor Exchange.
- **Driven behavior:** drive D (CALM): sold 2 🛈 → **+$4 exact** (`💰 … sold 2 Intel at the rumor exchange ($2/🛈)`), from anywhere, with no owner requirement. Probe P2.3 (PANIC): sold 3 🛈 → **+$12 exact** (rate 4). Rates match `MOODS.rate` (514–519: CALM 2, BOOM 2, FRENZY 3, PANIC 4) and modal value-for-mood exactly.
- **Verdict:** DEAD-COPY for the venue; MATCH for the rates.
- **Rule decision:** drop the venue language (cheapest), or introduce the venue as a real node/edge and gate `sell` to standing on it.

### #14 — Away autoplay is not "lay low" — MISMATCH

- **Copy:** help modal (1303): "If someone drops, their seat **auto-plays 'lay low'**." In-table Lay Low is a *choice* (help 1309: "choose $1 cash or −2 Cortisol"; UI buttons 1564–1565 → `laylowcash` / `laylowcool` → dispatch `choice` 1715–1716). The engine log the player actually sees: "💤 … is away — **plays it quiet**." (1941, 964); sidebar "(away — auto-playing)" (1489).
- **Implementation:** two watchdog sites, both forcing `gain(i, 1, 'away')` — money, not Intel (`gain()`, line 626):
  1. **Mid-turn disconnect** (1938–1942): after 20 s, if the disconnected seat is still the current player in move/action phase → log + `gain(pi,1,'away')` + `endOfTurn()`.
  2. **Turn-start auto-pass** (964): `if(p.dc){ …log…; gain(S.cur,1,'away'); endOfTurn() }` — and this runs **after** the income branch (939–941 `else income(S.cur)`), so the away seat collects **full salary income** before its $1 award.
  The lay-low action itself (1122–1123) requires the drop-down choice `m.choice` and is never invoked by either away path. The −2 Cortisol branch of lay-low is unreachable for a disconnected seat.
- **Driven behavior:** drive E (mid-turn): money delta **exactly +3** (away +1, forced `quiet`-deck event +2), no prompt or choice presented, Cortisol untouched. Drive F (turn-start away seat): delta **exactly +6** — **+3 full salary** (`💵 Player 2 collects $3 (salary $3 + holdings $0 + synergies $0)`), **+1 away**, +2 event. Both sites log the identical "plays it quiet" string.
- **Verdict:** MISMATCH — copy claims a choice-based action; the engine pays an unbidden $1 *in addition to* full per-turn income and event participation.
- **Rule decision:** recopy 1303 to the real behavior ("their seat auto-plays quiet: it still collects its salary, pockets $1, and skips movement and actions"), or implement away = lay-low selection (cash vs cool) before `endOfTurn()`.

### #15 — "Scrub (Real Yield)" advertised; mechanic unlandable — DEAD-COPY

- **Copy:** help modal Actions list (1309): "**Scrub** (Real Yield)". Player-facing UI block (1513): button label "**📉 Read the real yields — −1 🔥 · 2 steps**" with click dispatch `scrub` (1706).
- **Implementation:** the scrub action is gated on `p.pos==='real' && S.owner.real===pi` (1074). `real` is in `REMOVED_NODE_IDS` (438) — it has no `NODES` entry, so no player can ever stand on or own it; the button branch can never render.
- **Driven behavior:** constructional — nothing to drive; RC-07's dead-reference audit guarantees the id cannot be revalidated into existence.
- **Verdict:** DEAD-COPY — help copy advertises an action no player can ever perform.
- **Rule decision:** delete Scrub from 1309 and remove the dead 1513 UI block, or restore the `real` node to the board.

### #16 — The Watson "monopoly exception" is actually a monopoly trigger — MISMATCH

- **Copy:** help modal (1311): "Coal is not a tracked industry; **Mark Watson is the named monopoly exception**." The natural reading: owning Watson shields you.
- **Implementation:** `acccInvestigate` (687–719):
  ```
  const hits=concentratedIndustries(pi);
  // Mark Watson himself is the monopoly exception; ordinary coal holdings are not an ACCC industry.
  if(S.owner.watson===pi)hits.push({g:{id:'watson',name:'MARK WATSON'},owned:[NMAP.watson],n:99});
  if(!hits.length)return;
  ```
  The Watson push happens **before** the empty-hits early return, so *any* Watson owner always produces a suspect industry with `n:99`, which sorts first (694) ahead of any genuine >2-holding industry. The code contradicts its own comment on the line above.
- **Driven behavior (drive P2.1):** state with `owner.watson=0, owner.coal=0`, P0 at $100/10 🛈, gate forced via `withRandomSeq([0.2])`: P0 **lost $20 and 2 Intel (20%/20%)**, and **Mark Watson was divested to P1**; log: "🧐 MONOPOLY ALERT! P0 is forced to dump the whole MARK WATSON book (MARK WATSON CEO OF COAL)… Fine: $20 and 2 Intel." — a single held pin, not "more than two properties" of anything. Gate-off control (P2.2, r=0.5): no investigation and no protection — the Watson clause neither shields nor triggers on its own; only the shared ⅓ gate applies.
- **Verdict:** MISMATCH — copy promises immunity; the engine weaponizes the node.
- **Rule decision:** either recopy ("holding Mark Watson puts you on the ACCC list — each start-of-turn may fire a Watson review: 20%/20% fine and your Watson pin is divested; coal itself is never a tracked industry") or change the code so Watson ownership actually exempts the holder.

### #17 — "Charts are exempt" fails for MONETARY POLICY — COPY DRIFT

- **Copy:** help modal (1311): "**Charts are exempt.**"
- **Implementation:** `INDUSTRIES` (666–678): the six type-based industries pick by `n.type`, so charts are genuinely exempt from BANK/REGULATOR/CORPORATE/COMMODITY/MEDIA tracking. But the custom `monetary` industry is `ids:['mpc','rba','cash','bullock','infl']` (677) — `cash` (339) and `infl` (338) are **type CHART** nodes. A player holding `cash + infl + mpc` (two charts) is investigated as a monetary-policy monopoly.
- **Driven behavior:** static (industry membership is data, exercised by the EC-08 suite's structure).
- **Verdict:** COPY DRIFT — true for type industries, false for monetary policy.
- **Rule decision:** amend the copy ("charts are exempt from type industries; two charts count toward MONETARY POLICY") or drop `infl`/`cash` from the monetary ids.

---

## Corrections & extensions to the `CODE_LEVEL_TEST_PLAN.md` ledger

**Extension of item #6 (copy drift):** the engine's own initGame log is truthful — drive B captured "🌅 A new board is dealt — **70** exhibits, 192 freshly rebuilt connections…" (line 887 interpolates live `NODES.length`). Only the showRules modal (1306) and the source header comment (319) claim 82. The "new pins" list inside that same sentence is accurate.

**Extension of item #7 (dead references):** full call-site inventory of removed-id references, all inert:

| Ref | Sites | Note |
|---|---|---|
| `spend` | 554 (budget card: `gain(s,3,'the spending graphic glows')` branch) | dead payout branch; no copy claims it |
| `notes` | 560 (goldrush "collectors pay up" +$2 branch), 992 (`own('notes')&&bank` synergy) | dead; card text does not promise the payout |
| `real` | 1074 (scrub), **1513 (player-visible scrub button)** | copy claims the mechanic (#15) |
| `econ` | 1138 (second CHART-discount notch inside `seizeListPrice`) | only the NAB tooltip (323) claims a $1 CHART discount, and it applies exactly once; the econ notch never does |
| `timeline` | 1182 (second maybePeek spot) | no copy mentions a Timeline pin |
| `vault`,`can`,`ger`,`tv`,`debt`,`unid1`,`unid2` | none | exist only in the removal set and (for vault/can/ger) in help copy (#11) |

**Correction of item #9:** the ledger says the watchdog makes the seat "auto-plays 'lays low' + **$1 Intel**". Drives E/F prove the award is **$1 money** (`gain()`, log `💰 … gains $1 — away.`), not Intel, and that the behavior is not lay-low at all (finding #14).

---

## Verified-MATCH inventory (audited this session)

Everything below was checked against code this session; drives where noted, otherwise exact source line verification. Previously pinned items from the existing suites are inherited and listed without re-litigating (see the brief's "already verified as EXACT" list — favour, slip, fly, leak, spy, dossier, masspanic, audit, tweet, roast, cook, budget, pressure, divest, push doubling, raid contract, goal clamp).

| Claim (source) | Code | Evidence | Verdict |
|---|---|---|---|
| "lock in that character's dedicated player colour" (1313) | `charMeta(d.char).color || PCOLORS[i%8]` (882) | drive A: every seat's engine colour == `CHARS` colour (seats 0–1 shown) | MATCH; UNDOCUMENTED otherwise — **no perk text exists anywhere** (`CHARS` 497–511 carries id/name/file/colour only; `applyChar` 1864 = validate/uniqueness; `renderCharGrid` 1872–1885 renders name + swatch) |
| Quikstop "five neighbourhoods" + initGame log labels (890) | `slot.label` verbatim (453–459) | drive B: slot 3 → "across from the Reserve Bank", exact string equality | MATCH |
| Sell-intel mood rates (1305) | `MOODS[S.mood].rate` (1116; 514–519) | drives D + P2.3: CALM $2 (2×🛈=+$4), PANIC $4 (3×🛈=+$12) | MATCH |
| Win types sentence (setup 212, 1307, 891) | `WIN_TYPES` (1276) | identical 7-type list, same order | MATCH |
| "only four REGULATORS on the whole board" (1307) | NODES | rba, asic, accc, gov | MATCH |
| "$3 salary (+$1 CPI-indexed)" (1307; infl tooltip 338) | 979 | salary base 3 → 4 with `infl` | MATCH |
| Start-of-turn ability claims (tooltips 328/383/347/375/390/394/378/369) | `startTurn` 942–953 | rba −1🔥, sat −1🔥, gold −2🔥 (min-relief), whistle +1🛈, bullock +1🛈, jt +1🛈, mpc +1🛈, school gate 3+ charts, news gate 2+ media | MATCH (static, amounts exact) |
| Movement steps (1308): base 3, coal +1, train-or-bullet +1 no stacking, asics +1, favor +1 *while moving* | 957–958, 1022 | formula matches; favor is `S.phase==='move'`-gated and once/turn (`!S.extraStep`) | MATCH |
| Lay low "choose $1 cash or −2 Cortisol" (1309) | 1122–1123; UI 1564–1565 | both branches wired | MATCH (claim itself is fine — the away path is the drift, #14) |
| ACCC math copy (1311): >2 holdings, ⅓ at start of your turn, 20%/20% fine, max-one-node-per-rival, remainder to market, Watson marked | 687–719 (gate 693; call site 955) | see findings #16/#17 for the two copy disagreements; the arithmetic and redistribution copy match | MATCH except #16/#17 |
| MADE modal copy (1312): ⅓ every start-turn, +$10/+1🛈; others with >2 nodes and ≥$50 pay 15% of cash; never inflates; divest 5🛈+$7 | `startTurn` 954, `madePay` 722–733, `divestmade` 1106–1113 | 1312 sentence == engine behavior sentence-for-sentence | MATCH — but the MADE **node tooltip** (395) remains the known MISMATCH ("every other player pays $3 and gains +1 Cortisol" vs the actual 15% cash cut, no Cortisol), reconfirmed |
| Card texts' holder interactions | all 24 `CARDS` | holder-present sweep (P2.4): 14 cards shift behavior exactly where their texts name holders (`rates` both-insiders-free-fee; `ceophoto` Watson-co-owner deflect; `tapes` both keeper branches; `quikrob` 007 +2; `ibexams`, `mpcfinals`, `budget`, `tariffs`, `davos`, `bigscreen`, `goldrush` windfall distribution all consistent) | MATCH (two known exceptions above) |
| "Insiders pay nothing" on rate events (`rates` card text 536) | 537 | both rba/bullock owners exempt in owned-fabric run | MATCH |
| Buzzword acceptance for real pool members | `matchBuzzword`/`codeSlug` (1725–1736) | drive C: NESA, JAKE TOMKINS resolve | MATCH (HORNSBY HEIGHTS is finding #12) |

---

## Open rule decisions queue (consolidated)

Items needing a maintainer decision, newest first. Copy-only fixes need no engine change; behavior changes need a pinning test before and after.

1. **#16 Watson exception** — shield (copy) vs always-suspect industry (engine). Highest-value call on the list.
2. **#14 away autoplay** — recopy vs real lay-low selection. Note the away seat currently *out-earns* an in-table lay-low player (salary + $1 + no −2🔥 alternative reachable).
3. **#15 Scrub** — delete copy or restore node.
4. **#12 HORNSBY HEIGHTS** — add buzzword or change three copy spots.
5. **#13 Rumor Exchange** — drop venue language or add the venue.
6. **#11 collage sentence** — rewrite against live board.
7. **#17 monetary-policy charts** — amend copy or fix industry ids.
8. **Carried (unchanged):** cortisol-≤1-node silence (ledger #3), `separateNodes()` residual overlaps (ledger #4), MADE node tooltip "$3 + 1🔥" (395 vs `madePay`).

---

## Repro recipes (stdin drivers, run from repo root)

No repo files are needed. PowerShell, from `C:\Users\wato0\Github\bigcon`:

```powershell
@'<script>
'@ | node --input-type=module
```

### Driver 1 — away watchdog, character colours, Quikstop labels, buzzwords, global sell

```js
import { loadEngine, makeGame, pump } from 'file:///C:/Users/wato0/Github/bigcon/tests/helpers/harness.mjs';
const e = loadEngine();
await makeGame(e, 2);
const acc = e.acc, S = acc.S, QUIK = acc.QUIK_SLOTS;

// A. colour wiring (finding = MATCH row)
S.players.forEach((p,i)=>console.log('seat',i,p.char,p.color,'want',
  (acc.CHARS.find(c=>c.id===p.char)||{}).color));

// B. Quikstop label + truthful exhibit log (ledger #6 extension)
const ql = S.log.find(l=>l.indexOf('Quikstop opened')>=0);
console.log('label in log:', ql.indexOf(QUIK[S.quikSlot].label)>=0, '|', ql);
console.log('exhibits:', S.log[0]);

// C. advertised buzzwords (finding #12)
['NESA','JAKE TOMKINS','HORNSBY HEIGHTS'].forEach(w=>
  console.log(w,'in pool:',acc.BUZZWORDS.some(b=>b===w),'resolved:',e.f.matchBuzzword(w)));

// D. sell is global; CALM rate $2 (finding #13 rates half)
S.deck=[]; S.discard=['tapes'];
S.cur=0; S.phase='action';
const m0=S.players[0].money;
await e.f.applyIntent(0,{act:'sell',n:2}); await pump(6);
console.log('sell delta:',S.players[0].money-m0,'(expect +4)');

// E. watchdog site 1: onHostClose mid-turn (finding #14 exact +3)
const gi=1; S.cur=gi; S.phase='move'; S.steps=3; S.players[gi].dc=false;
const before=S.players[gi].money;
e.f.onHostClose(acc.Net.conns[gi]); await pump(4);
S.deck=[]; S.discard=['quiet'];
e.clock.advance(20000); await pump(6); e.clock.advance(50); await pump(4);
console.log('away mid-turn delta:',S.players[gi].money-before,'(expect 3 = 1 away + 2 quiet)');

// F. watchdog site 2: startTurn auto-pass (finding #14 exact +6, salary still paid)
const b2=S.players[gi].money;
S.deck=[]; S.discard=['quiet'];
S.cur=gi;
await e.f.startTurn(); await pump(8); e.clock.advance(50); await pump(4);
console.log('away turn-start delta:',S.players[gi].money-b2,'(expect 6 = 3 salary + 1 away + 2 quiet)');
e.dispose();
```

### Driver 2 — Watson inversion, PANIC rate, holder-present card sweep

```js
import { loadEngine, makeState, withRandomSeq, withSeedAsync, pump }
  from 'file:///C:/Users/wato0/Github/bigcon/tests/helpers/harness.mjs';
const e = loadEngine();

// Watson "exception" fires against its owner (finding #16)
const S = makeState(e,{players:[{money:100,intel:10},{money:100,intel:10}],
                       owner:{watson:0,coal:0,made:1}});
e.acc.S = S;
withRandomSeq([0.2],()=>e.f.acccInvestigate(0));
await pump(8);
console.log('P0 money',S.players[0].money,'(100−20) intel',S.players[0].intel,'(10−2)');
console.log('watson owner now:',S.owner.watson,'(expect 1 — divested)');
S.log.filter(l=>l.indexOf('MONOPOLY')>=0).forEach(l=>console.log('log:',l));

// PANIC sell rate $4 (rates MATCH for #13)
const S2 = makeState(e,{players:[{money:0,intel:5},{money:0,intel:5}]});
e.acc.S = S2; S2.mood='PANIC'; S2.phase='action';
await e.f.applyIntent(0,{act:'sell',n:3}); await pump(4); e.clock.advance(20); await pump(4);
console.log('PANIC sell:',S2.players[0].money,'(expect +12)');

// Holder-present card sweep: blank vs owned fabric, same seed (P2.4)
const NODES=e.acc.NODES, CARDS=e.acc.CARDS;
const snap=S=>({m0:S.players[0].money,m1:S.players[1].money,
  i0:S.players[0].intel,i1:S.players[1].intel,
  c0:S.players[0].cortisol,c1:S.players[1].cortisol,mo:S.mood,wire:String(S.wire).slice(0,20)});
for(const c of CARDS){
  const A=makeState(e,{players:[{money:0,intel:0},{money:0,intel:0}]}); e.acc.S=A;
  await withSeedAsync(7,async()=>{c.run()}); await pump(6); e.clock.advance(40); await pump(6);
  const sa=snap(A);
  const B=makeState(e,{players:[{money:0,intel:0},{money:0,intel:0}]});
  NODES.forEach((n,i)=>{B.owner[n.id]=i%2});
  e.acc.S=B;
  await withSeedAsync(7,async()=>{c.run()}); await pump(6); e.clock.advance(40); await pump(6);
  const sb=snap(B);
  console.log((JSON.stringify(sa)!==JSON.stringify(sb)?'SHIFT ':'same  ')+c.id);
}
e.dispose();
```

Both drivers were executed verbatim (modulo print formatting) during this audit; the outputs in the findings section are the actual engine responses.

**Harness gotcha (not engine drift):** in pure-state fixtures (`makeState` without a started game), `announceAll` does not record into `e.modalRec` (last entry came up `undefined` in drive P2.1); the log line 713 is the reliable announcement surface in that context. Fixture-only; the announcement body exists statically at 715–719.

## Pinning candidates (optional next step)

If the rule decisions confirm **copy-is-wrong** for #14 and #16, the natural pins are: (a) away-delta exactness (Driver 1 E/F, currently unpinned anywhere in `tests/` — DC-01..06 cover lifecycle, not the payout math), and (b) a Watson-owner inversion probe (Driver 2 probe 1) as an EC-08 companion. Both belong in `tests/economy.test.mjs` / `tests/multiplayer.test.mjs` conventions, driven through the shared harness.


## Follow-up implementation status (2026-10-17)

The maintainer decisions have now been applied on branch `fix/rules-copy-and-watson-exemption`; the numbered findings above preserve the original audit record.

- **#11 resolved:** help text now describes 70 live exhibits and no longer names removed Germany/Davos or Canada/vault pins.
- **#12 resolved:** all room-code examples use `LOW CORTISOL`, a real member of `BUZZWORDS`.
- **#13 resolved:** the help text, action title, and log describe selling Intel at the current market rate without implying a physical Rumor Exchange.
- **#14 deferred by maintainer:** disconnect/away-seat behavior is deliberately unchanged for now; the audit finding remains open.
- **#15 resolved:** removed the unreachable Scrub handler, both UI buttons, its dispatch case, and its help entry.
- **#16 resolved:** COAL is now a tracked industry (`coal`, `train`, `port`, `bhp`, `watson`); owning Mark Watson exempts that player's COAL holdings from ACCC monopoly investigations, without exempting other industries.
- **#17 resolved:** help text now explains that charts are exempt from the six type-based industries, while CASH-RATE and INFLATION count in MONETARY POLICY.
- **MADE tooltip resolved:** now describes the 15% cash cut for qualifying players and explicitly says no Cortisol is added.
- **Counts resolved:** board copy and source header now say 70 exhibits; event-deck header comment now says 24 cards.

These changes intentionally do not alter away-seat/disconnection behavior. Automated validation passed on the PR branch: 92 tests, 91 pass, 1 documented skip, 0 fail.
