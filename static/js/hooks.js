'use strict';
/*
 * hooks: the ONE injected interface between the game rules and everything
 * around them (browser UI, network, bots, timers).
 *
 * The rules engine (engine.js) and the modules under it (util, data, boards,
 * state) never touch `document`, `$()`, `toast()`, `modal()`, render functions,
 * the wire, `window` or global timers. Whatever the rules need from the outside
 * world, they ask for through `hooks`; whoever hosts the engine calls
 * `setHooks({...})` once with real implementations (app.js does this for the
 * browser, tests/helpers/harness.mjs does it with fakes and a virtual clock).
 * Every entry has a harmless default, so the engine also runs headless with
 * `setHooks` never called.
 *
 *   Host services (implemented by net.js in the browser)
 *     sync(now)              state changed: repaint and push it to the guests
 *     sysTo(pi, msg)         private system line for one seat (toast / wire)
 *     askPlayer(pi, opt)     private prompt -> Promise of the chosen value
 *     announceAll(title, html)   table-wide bulletin nobody waits on
 *     revealAll(title, html)     table-wide card; resolves once everyone saw it
 *     beginGame(pub)         initGame: deliver the opening state to every guest
 *   Presentation (implemented by ui.js)
 *     showGame()             initGame: leave the setup screen, show the board
 *     toast(msg)             transient notice on this screen
 *     modal(opt)             blocking dialog -> Promise of the chosen value
 *     render()               repaint this screen from state
 *     gameOver(name, char, scores)   rich-presence / outward notification
 *   Environment
 *     bots()                 the bot policy module ({takeTurn, answerPrompt,
 *                            resetForGame, lobbyLine, ...}) or null if absent
 *     botSeed()              fixed bot seed requested by the host page (0 = random)
 *     setTimeout(fn, ms) / clearTimeout(id)   timers; tests inject a virtual clock
 *
 * `hooks` is a single mutable object so modules always call the current
 * implementation (`hooks.sysTo(...)`), never a stale captured reference.
 */
export const hooks = {
  /* host services */
  sync() {},
  sysTo() {},
  askPlayer(pi, opt) { return Promise.resolve(opt && opt.def); },
  announceAll() {},
  revealAll() { return Promise.resolve(); },
  beginGame() {},
  /* presentation */
  showGame() {},
  toast() {},
  modal(opt) { return Promise.resolve(opt && opt.def); },
  render() {},
  gameOver() {},
  /* environment */
  bots() { return null; },
  botSeed() { return 0; },
  setTimeout(fn, ms) { return globalThis.setTimeout(fn, ms); },
  clearTimeout(id) { return globalThis.clearTimeout(id); },
};

export function setHooks(next) {
  for (const k of Object.keys(next || {})) {
    if (!(k in hooks)) throw new Error('setHooks: unknown hook "' + k + '"');
    if (typeof next[k] !== 'function') throw new Error('setHooks: hook "' + k + '" must be a function');
    hooks[k] = next[k];
  }
  return hooks;
}
