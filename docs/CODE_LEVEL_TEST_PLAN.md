# Big Con — Code-Level Test Plan

**Repository:** `waxmotson/bigcon`  
**Scope:** rules engine, game flow, multiplayer synchronisation, randomized board generation, and rules/help consistency.  
**Status:** implemented and green (2026-10-17). Sections CF/MP/DC/RM/EC/CR/RC of this plan are covered by dependency-free Node tests (92 tests: 91 pass, 1 documented skip, 0 fail, ~45 s). The Playwright E2E layer (3. Browser) is deferred, and DC-05 (host migration) is skipped because the feature does not exist. Run everything with `node --test 'tests/*.test.mjs'` (quote the glob).

## Goals

1. Detect regressions in core gameplay and win conditions.
2. Ensure the host remains authoritative and every client sees the same game state.
3. Make Cortisol, raids, economy, node abilities, and events deterministic enough to test.
4. Validate randomized boards for connectivity and reasonable access to valuable/scarce nodes.
5. Prevent the implementation, tooltips, event copy, and help panel from describing different rules.

## Current implementation considerations

The browser game currently keeps much of its logic in `index.html`. The test harness should avoid depending on the DOM wherever possible. Prefer extracting pure rule functions into a module, or expose a test-only adapter guarded from production use. Do not add test hooks that allow normal clients to mutate host state.

Relevant implementation areas include `applyIntent()`, `addCortisol()`, `raid()`, `madePay()`, `acccInvestigate()`, `generateRandomBoard()`, `rebuildAdj()`, `pubState()`, `adoptState()`, `sendAll()`, `sendTo()`, `askPlayer()`, `announceAll()`, and `revealAll()`. Names may change during refactoring; tests should target stable public rule APIs rather than line numbers.

## Execution status & engine findings

**Implemented (all uncommitted at time of writing — review before any commit):**

- `tests/helpers/harness.mjs` — shared harness: loads the game scripts of `index.html` (the inline BUILD_COMMIT script plus the classic `<script src>` files under `static/js/`, in document order, joined; `static/bots.js` and the Discord module are excluded) into a `node:vm` context with a stubbed DOM, virtual clock, and fake PeerJS connections (recorded sends, auto-acked events, scripted answers, held modals). Seeded `makeGame` retries the seat shuffle (mulberry32) until the host seats at index 0.
- `tests/smoke-engine.test.mjs`, `tests/smoke.test.mjs`, `tests/rules-smoke.test.mjs` — pre-existing smoke layer.
- `tests/cortisol-raids.test.mjs` (CR) — 14 tests; `tests/economy.test.mjs` (EC) — 20 tests.
- `tests/game-flow.test.mjs` (CF) — 13 tests including the hostile-takeover pricing (CF-06b) and the in-flight action lock.
- `tests/multiplayer.test.mjs` (MP/DC) — 12 tests + DC-05 skipped.
- `tests/board-generation.test.mjs` (RM) — 200-seed generator sweep + initGame wire checks + `pubState`→`adoptState` round-trip.
- `tests/rules-consistency.test.mjs` (RC) — 22 tests: assets/copies on disk, deck completeness, every card's `run()` on a clean table, behaviour-driven action costs, cortisol constants, win types/goal clamp, dead-reference audit.
- `tests/geo-dlc.test.mjs` (GD) — 38 tests for the Geography DLC: world rebuild both ways, 82-pin generation sweeps, missile and Shahed launchers (including correct launch origin and Tuvalu backblast), ESG vulnerability and flat takeover pricing, rubble/rebuild, board-wide synergy spacing, Intel operations, Bondmageddon chart-leader targeting, beach day, tribute income, Qantas grounding, oil crash, Stage 5 decline, full-cycle Venice Overtourism, Tuvalu claim, lobby mirroring, copy pins.

**Engine findings recorded (no production code changed; each has a pinning test):**

1. **`revealAll()` ack-gate ordering race** — the guest-side ack gate is registered only after the announcement modal's await resolves, while `sendTo` fires the `event` message first; an instant ack is dropped. Real browsers mask this with network latency; the harness acks on a retry loop. (MP/CF layer)
2. **`applyIntent()` trusts the seat index** — `pi` comes from `Net.conns.indexOf(c)` with no bounds check against `S.players.length`. Unreachable with length-matched arrays, but a hardening candidate. (MP-05)
3. **Cortisol protection quirk** — with zero or one owned node, positive cortisol changes are silently ignored (reductions always apply). Marked *rule decision required*; pinned as current behaviour. (CR-01/02/02b)
4. **`separateNodes()` does not guarantee zero overlap** — residual node-box overlaps occur on ~46% of seeds (126 pair-overlaps across 200 seeds; worst observed 5 pairs in one seed), from wall clamping plus mutual pushes. Marked *rule decision required*; the test pins a per-seed envelope of 8. (RM sweep)
5. **Health of the generated graph is good** — connectivity from Quikstop holds on every seed; path depth median 5, p95 7, max 7 (loose max 12). (RM sweep)
6. **Copy drift (partially resolved in follow-up branch)** — the help copy and source header now say 70 exhibits and the event-deck header now says 24 cards; the three misspelt asset filenames (`oil price increease.png`, `whistelblower.png`, `us treasury yeild.png`) were renamed to `oil price increase.png`, `whistleblower.png`, `us treasury yield.png`, and RC-01 now asserts the old names are gone and unreferenced. RC-07 still reports dead references informationally.
7. **Dead references** — `S.owner.*`/`own()` references to the removed-node set (`econ`, `notes`, `real`, `spend`, `timeline`) survive in the source but are inert. The unreachable `scrub` action handler/UI was removed in the follow-up rules-copy branch. RC-07 guarantees no reference escapes validation entirely.
8. **Budget-night direction** — `payTo(i, amt, to)` means each rival *pays* the Treasurer $1; the copy ("the Treasurer collects") is accurate, but the transfer direction is easy to misread, so RC-03 pins it explicitly.
9. **Host migration is unimplemented (DC-05 skipped)** — disconnects fall back to the away-seat watchdog (20 s → seat auto-plays "lays low" + $1 Intel), and reclamation by playerId/displayed name restores the seat cleanly. Pinned by DC-01..DC-06.
10. **Testing note** — `deepStrictEqual` rejects structurally identical objects that originate in different `node:vm` realms (both engines create their own realm), so wire-equality assertions compare JSON serialisations — the same thing the real wire carries. (GD-12b hits this for `S.ov`.)
11. **`applyIntent()`'s synchronous prefix reaches the market event** — the intent branch runs synchronously into `finishNodeAbility → endOfTurn → card.run()`; a `quiet` deck therefore applies its +$2 (and its mood reset) *before* the intent promise yields, while the next seat's `startTurn` income lands in microtasks after. Behaviour tests pin immediate effects pre-await and chain results after `settle()` (GD layer; RC-03 tests post-await throughout, which is equivalent for its sums).
12. **Geo once-per-turn flags reset at every `startTurn`** — `geoMissiled/geoBeach/geoBoeing/geoCrash/geoStage5/geoVenice` are cleared at the top of `startTurn`, so after any action chain they read `false`. Same-turn "already used" gates are tested by restoring the flag manually (GD-06/GD-12) rather than racing the chain.

**Continuation:** the rules-copy vs gameplay-mechanics audit (2026-10-17) lives in **`docs/RULES_COPY_AUDIT.md`** — its findings are numbered **#11–#17**, continuing this ledger, in the form *copy (source, quote) → implementation (file:line) → driven behavior → verdict → rule decision*. It also extends item 6 (the initGame log tell the truth — "70 exhibits") and item 7 (full dead-ref call-site table), and corrects item 9: the away watchdog pays **$1 cash via `gain()`**, not "$1 Intel", and the seat is not lay-low (help copy drifts from both watchdog sites; see audit finding #14).

## Test strategy

Use three layers:

- **Unit tests:** pure rule functions with seeded randomness and a small fixture state.
- **Integration tests:** a host plus simulated client connections, fake timers, and deterministic prompt responses.
- **Browser/end-to-end tests:** real browser contexts for lobby, UI, disconnect/reconnect, and cross-client behaviour.

Recommended tooling, subject to repository setup: Vitest or Node's built-in test runner for extracted pure logic; Playwright for browser tests. If adding dependencies is undesirable, start with a dependency-free Node test harness and add Playwright as a separate optional CI job.

### Determinism and fixtures

- Inject or stub the random-number source for board generation, event draws, and random outcomes.
- Use fake timers for heartbeat, prompt timeouts, lock watchdogs, and reconnect windows.
- Build a canonical fixture with 2, 4, and 8 players, unique player IDs, known node owners, known adjacency, fixed money/Intel/Cortisol, and a known event deck.
- Compare deep state snapshots after each action. Ignore presentation-only fields such as animation timers.
- Every test should assert both the state change and the relevant log/event output where applicable.
- Keep a regression test for every confirmed production bug.

