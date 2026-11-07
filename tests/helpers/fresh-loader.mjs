/*
 * Node module-loader hooks used only by the test harness (registered from
 * harness.mjs). They give every `loadEngine()` call its OWN copy of the whole
 * game module graph, and per-engine "environment" globals, without touching
 * production code:
 *
 *   resolve  an import made from a module URL carrying `?gen=N` resolves to the
 *            same file with `?gen=N` — so one `import('…/app.js?gen=7')` pulls in a
 *            private, fresh instance of every module it reaches (S, Net, NODES,
 *            timers and all), exactly like the old one-vm-context-per-engine.
 *   load     prepends a one-line preamble to those modules that shadows the
 *            browser globals (document, window, location, timers, console, …) with
 *            the engine's stub objects from `globalThis.__BIGCON_ENVS[N]`. The
 *            preamble sits on the first source line, so line numbers stay true.
 *
 * Modules imported WITHOUT `?gen=` (the DOM-free engine tests) are untouched.
 */
export const ENV_NAMES = [
  'document', 'window', 'location', 'localStorage', 'sessionStorage', 'crypto', 'navigator',
  'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'console', 'Notification', 'Peer', 'WebSocket', 'BUILD_COMMIT',
];

const GEN = /[?&]gen=(\d+)/;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  const m = context.parentURL && GEN.exec(context.parentURL);
  if (m && resolved.url.startsWith('file:') && !resolved.url.includes('/node_modules/')) {
    const u = new URL(resolved.url);
    u.searchParams.set('gen', m[1]);
    return { ...resolved, url: u.href };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  const m = GEN.exec(url);
  if (m && loaded.format === 'module' && loaded.source) {
    const text = Buffer.from(loaded.source).toString('utf8');
    const pre = `const {${ENV_NAMES.join(',')}} = globalThis.__BIGCON_ENVS[${m[1]}];`;
    return { ...loaded, source: pre + text };
  }
  return loaded;
}