## 1. Core game flow

### CF-01 — Start a solo test game
**Setup:** one player; lobby's solo-test option enabled.  
**Steps:** create lobby, start game, complete a turn, reset/restart.  
**Assertions:** game starts without a remote connection; active player and phase are valid; no connection-index access crashes; reset clears old state, timers, prompts, and locks.

### CF-02 — Start a normal multiplayer game
**Setup:** 2 and 4 connected clients.  
**Steps:** start lobby and inspect all clients.  
**Assertions:** one host; each seat has one unique player identity; all clients agree on player order, turn, phase, board layout, and ownership.

### CF-03 — Legal movement
**Setup:** current player has steps and an adjacent destination.  
**Steps:** submit a legal move.  
**Assertions:** position updates once; step count decrements exactly once; host and clients converge to the same state.

### CF-04 — Illegal movement and stale actions
**Steps:** attempt a non-adjacent destination, move with zero steps, move during the wrong phase, and submit an action for a non-current player.  
**Assertions:** no state mutation; action receives a useful rejection; lock is released; subsequent legal action still succeeds.

### CF-05 — Seize an available node
**Setup:** player at an unowned node in action phase with sufficient funds.  
**Steps:** seize node.  
**Assertions:** ownership changes to the actor; funds change by the displayed price and modifiers; seizure effects run once; node is no longer available to another player.

### CF-06 — Seizure failure cases
**Steps:** insufficient money, already-owned node, wrong phase, invalid node ID, and duplicate request.  
**Assertions:** no negative or duplicated charge; no ownership overwrite; no uncaught exception; action lock always recovers.

### CF-07 — Finish a turn and collect income
**Steps:** finish movement/action, advance to next player, then complete the next round.  
**Assertions:** each player gets exactly one turn; passive income runs once per eligible turn; round, current player, phase, and steps remain consistent across clients.

### CF-08 — Event draw and resolution
**Setup:** fixed deck containing a harmless event and a choice-based event.  
**Assertions:** exactly one card is consumed; effects apply once; choice recipient is correct; cancellation/timeout follows the documented default; no stale prompt remains.

### CF-09 — Win condition
**Setup:** state one step short of victory.  
**Steps:** satisfy the final missing requirement.  
**Assertions:** game ends once, correct winner is announced to all clients, further intents are rejected, and the end state survives reconnect.

## 2. Multiplayer ordering and identity

Run the following suite with **2, 4, and 8 players**, using at least 100 seeded seat shuffles per player count.

### MP-01 — Identity remains bound to the right connection
Assert that every player index/ID maps to the intended connection after shuffling. Never assume the host is at connection index zero unless the architecture explicitly guarantees and enforces it.

### MP-02 — Broadcast reaches all and only connected peers
Send state, chat, event, and system messages. Verify host is not sent a duplicate copy of its own broadcast and each connected peer receives one copy.

### MP-03 — Private message isolation
Send a private prompt/system message to one player. Assert that no other client receives the prompt contents or response.

### MP-04 — State convergence
After each action, compare normalized host and client state: player IDs, turn, phase, positions, steps, money, Intel, Cortisol, ownership, bugs, market mood, event state, and victory state.

### MP-05 — Reordered and duplicated messages
Deliver duplicate and delayed intents/state messages. Assert actions are idempotent where required, stale actions are rejected, and clients do not roll back to an older state.

### MP-06 — Invalid client input
Send unknown action names, missing fields, invalid player targets, invalid node IDs, negative values, and malformed payloads. Assert host validation rejects them without crashing or changing state.

## 3. Disconnect and reconnect

### DC-01 — Disconnect during movement
Disconnect the active player between a movement intent and its resolution. Verify whether the action finishes or rolls back according to the chosen policy; it must not run twice. Reconnect and confirm position, steps, turn, and phase.

### DC-02 — Disconnect during a private choice
Disconnect the prompt recipient while `askPlayer()` is pending. Verify the documented timeout/default is applied once, pending prompt state is cleaned up, and the game advances.

### DC-03 — Reconnect before prompt timeout
Reconnect with the same identity before timeout. Verify prompt ownership and response routing; a response from an old connection must not resolve the prompt twice.

### DC-04 — Disconnect during non-blocking event announcement
Disconnect a client after the host sends an event announcement. Verify event effects do not depend on the client's modal being dismissed; reconnecting client receives current state and does not replay effects.

### DC-05 — Host disconnect
If host migration is unsupported, show a clear terminal/disconnected state rather than allowing guests to submit actions that appear to succeed. If supported, test migration explicitly.

### DC-06 — Timer and lock cleanup
After disconnect, reconnect, timeout, and reset, assert no orphaned timers, unresolved promises, stale acknowledgement sets, or permanently held action locks remain.

## 4. Cortisol and raids

The current `addCortisol()` implementation includes a guard that ignores positive changes when the player owns one or fewer nodes. Treat that as a rule requiring an explicit decision, not an assumed intended behaviour.

### CR-01 — Positive Cortisol with zero nodes
Apply +1 and +2. Assert behaviour matches the approved rule, remains within 0–9, and logs the actual applied amount.

### CR-02 — Positive Cortisol with one node
Repeat CR-01. Specifically assert whether the one-node protection applies; this test should fail if implementation and approved rules disagree.

### CR-03 — Positive Cortisol with multiple nodes
Apply +1, +2, and a large increment. Assert correct clamp at 9 and no off-by-one behaviour.

### CR-04 — Cortisol reductions
Apply negative changes at 0, 1, and higher values. Assert it never falls below zero and reduction is not blocked by a positive-change protection rule.

### CR-05 — Event modifiers
Test the Big Bessent / The Jim reduction and Herald Intel effect for event-sourced Cortisol. Assert modifiers apply only under their intended conditions and Intel is awarded at most once.

### CR-06 — Raid threshold
Test Cortisol values 7, 8, and 9 followed by +1, plus an increment that crosses the threshold. Assert exactly one raid occurs when the approved threshold is reached.

### CR-07 — Raid side effects
Assert the two highest-income owned nodes (with deterministic tie-breaking) are seized; bugs are removed; the fine is correct; Intel is reduced to 1 when applicable; Cortisol resets to 0; `raided` is set; and raid bonuses/event announcement occur once.

### CR-08 — Raid with zero or one owned node
Assert no crash and no duplicate seizure. Verify fine and account-penalty behaviour matches the rules when there are no nodes to seize.

### CR-09 — Recovery turn
On the raided player's next turn, verify no income and one movement step according to the stated rules; verify normal income and movement resume on the subsequent turn.

## 5. Economy and victory

### EC-01 — MADE payout
With MADE owned, run `madePay()`. Assert owner receives $10 and 1 Intel once. For each opponent, verify the 15% cash transfer only when they have more than two nodes and at least $50; assert rounding and payment bounds.

### EC-02 — MADE payout edge cases
Test no owner, owner with maximum relevant resources, opponents at $49/$50, opponents with 2/3 nodes, and zero-dollar rounded cuts. Ensure the node description, help text, logs, and implementation agree.

### EC-03 — Repeated Sisyphus pushes
Test the first several pushes with a deterministic state. Assert the payout sequence matches the approved design, the push has no unintended Cortisol cost, and the amount does not overflow numeric/state/UI limits. Add a long-run test to make exponential growth and any intended cap/reset explicit.

### EC-04 — Passive income and synergies
For each income component, test baseline salary, node income, chart modifiers, industry counts, pair synergies, market mood modifiers, and bug skims. Assert total equals the sum of eligible components and each modifier is applied exactly once.

### EC-05 — Income timing
Verify income is awarded at the intended point in the turn, not on game start, turn reset, reconnect, or duplicate state delivery. Verify raided players' skipped-income turn is respected.

### EC-06 — Victory predicate for every required type
Create a table-driven test with one fixture per each of the seven required node types. For each type, assert that one owned node satisfies only that type, that missing any one type blocks victory, and that acquiring the final missing type wins only when the cash threshold is also satisfied.

### EC-07 — Victory edge cases
Test exactly at and one unit below the cash threshold; node divestment/removal after near-victory; simultaneous apparent win conditions; and actions received after game over. Winner selection must be deterministic and documented.

### EC-08 — ACCC concentration
Test 0–2 and 3+ holdings for each configured industry, overlapping industry groups, the Mark Watson exception, and cases where there are fewer rivals than divested nodes. Assert each node is transferred at most once, remaining nodes return to market, and fines are calculated correctly.

## 6. Random map validation

Use seeded generation to make failures reproducible. Run at least **1,000 seeds** in CI if runtime permits; otherwise run 100 in PR CI and 1,000 nightly.

### RM-01 — Node and edge integrity
Every expected node appears exactly once; every edge references two distinct existing nodes; no duplicate undirected edges; no self-loops; coordinates and rotations are finite.

### RM-02 — Connectivity
Run BFS/DFS from every node. All intended playable nodes must be reachable from the starting node unless the rules explicitly allow isolated nodes.

### RM-03 — Adjacency consistency
Assert `rebuildAdj()` produces symmetric adjacency for undirected edges and that movement legality uses the same graph as rendering.

### RM-04 — Spacing and overlap
Check node bounding boxes or circles against minimum spacing. Account for the actual rendered node size and viewport scale; log seeds that produce overlaps or unreadable crossings.

### RM-05 — Path-length distribution
Record shortest-path distances from Quikstop to every node and summarize min/median/max and distribution by node category. Set acceptable thresholds based on playtest data, not arbitrary assumptions.

### RM-06 — Valuable-node placement
Measure access to each node in `HIGH_VALUE_NODE_IDS`. Confirm prized nodes are placed as intended and that assignment does not duplicate or omit positions.

### RM-07 — Scarce type availability
For every required victory type, verify at least one valid instance exists and is reachable. Check whether starting position and player order create systematic first-mover advantages.

### RM-08 — Layout/state round trip
Serialize a generated layout and edges, apply them on a guest, and compare node coordinates, rotations, and adjacency. Confirm a late join/reconnect sees the same board.

### RM-09 — Distribution fairness
Across many seeds, compare player start options and distance to valuable nodes. Report outliers and compare seat advantage by player index; do not require every random board to be identical.

## 7. Rules and UI consistency

Create a canonical rule registry for node abilities, event cards, costs, modifiers, and victory conditions. Where feasible, generate tooltips/help content from that registry rather than maintaining duplicated prose.

### RC-01 — Node inventory coverage
Enumerate every node in `NODES`. For each node, require a stable ID, display name, price/cost, income, ability definition (or explicit “no active ability”), and a corresponding help/tooltip entry where applicable.

### RC-02 — Event inventory coverage
Enumerate every event card/deck entry. Ensure its effect handler exists and its description explains trigger, target, cost, duration, and relevant edge cases.

### RC-03 — Cost and requirement consistency
Compare displayed action cost and requirements with host-side validation for seizure, movement abilities, Intel abilities, audits, leaks, divestment, and any other activated action.

### RC-04 — Cortisol and raid wording
Verify every reference to the raid threshold, Cortisol protection, raid effects, and recovery turn matches the approved constants and implementation.

### RC-05 — MADE and Sisyphus wording
Verify MADE eligibility, payout amount, Intel, opponent loss conditions, and frequency. Verify Sisyphus growth/reset/cost rules. These descriptions must be updated together with code changes.

### RC-06 — Victory copy
Check the help panel, in-game status, end screen, and any onboarding text all describe the same cash threshold and all seven required node types.

### RC-07 — Automated drift check
Prefer structured metadata tests over brittle string scraping. If the UI still embeds prose in HTML, add a temporary audit script that flags missing node IDs, missing event handlers, stale numeric thresholds, and conflicting duplicated rule strings for manual review.

## 8. Geography DLC (GD)

Twelve extra exhibits (`GEO_NODES`) behind a host-toggled lobby flag (`S.dlcGeo` / `Net.dlcGeo`). `rebuildWorld(geo)` swaps the node set, `WORLD_EDGES` unions `GEO_EDGES` when on, and the flag travels with every state payload (`pubState` serialises it; `adoptState` rebuilds the world before render). All behaviour lives in `tests/geo-dlc.test.mjs` and uses the `quiet` deck exactly like RC-03.

### GD-01 / GD-01b — World rebuild & node integrity
`rebuildWorld(false)` restores the classic 70-exhibit world (NMAP rebuilt, not accumulated; high-value set rebuilt); `rebuildWorld(true)` deals 82 with every `GEO_EDGES` pair present and every `GEO_HIGH_VALUE_IDS` pin seeded far out. Each GEO node is structurally complete with a shipped asset under `./static/GeographyDLC/`.

### GD-02 / GD-14 — The 82-pin board
`initGame` with the flag deals 82 connected pins on every probed seed (log tells the table the DLC is live, no rubble on a fresh world); a 30-seed generator sweep keeps the DLC board a valid collage (every geo pin plotted, no mutual overlaps, fully walkable).

### GD-03..GD-05 — MISSILE COMMAND
Strike ($4 + 1 Intel, once/turn): owned target ⇒ expropriated with NO payout; either way the pin becomes rubble (no income, nothing to seize). Guards: no self-strike, ESG does NOT shield holdings and the Pillars themselves are valid targets, rubble unstrikeable, no charge on refused launches. Rebuild on-site pays exact list price, returns the node UNOWNED, and the Pyongyang Hotel skims $2 kickbacks off every rebuild.

### GD-06..GD-09 — Passive incomes & the Boeing
Wonsan beach day: free −2 Cortisol, once/turn, on-site only. Pyongyang City: +$1 income per owned GEO node (and note the base-game westpac/REGULATOR pairing — the missile site is a regulator, GD-07 pins the interaction). The Corporate Boeing: SHUT DOWN QANTAS ($4, once/turn) grounds the jet through the current and next two turns — nobody flies it, its owner's Qantas income is $0 — and a Boeing owner cannot ground their own airline.

### GD-10..GD-11b — Crash & decline
Oil crash ($3, once/turn): PANIC mood (logged before the quiet card calms it), every player pays $2 per owned oil node, Pillars holders exempt (and the Pillars pin itself still pays its $1 income). The Pillars themselves remain valid missile targets and do not block Overtourism. Stage 5 (2 Intel, once/turn): the richest *other* player makes no income of any kind on their next turn; the call is consumed at their next `startTurn`; ESG-rich seats cannot be declined; a one-seat table has no call.

### GD-12..GD-12c — Venice
Gondola therapy: free −1 Cortisol on-site. Overtourism ($2, once/turn, *either/or* with the gondola): targets any rival-owned standing pin, including ESG holdings; applies +1 Cortisol on the target owner's next turn during one full table rotation, even when that target has already acted in the current rotation. It expires when the Venetian owner begins their next turn, and also clears if Venice changes hands or the target pin is removed. Rubble remains an invalid target.

### GD-13 — Tuvalu
THE JOIN IS FREE: the first arrival auto-claims (no action, no cost, no Cortisol) via `doMove` and `doFly`; later arrivals pay the ordinary toll; rubble is unclaimable.

### GD-15 / GD-16 — Lobby & copy
The checkbox is host-gated (guest flips are refused and mirrored); the welcome and lobby payloads carry `dlcGeo`; adopting a geo state rebuilds the guest world. Help copy: v1.12, "82 exhibits" on / "70 exhibits" off; the Shahed launcher is documented alongside MISSILE COMMAND.

### GD-17..GD-24 — Geography wave 2 (dual launchers, probe, reflection, blockade, Kim, map spacing, ASIC, projectiles)
- **GD-17** — either owned launcher (MISSILE COMMAND or SHAHED DRONE) arms on-site; owning KIM JONG UN permits either to fire from anywhere. A player cannot own both launchers. Projectile origin and Tuvalu backblast use the actual launcher held, not a hard-coded silo coordinate.
- **GD-18** — striking a REGULATOR schedules `S.missileProbe={by}` at the strike; it resolves on the striker's NEXT `startTurn` BEFORE the caution flag is read, so a 50% indictment runs the full `raid(striker)` and its caution bites that same turn (the `p.raided=0` reset at the end of startTurn wipes the flag, by design). Either verdict adds +1 Cortisol via a direct set (bypasses `addCortisol`'s ≤1-node guard). Seeded via `makeRng`/`withSeedAsync`.
- **GD-19** — a warhead at TUVALU reflects: Tuvalu never burns, the actual launcher used (MISSILE COMMAND or SHAHED DRONE) is expropriated to rubble (custom backblast log), and the warhead lands on a random launcher-owner pin (pool excludes rubble, the launcher, and Tuvalu; empty if no other holdings remain). Reflected strikes use `strikeNode(...,{silent:true})` — no probe cascade.
- **GD-20** — BLOCKADE (Albanese, base-game, not DLC-gated): free, once per player-turn, action phase only, consumes the turn; expiry `S.blockades[id]=S.turn+S.players.length` while `blockades[id]>S.turn` = exactly one rotation; blocks walkers, the jet and the owner; income and missiles unaffected; rubble and already-walled pins refused. A walled Tuvalu cannot be free-claimed.
- **GD-21** — KIM JONG UN: WILD, income 0, $6, `nk_kimjongun.png` on disk; +1 Intel at each startTurn ("the Supreme Leader briefs you"), Toktimer-style; remotely arms either missile launcher.
- **GD-22** — strategic and Cortisol-relief nodes are distributed across the map with max-min placement; the old fixed Pyongyang ring is removed. Verify across 12 seeds that the high-value set (including Venice, both launchers, Kim, Wonsan, Pyongyang City, Stage 5 and base-game relief nodes) is not clustered; max-min selection uses a widened outer-board candidate pool, preserving the prized-ring bias while spreading the synergy nodes.
- **GD-23** — MONETARY POLICY concentration (charts counted) is policed by ASIC as MARKET MANIPULATION: the card carries `./static/asic.png` and the ASIC titles; mechanics unchanged (33% gate, 20% cash+Intel fines, divestment). Other industries keep the ACCC face.
- **GD-24** — projectile fx: `projFx(kind,fromId,toId)` emits `{id,proj:1,img,base,w,h,x0,y0,x1,y1,x,y}` riding `S.fx`/`pubState`; `projRig` returns `rotate(θ+base)` rightward and `scale(-1,1) rotate(atan2(dy,−dx)+base)` leftward (missile base +45°, jet base +10°); same-pin launches emit nothing; the 40-entry fx cap holds.

### GD-26..GD-29 — Intel operations and Bondmageddon
- **GD-26** — Sell ALL Intel converts the entire current Intel balance at the current mood's market rate in one action.
- **GD-27** — CORTISOL OVERLOAD costs 30 Intel and adds +6 Cortisol to one selected rival. It bypasses the ordinary one-node Cortisol immunity, still respects the 9-point cap, and can trigger the normal raid at 9.
- **GD-28** — BONDMAGEDDON is available to the Bond Desk owner once per turn; it costs $16 + 4 Intel and selects a rival with the most CHART nodes (random among ties). Four missiles target random intact holdings. If the target owns the ESG Pillars, three launches are directed at the Pillars and the fourth at another random intact holding.
- **GD-29** — ESG Pillars are a flat-price hostile takeover (flatSeize): takeover count never inflates the price above the calculated list price. The Pillars themselves remain missile-vulnerable and do not protect against Overtourism; their Oil Crash and Stage 5 protections remain.

### GD-25 — Geography wave 3 (the flight plays before the popup)
- **GD-25** — every projectile launch holds the turn open for its flight: `projFx` now returns whether a flight actually launched, and the launch sites `sync()` the payload then `await projPause()` (`PROJ_PAUSE_MS=1300` — the 1.1s SMIL flight plus a beat) before the turn rolls into whatever covers the board next. Covered on three paths: a missile strike (the impact — expropriation, rubble, the REGULATOR probe — lands after the flight, then `endOfTurn`'s MARKET EVENT card follows), the Tuvalu reflection (the warhead flies out to the island, then the reflected warhead gets its own flight home before the silent strike and the event card), and the Qantas jet (the phase holds at `move` until the jet lands, then `endMovement` opens the action phase). The pause lives in the host's turn flow only — guests receive the fx payload during the pause and the event bulletin after it, so the flight plays on every screen. Tests advance the virtual clock (`e.clock.advance(e.acc.PROJ_PAUSE_MS+100)`; Tuvalu advances twice, one per flight leg) — the GD suites that complete a strike or a flight all advance past the pause, and the mid-move Backroom leg keeps `S.phase==='move'` after it.

## 9. Bot seats (BT)

Host-local smart bots: roster entries `{bot:true, conn:null}` driven by `static/bots.js` (a Tier-2 deterministic planner — utility scoring over the public view, path lookahead, exact event-EV; no LLM, no network). Bots play through the same gates as human guests: every mutation is an `applyIntent` call, every private prompt is answered through `askPlayer`'s bot branch, and the only state they see is `botView()` — a redacted copy of the host state (no deck order, no log, no chat) plus derived helpers (`seizePrice`, `takePrice`, `flatSeize`, `missingTypes`, `nmap`). Deck knowledge comes only through bought peeks / the JTPortal briefing prompt.

- **BT-01** — an all-bot table finishes the con: the game reaches `S.over` inside the iteration budget, every recorded intent comes from a seated bot, the ledger shows real play (`seize`, `move`), no `sysTo` rejection ever targets a bot (Not-your-turn / red-threads / afford / Not-enough-Intel / unavailable / cannot / Walk-away), and no `[BIGCON] bot turn error` is logged.
- **BT-02** — determinism: with the same engine seed (host seat shuffle) and the same `window.__BIGCON_BOT_SEED__`, two full games produce identical final snapshots (per-seat xorshift streams are reseeded by `resetForGame` on every `initGame`; gameplay `Math.random` is seeded by the harness).
- **BT-03** — redaction: `botView` never carries `deck`, `log` or `chat` (planted secrets must not survive JSON round-trip), and the view contract the policy module compiles against is pinned field-by-field (`curSeat`, `nmap`, `edges`, `moodRate`, the price helpers, …).
- **BT-04** — lobby: `addBotSeat` seats a bot that self-picks a free face (start button unlocks), faces stay unique, `kickBotSeat` removes only bots, the table fills to `MAXPLAYERS` and refuses more, and the start gate tracks readiness.
- **BT-05** — action-table coverage: every act in the engine's `applyIntent` vocabulary (the 43-entry `PLAYER_ACTS` list in the test) appears in the bot module's dispatch, except the two documented skips — `sweep` (the engine keys `S.bugs` by planter, so sweeping only ever deletes the sweeper's own income streams; nothing rationally plays it) and `cancel` (bots never strand a mode open).
- **BT-06a–e** — frozen-table rigs: a seeded game is booted, frozen (`S.over=true`), staged into an exact board state, and one `takeTurn` is hand-driven through the real `botView`/`botAPI`; a test instrument re-freezes the table the moment the staged act lands, so `endOfTurn` cannot wake the other seats and run a live game over the assertions. Each rig proves the staged effect on engine state: **a** a bug planted on the adjacent rival chart (paid in Intel), **b** a missile strike (rubble + no-payout expropriation, $4 + 1🛈, at the best-paying rival holding), **c** Overtourism from the Venice owner anchored at the one standing rival node, **d** a rebuild of the rubble the rich bot stands on (node returns unowned), **e** the 30-Intel overload pushing a staged rival onto the raid threshold (`addCortisol` clamps at 9 and `raid` sets `raided=1`).
- **BT-07** - banter: over a full game every chat line comes from a bot seat, lines are nonempty and ≤140 chars, and the volume runs about two lines per turn table-wide (each seat chats at rate `1.7 / max(2, players.length)` per turn after a ≥2-turn quiet gap, plus forced raid reactions), with the cap `turn × 2 + 8` keeping it honest across the whole game.
- **BT-08** — spectator host: `toggleSpectate` converts the host's own roster row in place into a bot (named like a bot, keeping the host face it was given; name/playerId/face kept aside in `spectated`), the row is not kickable (`kickBotSeat` refuses index 0 — take the seat back with the toggle instead), the start gate unlocks with a face on every row and the button announces the ALL-BOT TABLE, and the real `btnStart` path starts a game where every seated player is a bot that plays to a winner. While spectating, `sysTo` never toasts the host's own bot seat — no "YOUR TURN" flash ever reaches the spectator.
- **BT-09** — per-character strategies: every character id in the roster has a `STRATEGIES` profile shaped right (label, node list, type list, positive temperament knobs), the flavour matches the face (mark watson pursues coal and keeps his own face; bessock goes for the RBA and collects REGULATORS; the tariff man buys the megaphone and is angrier than the central banker; tomkins chases raw cash; the sniper does not fear the raid threshold), `strategyOf` resolves a seated face through a live view and unknown faces fall back to the all-rounder, and `setVariant` rescales every profile and restores baseline cleanly.
- **BT-10** - variants stay solvable: a two-bot table run under the non-baseline `turtle` variant still reaches a winner through the same deterministic drive loop.
- **BT-11** - the payout keeps the table: after a real game reaches `over`, no timer reloads anyone (`location.reloadCount === 0`), no seat receives `{t:'reload'}`, `Net.started` stays true, the roster and every open connection survive; the host's rendered sidebar shows the BACK TO THE LOBBY button; `backToLobby()` disarms the room (`Net.started/begun=false`, `S=null`), sends each open seat its own roster row in a `{t:'tolobby', idx}` message, and the rematch dealt from the re-armed lobby also plays to a winner.
- **BT-12** - a guest receiving `{t:'tolobby', idx}` drops out of game mode (`Net.begun=false`), adopts the told roster row as its seat index, sees the lobby view with the game screen hidden, and is not shown the host's START button.
- **BT-13** - all-bot quiet: a full all-bot game records `🎴 EVENT —` lines and advances turns (the events really run) but queues **zero** MARKET EVENT modals — the human watching the table is never asked to click through the deck.
- **BT-14** - mid-game join as a player: a fresh connection mid-con gets the host's `midjoin` handshake (not the door), picks PLAYER, is shown only the untaken faces, and is dealt in at Quikstop with the standard $15 + 2 Intel (`pos:'quik'`, `visited.quik`, `dc:false`); the roster row carries face and connection, the joiner is welcomed with the full live state, the record announces the join, and the new seat participates in the rotation to the payout.
- **BT-15** - mid-game join as a spectator: the choice is theirs, no seat is created (`S.players.length` unchanged), the roster row rides past the seated table (`spect:true`, faceless), the welcome carries the `spect` flag with live state; the rail receives state broadcasts and table-wide bulletins; a spectator chat lands under `👁 <name>` (never through a seated `pname()`); and at the walk-back the spect flag clears so they owe the lobby a face like any guest.
- **BT-16** - the guest client wears the flag: a `welcome` with `spect:true` sets `Net.spect` and the roster row; `{t:'tolobby'}` clears it for the next con.
- **BT-17** - a hot bot cools: over a synthetic `botView` handed straight to `takeTurn`, a seat at cortisol 8 facing a raid-push leak against a steaming rival still opens with `laylow` `cool` (the caution turn after a raid costs more than any scheme); the same cold seat with no plays banks the lay-low `cash`. (Unit rig — see the `fakeView`/`botDecides` helpers.)
- **BT-18** - humans over bots: with two equally booked rivals steaming at cortisol 6 and only one a human seat, every leak goes to the human — tested with the human at seat 1 and at seat 2 (`botView` rows carry the `bot` flag, so the bias is table-visible info).
- **BT-19** - the win set bends acquisition: the final missing set piece is seized even at a steep list price where a duplicate-type node is walked away from (lay-low cash); a node that is a near-complete rival's LAST missing type is denied at a takeover price income math would refuse; the same node useless to them is not bid up.
- **BT-20** - lobby chatter: the policy exports `lobbyLine(id)`; every face returns short in-voice lines that rotate (not one broken record); `addBotSeat` introduces the bot in lobby chat under its roster name; `broadcastLobby`'s ambient chatter is rate-limited (one line per 20 s gate, host realm only), and the lobby schedules its own self-rescheduling 20 s clock so the room murmurs without anyone clicking.
- **BT-21** - the office sweep is real counter-intelligence: a rival bug planted on the sweeper's own node is removed (the rules copy's "remove every bug on your nodes"), the sweeper's own skim on a node they no longer hold is closed too, and the sweep still costs 2 Intel. Engine-level rule fix.
- **BT-22** - a bugged bot responds: over the synthetic `botView` rig, a rival bug on the bot's own node makes `sweep` the first intent (the skim is worth a turn), instead of ignoring it forever.
- **BT-23** - human targeting is threat-scaled, not flat: with two human seats steaming at cortisol 6, the leak goes to the human nearest the bank ($95) rather than the broke human ($10) — the bias no longer bullies a losing human over a bot about to win.
- **BT-24** - cross-turn memory: over two `takeTurn` calls on the same bot (no re-seed), a node that was the bot's on turn 1 and is a rival's on turn 2 is attributed as a takeover, and every leak on the next turn goes to that rival. ACCC divestment (several nodes moving at once) is deliberately not attributed.
- **BT-25** - production pacing is covered: a realm without `__BIGCON_TEST__` sets `BigConBots.paceMs = 150`, the test realm runs at 0. The pacing/throttle path is no longer untested code.
- **BT-26** - the valuation weights stay in a sane band: the policy exports its `weights` table and a range guard checks every term is positive and finite, `incomeTurns` looks like a game length (10–60), the set bonus is meaningful but below the income economy, and the raid wall still deters. Ranges, not exact values, so re-tuning stays free but a decimal slip or a zeroed knob fails loudly.
- **SIM** - the race harness (`tests/sim-races.mjs`, not a node:test file) replays identical seeded all-bot games under each variant and reports per-character win rates: the 160-game four-variant campaign finished **40/40 with zero stalls in every variant**, and the winning temperament (affinity, folded into the shipped baseline) averaged **48.1 turns per game**. The post-chat-rework confirm race (the chat changes consume bot-stream randomness, so the final shipped numbers are this run) again finished **40/40 with zero stalls — average 49.1 turns, 843 intents per game**, with the win spread DJT 40% / denialswan 40% / japsnchen 40% / thousandyardwax 25% / bessock 20% / tomkins 15% / thebigag 15% / markwatson 5% across four viable archetypes. The confirm race for the ACCC/cortisol/targeting/set-hunger batch: **40/40 finished, 0 stalls, average 29.4 turns, 509 intents per game** (faster games — set-hunger and denial bid up the win set; spread narrowed: thousandyardwax 60% / DJT 40% / bessock, denialswan, japsnchen 30% / tomkins 10%). The harness now also supports `--shuffle 1` (a seeded random roster per game instead of the sliding window, which only draws one table per offset — 8 compositions for a table of 4) and reports each character's average end-state money, node count and missing win types, so a rich loser can be told from a poor one and a stacker from a set-builder. The flaw-fix confirm race: **96/96 finished, 0 stalls, 26.8 turns average, 457 intents/game (faster — duplicate types no longer get the full affinity premium)**, spread tomkins 46.8% / bessock 37.2% / DJT 35.7% / japsnchen 23.9% / denialswan 18.5% / markwatson 16.7% / thousandyardwax 14.6% / thebigag 12.5% — the coal baron up from 6.3% and big ag up from 3.6% on the same seeds. A paired 20-game all-eight table reads 25/25/15/15/15/5/0/0, so four-seat gaps of a seat or two are inside the sampling noise; the reported numbers are one full run, not a best-of.

Engine integration notes: `Net.gameEpoch` (bumped by `initGame`) makes stale bot turn chains abort via a null `botAPI(epoch).viewOf`; `runBotTurn` yields on a 0ms timer at the turn boundary so an all-bot table cannot starve the event loop; bots whose module failed to load fall back to the away path in `startTurn`.

## CI gates and exit criteria

**Per pull request**
- All unit tests pass.
- Core flow, Cortisol/raid, MADE/Sisyphus, and victory regression tests pass.
- At least 100 seeded map generations pass integrity/connectivity checks.
- Static rule-inventory check reports no missing node/event handlers.
- Browser smoke test starts a game and completes a turn, if browser CI is available.

**Nightly / pre-release**
- 1,000+ seeded maps.
- 2/4/8-player multiplayer suite.
- Disconnect/reconnect and prompt-timeout suite.
- Longer economy simulation across multiple random seeds.
- Full browser suite in at least two browser contexts.

**Release blockers**
- Host/client state divergence after a completed action.
- Duplicate or skipped turn, event effect, payout, or raid.
- Unreachable required victory type.
- Victory predicate disagrees with documented rules.
- Private prompt contents delivered to the wrong client.
- A malformed action can crash the host or mutate an invalid target.
- Node/event rule descriptions contradict their actual implementation.

## Implementation order

1. Extract pure rules and define canonical test fixtures.
2. Add regression tests for Cortisol protection, ACCC/Watson, MADE, and Sisyphus.
3. Add core-flow and victory-predicate tests.
4. Add seeded random-map integrity and connectivity tests.
5. Add simulated host/client tests for ordering and prompt lifecycle.
6. Add Playwright end-to-end coverage and CI gates.
7. Use the rules registry to prevent future help-text drift.

**Important:** this is a plan, not a test-results report. Each assertion must be checked against an explicitly approved game rule where the current implementation and wording disagree.


### Follow-up rules-copy implementation

Branch `fix/rules-copy-and-watson-exemption` applies the maintainer's decisions from `docs/RULES_COPY_AUDIT.md`: Mark Watson now exempts the owner from COAL-industry ACCC investigations (COAL is tracked as its own industry); the MADE tooltip is corrected; unreachable Scrub UI/handler/help copy is removed; room-code, board-location, Rumor Exchange, chart-exemption and exhibit/card-count copy are corrected. Disconnection behavior remains intentionally unchanged. See the audit's follow-up status section for the item-by-item ledger. CI passed: 92 tests, 91 pass, 1 documented skip, 0 fail.

### Geography DLC implementation

Adds twelve Geography exhibits (including MISSILE COMMAND and the Iranian Shahed Drone) behind a host-toggled lobby flag that mirrors to every guest and rides with `pubState`/`adoptState`. Both missile launchers share the same $4 + 1 Intel strike and cannot be owned by the same player at once; Kim Jong Un arms either from anywhere. Missiles expropriate owned nodes with no payout and leave rebuildable rubble (rebuild = list price, returns unowned, Hotel skims $2); ESG has flat takeover pricing and can itself be missile-struck, while its owner still has the oil-crash and Stage 5 protections. Wonsan/La Serenissima sell Cortisol relief; Overtourism targets ESG too and lasts one full table rotation; the Boeing grounds Qantas for two turns; the South China Sea crashes oil; Stage 5 silences the richest seat's next income; Tuvalu joins the first arrival for free. High-value cortisol relief and strategic nodes use max-min spacing across the board. Intel adds Sell ALL, a 30-Intel +6 Cortisol overload, and Bondmageddon (four missiles at the rival with most charts; three hit ESG first if held). Version stamp v1.12 (82 exhibits on, 70 off; `BUILD_COMMIT` tracks HEAD). Full suite: **112 tests, 111 pass, 1 documented skip, 0 fail.**

### Bot seats implementation (2026-11-04)

Adds host-local smart bots (section **BT** above). `index.html` gains: the `bot` player flag in `initGame`; `Net.gameEpoch` + `resetForGame`; a bot branch in `askPlayer` (before both the host-modal and guest-wire paths); a bot branch in `startTurn` before the away path; the `botView`/`botAPI`/`runBotTurn` block; the lobby 🤖 ADD A BOT / ✕ kick controls with `addBotSeat`/`kickBotSeat`; and the `<script src="./static/bots.js">` tag. `static/bots.js` is a classic script exposing `window.BigConBots` (`resetForGame`/`takeTurn`/`answerPrompt`), with all randomness drawn from per-seat xorshift streams seeded in `resetForGame` (`window.__BIGCON_BOT_SEED__` override) and pacing zeroed by `window.__BIGCON_TEST__`. Prompt payloads for the JTPortal briefing, spy and terminal/interface peeks carry a `meta:{kind,card}` tag so the bot brain knows which private knowledge prompt it is answering. The harness (`tests/helpers/harness.mjs`) gained the `bots` option for `makeGame` and realm `URLSearchParams`/`location.hostname` stubs (upstream's Discord-activity gate otherwise breaks every test file). While landing the bots, the upstream GD-26 regression was fixed in-engine (undefined `most` → `targetCharts`, mirroring the author's unmerged `fix/bondmageddon-fog-of-war-actions` branch) and GD-26's test now arms `S.owner.leak` and queues the explicit target-picker answer.

Same-day completion pass (full action table + banter): the policy gained the five missing candidates — bug planting on adjacent rival holdings (skims $1–2/turn), the 30-Intel Cortisol Overload (bypasses the ≤1-node immunity; fires when it pushes the strongest rival onto the raid threshold), missile strikes (from the launcher the seat controls, never at Tuvalu, respecting the ESG shield), Overtourism from the Venice owner (per-victim cortisol EV × the table rotation), and rubble rebuilds (only with heavy spare cash, since the node returns unowned) — plus movement-positioning bonuses in `scoreStanding` (stand where a bug spot or a launcher shot opens up) and dispatch cases with post-mode drift guards (re-read the view after each `*mode` intent before the follow-up act). Chat: `botAPI` gains a host-validated `chat(seat, text)` faucet (only a bot seat can speak through it, 140-char cap, ordinary `addChat`), and the policy adds table banter from state-driven buckets (flavor / rich / broke / stress / taunt / raid) — at most one line per bot turn, ~7% of turns after a ≥4-turn quiet gap, plus a forced raid reaction (≥3-turn gap) and a 35% seize taunt on hostile takeovers. Probe: unseeded all-bot games terminate (52–102 turns base, 157–230 with the geo DLC) with zero engine rejections and zero bot errors; the geo games show overtour/bug/leak/spin/dossier all firing, and 49–60 bot-authored chat lines in voice. Tests extended to BT-05..BT-07.

Same-day spectator pass: `toggleSpectate` in the host lobby hands the host's OWN seat to a bot — the roster row stays at index 0 (the relay's seat) and just plays itself through the same bot policy, so a room can be started with every seat a bot and the host watching (and chatting) from the sidelines. The toggle remembers the host identity in `spectated` and hands the seat back on a second press; `kickBotSeat` refuses index 0; the start gate unlocks as soon as every row has a face (bots self-pick) and the button reads "START THE CON — ALL-BOT TABLE (N BOTS · YOU WATCH)"; face picking is refused while spectating; and `sysTo` suppresses the host's own bot-seat toasts so the spectator is never told it is their turn. Because `initGame` remaps the roster and `Net.myIdx = order.indexOf(0)` positionally, the shuffled seating keeps the spectator seat consistent. Tests extended to BT-08. Recorded as the **v1.13** stamp (title, turn-notification, board watermark, brand line, the turn-alerts storage key, and the mirrored `exhibits.html` header; GD-16's stamp pin now reads v1.13). Full suite: **147 tests, 146 pass, 1 documented skip, 0 fail.**

Same-day strategy pass — "the bots get stuck in a loop, and everyone plays alike":

**The loop was pacing, not deadlock.** The shipped pace was 650ms plus a random 0–650ms per intent — ~975ms average — over ~900–1,400 intents per game (18–23 minutes), and background-tab timer clamping stretched it toward an hour, so a casual observer saw bots shuffling forever. Fixes: pace dropped to 150ms+0–150ms (~225ms average, ~4-minute games) and `sleep` now measures its own overrun — a background tab that answers a 150ms timer a second (or a minute) late sets `B.throttle`, and throttled tables pay one pacing beat per turn instead of one per intent, so the con still ends when the tab is in the background. Engine-side turn-boundary yields are unchanged.

**Every face plays its own con.** A `STRATEGIES` table keyed by character id gives each of the twelve faces a profile: `nodes` (signature industries bought at a premium through `nodeOwnValue`), `types` (industries valued up), and the temperament knobs `aggr` (hostile-action multiplier), `risk` (own-cortisol fear divider via `fireOf`), and `cash` (pure cash plays — sisyphus pushes, intel sales). Mark Watson pursues the coal industry and keeps his own face; Bessock goes for the RBA and collects regulators; the tariff man buys the megaphone and is the angriest profile at the table; tomkins chases the boulder; the sniper does not fear the raid threshold. Unknown faces fall back to an all-rounder.

**Convergence pressure.** A game only ends when a seat holds cash ≥ goal AND the full seven-type set, so past turn 30 the whole table ramps hostility (+2%/turn), a rival inside the home stretch is hunted 1.7× harder, and a seat in its own home stretch chases raw cash over vanity buys (spending down delays the win; movement walks to the boulder). The turn-30 gate keeps staged micro-rigs and opening books deterministic.

**The simulation campaign.** `tests/sim-races.mjs` replays identical seeded all-bot tables under uniform variant overlays; four parallel subagents raced 40 games each (baseline / affinity / aggro / turtle): zero stalls in all 160 games; aggro proved slowest (67.6 turns — mutual destruction), turtle unbalanced the field (denialswan 55%, markwatson 0%), plain baseline let one face run away with it (DJT 50%). The winner — affinity (plan-first temperaments scaled 1.6×/1.45×) — is folded into the shipped baseline: **48.1 turns per game**, four archetypes viable (45/35/35/35/25/10/10/5), with markwatson's cash knob nudged from the follow-up race. Tests extended to BT-09/BT-10 plus the SIM ledger entry. Full suite: **149 tests, 148 pass, 1 documented skip, 0 fail.**

Same-day table-life pass — "the bots should say more random bs, the payout should not kick everyone out, and the leaderboard hover should show what each rival holds":

**Chattier banter.** The voluntary chat rate moved from ~7% of turns after a ≥4-turn quiet gap to `0.9 / max(2, players.length)` per seat per turn after a ≥2-turn gap — about one line per turn at a full table (~3.5× the old volume), still capped by BT-07's `turns + 8` assertion. Two mood-reactive buckets joined the policy (`panic` under a PANIC market, `hype` under FRENZY) plus a dedicated `bs` bucket of fourteen non-sequiturs ("cortisol is just spicy confidence", "thinking about the boulder again"…) that flavor lines become 45% of the time. The chat changes consume different randomness from the per-seat xorshift streams, so sim numbers shifted slightly — the confirm race above is the run the shipped numbers cite.

**The payout keeps the table.** `winCheck` no longer ends with `sendAll({t:'reload'})` + a host-side `location.reload()` — after the payout modal the game stays on screen, `S.over` set, with the full record and chat intact. A new host-only `backToLobby()` (requires `S.over`) disarms the room (`Net.started/begun=false`, `S=null`), walks every open guest connection back with `{t:'tolobby', idx:i}` (the roster sits in shuffled seating order after `initGame`, so each guest is told its own row for the YOU marker), then shows the lobby and broadcasts it; guests handle `tolobby` by dropping game mode and adopting the told row. `showLobby` now hides the game screen and removes `game-open`. Two UI fixes rode along: the GAME OVER phase card moved ABOVE the `!isTurn` STANDBY branch in `renderSide` (it was previously unreachable whenever the viewer was not the current seat — caught by BT-11), and the host's card carries a `🃏 BACK TO THE LOBBY` button (`data-act="tolobby"`, delegated beside rules/notifications before the `S.over` gate). LEAVE remains the only teardown in the game. CF-09 was rewritten from "the table reloads" to pin the new contract (no reload anywhere, room alive, roster intact).

**The syndicate hover card.** Holding the cursor over a rival row in the leaderboard shows a fixed-position card: name, color, cash, Intel and cortisol; HOLDS grouped by win type with the actual node names; and STILL NEEDS for every missing type (or FULL SET HELD). Rendered from live state on delegated `mouseover`/`mousemove`/`mouseout` — no polling, no per-row listeners.

Tests extended to BT-11/BT-12 (bots) and the CF-09 rewrite. Full suite: **151 tests, 150 pass, 1 documented skip, 0 fail.**

Same-day open-table pass — "at an all-bot table don't spam me with event popups, and let people join mid-game":

**All-bot tables run quiet.** `endOfTurn` now announces the market event card to the humans only when at least one seat is human (`!S.players.every(p=>p.bot)`) — at a table of only bots the event still runs, the log keeps `🎴 EVENT — …`, and the mood strip shows the swing, but nobody is asked to click a modal per turn. Raid and monopoly bulletins are untouched (they are the spectacle, not the spam); the payout reveal still shows.

**Mid-game joins.** The host no longer kicks a fresh connection during a game (`"Game already in progress"` is gone). The joiner gets a `midjoin` handshake and the choice is theirs, guest-side, through two new wire verbs (`joinmode`/`joinchar`) that the host re-validates at every step (cap, face, game still live — nothing is trusted from the wire):
- **New player** — picks a face from the untaken set and is dealt in exactly like a first turn: `$15`, `2 Intel`, standing at Quikstop (`pos:'quik'`, `visited:{quik:true}`). The player is appended to `S.players` and the roster row appended after the seated rows, so the invariant *roster row i == player index i (for i < players.length)* survives, turn rotation simply widens, and the record announces the join. The new seat plays from its next turn in the rotation.
- **Spectator** — a faceless roster row with `spect:true` appended past the seated table; `Net.spect` marks the guest client read-only. The spectator UI shows a SPECTATING phase card (the seated STANDBY is meaningless to them), the netstrip reads `👁 SPECTATOR` instead of a seat number, and the win-set card says "not playing — just watching" instead of a fake ✘ list. Spectators chat (under `👁 <name>` with a palette colour — `addChat` now tolerates rows past the table instead of crashing on `pname()`), receive state broadcasts and table-wide bulletins (`announceAll`/`revealAll` loops widened from `S.players.length` to `Net.conns.length`), and never receive private prompts. A spectator who drops is swept (dead faceless rows are not seat-holds) and may rejoin the rail; one reconnecting by player-id is re-welcomed to the rail rather than crashed on.

Spectator rows are converted back to normal face-picking lobby rows when the host walks the table back (`backToLobby` clears `spect`), so the start gate (`every row has a face`) treats an ex-spectator like any guest. A joiner whose choice lands after the game ends is seated on the rail (or, if the room already walked back to the lobby, folded in as a fresh lobby row via the extracted `joinLobby`). Help-panel copy gains the mid-join sentence. Tests extended to BT-13..BT-16; `driveToOver`'s iteration headroom raised to 24 000 (an all-bot rig once drew a 145+-turn game that exhausted the old 6 000-cap mid-flight — the loop shape is unchanged). Full suite: **155 tests, 154 pass, 1 documented skip, 0 fail.**

Same-day smarts pass — "the bots need to know about the ACCC, manage cortisol better, target humans, and talk more":

**ACCC awareness.** The bots now mirror the engine's `INDUSTRIES` table exactly: `botView` carries the industry groups as id lists (`industryIds`), and a new `acccExposure` helper counts holdings per group (>2 invites the 33% forced-divestment investigation). The old type-based approximation is gone (it matched the type-picked groups but miscounted the `ids`-picked ones — COAL, OIL, EDUCATION, JTPORTAL, both syndicates, MONETARY POLICY). Exposure bites quadratically: a third node in a group costs value, a fourth costs far more, so bots stop buying the fourth BANK before the fine does. The Mark Watson face's COAL exemption is modelled — a coal-concentrated seat that can take `watson` is paid for the shield. ACCC/ASIC fear also shows in chat (the taunt bucket already name-checked the ACCC).

**Cortisol management.** Bots were raiding into the caution turn and stalling. Now: cooling starts at cortisol 3 (was 4) and scales — ×1.6 at 5, ×3.2 at 7 — so a hot seat cools instead of scheming (BT-17 pins that a cortisol-8 seat declines even a raid-push leak to cool). Free self-care standing on owned cooling nodes (jog / Wonsan beach / Venice gondola / cook) is priced up ×1.4–1.5 and threshold-lowered, and `scoreStanding` pays bots to stand on their own cooling nodes earlier. Owning relief nodes (`gold` passive −2/turn, asics, rock, Wonsan, Venice) adds a fire-hazard premium to `nodeOwnValue` — fire extinguishers are worth more the hotter you run. A soft raid wall one step before the hard one: a hostile that would land the seat at cortisol 8 eats a `raidWall`-scaled penalty.

**Humans over bots.** `victimValue` prices a human seat over an equally juicy bot, and the new `bestVictim` picker drives leak/audit/roast/bondmageddon targets; Cortisol Overload adds +40 to human candidates; missile, bug and blockade picks weight the victim's share of the value up when the victim is human (BT-18). The `bot` flag rides on every `botView` row, so this is table-visible information — no redaction breach. (The flat ×1.35 + 6 was replaced the same day by a win-proximity-scaled bias — see the flaw-fix pass below.)

**Win-set hunger and denial.** A node of a still-missing win type now pays `setBonus` plus a proximity premium (+18 with three types missing, +42 with two or fewer) — the last pieces outrun income math. On hostile takes, denying a near-complete rival their missing type adds +34 (+70 when it is their LAST one) — blocking the bank outranks the income arithmetic (BT-19). Synergy and ability nodes keep their existing premiums, so a strong synergy can still beat base set progress; set hunger only removes the old blindness to it.

**Chatter.** Voluntary table-chat rate up from 0.9 to 1.7 lines per turn table-wide, and the `bs` share of flavor rolls up to 60%; BT-07's cap relaxed to `turn × 2 + 8`. New lobby chatter: per-character `LOBBY_LINES` (in-voice, in the same register as the table buckets) exported as `lobbyLine(id)` — a bot introduces itself when seated, and the host realm emits one ambient line per 20 s gate while the lobby is open (lobby is pre-game, so this is the one place bots may read `Math.random`; no game stream is touched). Without the policy module, `botLobbyLine` returns null and the lobby stays silent — same fallback contract as play.

Tests extended to BT-17..BT-20 (the latter three on a synthetic-view `takeTurn` rig). Confirm race (40 games, table 4, goal 100): **40/40, 0 stalls, avg 29.4 turns, 509 intents/game.** Full suite: **159 tests, 158 pass, 1 documented skip, 0 fail.**

Same-day flaw-fix pass — "implement all the remaining flaws" (sweep counter-intelligence, scaled human bias, memory/grudges, scaled action values, toll politics, ambient timer, pacing coverage, random seating, personality balance):

**Sweep is real counter-intelligence (engine rule fix).** `sweep` used to remove only bugs the sweeper had planted, so a rival's skim on your node ran forever and nobody could ever answer it. It now removes **every bug on nodes you own** (the rules copy's promise) and also closes your own skim on nodes you no longer hold; the log names how many were rival bugs. The bots gained a matching candidate: rival bugs on their own nodes are priced at `$20 × count` minus the Intel, so a bugged bot pays a turn to clean the office instead of ignoring it (BT-21 engine drive, BT-22 policy rig). Bug EV now prices the sweep risk it used to ignore — 9 turns × 0.55 survival against a bot victim, × 0.75 against a human — so planting no longer assumes an immortal skim.

**Cross-turn memory and grudges.** The wire attributes nothing, but ownership is visible: a node that was mine last turn and is a rival's now WAS taken by that rival. `updateMemory` records that single-node takeover as a grudge (ACCC divestment moves several nodes at once and is deliberately not attributed), decays grudges ×0.85 per own turn, and puts a rival who is one missing type from the win and past `goal × 0.5` on a `guard` (valued ×1.25 + 8). Grudges feed `victimValue` (+10 per strike) and a new `grudge` chat bucket (BT-24).

**Human bias scales with threat.** `victimValue` now prices a human at `val × (1.12 + 0.5 × progress) + 4 + 4 × progress`, where `progress = money / goal` — the table bullies the human who is about to bank, not the human who is broke (BT-23). The flags stay on every `botView` row, so it is still table-visible information.

**Action values scale with the board.** `masspanic` pays `(players − 1) × 6` (was a flat 18), `divestmade` pays `12 + projectIncome(victim)` when the victim is past the halfway mark (was 16/4), `pressure` and `blockade` pay `8 + 4 × homeStretch` and `12 + 4 × homeStretch`, so late-game disruption stays on the menu instead of being out-competed by the aggression ramp.

**Toll politics.** Movement already paid tolls as a cost; now each hop through a rival's node costs an extra 2.5 when that rival is inside the home stretch, so a bot walks around funding the seat about to win.

**Ambient lobby clock and random seating.** `startLobbyChatter` is a self-rescheduling 20 s `setTimeout` chain (cleared implicitly when the con starts or the host leaves), so the lobby murmurs without anyone clicking; `broadcastLobby` still nudges it inline. `addBotSeat` now picks a random free face instead of always the first, so tables are not always the same four faces in roster order.

**Personality balance.** End-state telemetry showed the weak archetypes held the MOST nodes but the FEWEST distinct types: loved-node affinity multiplied the whole income value, and because COMMODITY nodes carry the highest incomes (oil 8/12), the coal baron and big ag over-paid for duplicate holdings and lost the $100 race. The affinity premium is now damped for a duplicate type (`1 + (boost − 1) × 0.35`, plus −8) so it rewards ENTERING an industry, not stacking it. (An experiment giving big ag CORPORATE alongside COMMODITY was measured and reverted — it put three of the eight faces on the scarce CORPORATE nodes and widened the spread.) The harness gained `--shuffle 1` (seeded random roster per game; the sliding window only ever drew 8 table compositions at a table of 4) and end-state columns (avg money / nodes / missing types). Flaw-fix confirm race: **96/96 finished, 0 stalls, avg 26.8 turns, 457 intents/game** (games got faster as over-buying fell), spread tomkins 46.8% / bessock 37.2% / DJT 35.7% / japsnchen 23.9% / denialswan 18.5% / markwatson 16.7% / thousandyardwax 14.6% / thebigag 12.5% — the coal baron climbed from 6.3% to 16.7% and big ag from 3.6% to 12.5% on the same seeds, and no face is stranded in single digits. A paired 20-game all-eight table reads 25/25/15/15/15/5/0/0, i.e. much of the four-seat spread is composition noise at ~48 games per face (≈6% standard error), so the run is reported rather than over-tuned. A decay guard (BT-26) exports the weight table and asserts sane ranges so a future decimal slip cannot silently wreck the policy. Production pacing is now pinned too: BT-25 asserts 150 ms in a real realm and 0 in the test realm.

Tests extended to BT-21..BT-26. Full suite: **165 tests, 164 pass, 1 documented skip, 0 fail.**

### Bot race and valuation pass (2026-11-05)

A review of `static/bots.js` found several behaviours that were written but could never run, and tests that passed anyway.

**Features that were dead.** Grudges truncated with `| 0` on read and write, so none of about 51,000 sampled readings ever took effect (BT-24 only passed because the tie went to the seat it expected). Set denial looked for a node of a type its owner was missing, which cannot exist (BT-19 staged that impossible board). Guard duty skipped a rival already holding the full set. The turn-30 gate meant late-game pressure never started in 64% of games.

**The win race.** "Who is winning" is now `raceOf`, an estimate in rounds: the slower of banking the goal and walking to the missing types. It replaces `progressTowardWin`, which read cash alone and fixed dollar margins, and works at any goal. `leaderSeat` sees one-node seats; `strongestSeat` stays the attackable subset. The income horizon (`horizon`) follows the fastest seat and scales with the goal.

**Valuation.** `bookIncome` prices any hypothetical book, so a node's worth is income with it minus income without it, in both buying orders and for nodes already held (BT-29 pins it to the engine's `income()`). Also corrected: MADE's 15% (only rivals of an actual owner pay), ACCC (the single most concentrated group, the whole book plus 20% fines, charged only for what the node changes), raids (what they would actually take), blockades (only what they stop a rival walking to), sweeps (net of the deciding seat's own live bugs) and one Intel price throughout.

**Scaffolding.** Pacing and banter draw from their own streams, so they cannot shift a decision. A prompt now carries out the action that raised it instead of deciding again, which ended spin turns burning all ten loop iterations. A refused action is struck for the turn. **Engine fix:** `askPlayer` checked the host's seat before the bot branch, so a spectating host received their bot's private prompts as popups (BT-38).

**The stall this exposed.** Pricing MADE honestly made it outrank everything: in one 2-seat game, 297 of 298 takeovers were MADE, with both seats at $850 and no set. Two general rules fixed it: a node that keeps swapping is discounted (`B.churn`), and a seat whose cash is covered prefers set pieces to income. Set-break bids are reserved for a whole set with the cash in sight.

**High goals exposed two more problems.** At $400 and 8 seats these changes took the median game from 70 rounds to 251, and the longest to 1,965:

- **The boulder.** A push was priced at its full payout, which doubles without limit, so seats parked on it with up to about $600 quadrillion and no set. A push is now worth only the cash the seat still needs (`pushWorth`).
- **MADE (rule change).** MADE rolled 33% on every seat's turn, so 8 seats saw 2.7 payouts a round, taking about 30% of each eligible seat's cash a round. Bots now keep MADE owned, which exposed this. `madeChance()` is now `(2/3) / seats`, so every table gets 2/3 of a payout a round: 33% at 2 seats (unchanged), 22% at 3, 17% at 4, 13% at 5, 11% at 6, 10% at 7, 8% at 8. Cash, Intel, the 15% cut and its eligibility are unchanged. This applies to tables with humans too. A rate of 4/3 a round was raced first and left 6-seat $400 games at a median of 284.

All-bot races, `--shuffle`-style rosters, no DLC. "Before" is the previous commit's bots and rules. "After" is the final code, with a 500-round limit (400 for 8 seats at $400):

| Table, goal | Games after | Average rounds before → after | Longest before → after |
| --- | --- | --- | --- |
| 2 seats, $100 | 30 | 26.6 → 13.0 | 44 → 21 |
| 4 seats, $100 | 40 | 27.8 → 17.6 | 54 → 26 |
| 8 seats, $100 | 25 | 28.9 → 24.8 | 47 → 56 |
| 4 seats, $300 | 25 | 54.4 → 54.1 | 98 → 101 |
| 2 seats, $400 | 30 | not raced → 36.9 | not raced → 55 |
| 4 seats, $400 | 40 | 75.8 → 81.3 | 132 → 183 |
| 8 seats, $400 | 12 | 71.8 → at least 138.1 | 110 → hit the 400 limit |

**$100 games are shorter at 2 and 4 seats**, because bots finish their sets sooner. That is a pacing change for tables with humans, and it has not been tested against human play. **8-seat $400 games are still a known regression:** the median is 110 rounds against 70 before, and 1 of 12 games hit the 400-round limit. Samples are small and games are not reproducible run to run, because the engine's dice are unseeded once a game is under way. Seizures remain the bulk of seat-turns. Tests extended to BT-27..BT-42. BT-06c's victim now starts inside the Overtourism race gate. Full suite: **184 tests, 183 pass, 1 documented skip, 0 fail.**

### Full game record (2026-11-05)

The record was capped at 250 lines on the host and on guests, and a guest that missed too many lines kept only the latest 40. The host now keeps every line. A join or reconnect carries the newest 250, and a guest fetches anything older in `logpart` messages of about 60,000 characters, because the relay closes a socket on a message over 256,000. The live panel draws 250 lines during play and the whole record at game over. COPY and REVIEW always use everything the seat holds. LOG-01..LOG-07 cover this. Not checked in a real browser or over the real relay. REVIEW hands over through localStorage, so a very large record can fail there and fall back to COPY.

### Log reviewer (2026-11-05)

Adds logs.html: a standalone, dependency-free reviewer for a finished game record. Paste the record, open a .txt/.log, drag a file in, or use the new REVIEW button on the table record panel (it hands the record and the seat palette to the viewer through igcon-record-pending). The viewer detects players from turn headers (with a high-confidence verb fallback for headerless excerpts), colours every name, tags lines into twelve overlapping event buckets, groups the record into turn blocks, and supports player/category filters, plain or regex search with match navigation, turn jumps, line numbers, compact/wrap toggles, copy/download of the visible view, and a compressed #r= share link that keeps the whole record in the URL fragment. Nothing is uploaded.

	ests/logs-viewer.test.mjs pins the standalone document, every inline script, player/turn/event parsing, longest-first boundary-safe name matching, the headerless fallback, and the split between Wins and Setup & seating for the win-condition line. Full suite: **168 tests, 167 pass, 1 documented skip, 0 fail.**

### Ring map spacing (2026-11-06)

Ringworld used three fixed ellipses and spaced its nodes by equal angle. At the shipped roster (69 exhibits, 81 with Geography) each track held 23-27 images, and equal angle bunched them where the ellipse bends tightest, so most neighbours overlapped: the measured worst pair was -92.5px of image clearance. The tracks are now sized from the roster the same way Mega Ring is: each track must carry its share at a 202px pitch (170px maximum image width plus 32px clear space), all three tracks scale together so the gaps between them survive, and the canvas grows to fit the outer track. Nodes are placed by arc length rather than angle, with half-slot and 0.65-slot offsets keeping the rings staggered. Base ringworld now measures 4600x3100 with a 36.1px worst-case gap; Geography measures 5200x3500 with 34.3px. The old fixed scribbles and arrows are replaced on this layout by three dashed track guides and a RINGWORLD header, matching Mega Ring. RM-10 now reads the metrics, and RM-12 checks every node pair (not just edge neighbours) for a 24px gap, plus the auto-fitted viewport. Not checked in a real browser.
