/*
 * index.html loads the game as separate classic <script> files that share one
 * global scope (no bundler). These tests pin that layout: every referenced
 * asset exists, every classic file is strict, and the files really do load in
 * document order, one vm.Script each, without TDZ / missing-function errors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HTML, GAME_SCRIPTS, SOURCE, repoRoot, loadEngine, makeGame } from './helpers/harness.mjs';

const isRemote = u => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(u);
const local = u => path.join(repoRoot, u.replace(/^\.\//, '').replace(/[?#].*$/, ''));

test('every local <script src> and stylesheet referenced by index.html exists on disk', () => {
  const refs = [];
  for (const m of HTML.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
  for (const m of HTML.matchAll(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi)) {
    const href = m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    assert.ok(href, 'stylesheet link has an href: ' + m[0]);
    refs.push(href[1]);
  }
  assert.ok(refs.some(r => r.endsWith('game.css')), 'game.css is linked');
  assert.ok(refs.some(r => r.endsWith('static/js/core.js')), 'core.js is referenced');
  for (const r of refs) {
    if (isRemote(r)) continue;
    assert.ok(r.startsWith('./static/'), r + ' uses the ./static/ relative style (works at / and in the Discord proxy)');
    assert.ok(fs.existsSync(local(r)), r + ' exists on disk');
  }
});

test('every classic game script starts with a strict-mode directive', () => {
  const classic = GAME_SCRIPTS.filter(s => s.file !== 'index.html:inline');
  assert.ok(classic.length >= 6, 'the game is split into several files');
  for (const s of GAME_SCRIPTS) {
    assert.match(s.text.replace(/^\s+/, ''), /^'use strict';/, s.file + " must begin with 'use strict';");
  }
  assert.match(SOURCE.replace(/^\s+/, ''), /^'use strict';/, 'the joined source is strict like each browser script');
});

test('BUILD_COMMIT stays inline in index.html for the CI stamp check', () => {
  assert.match(HTML, /const BUILD_COMMIT = '[0-9a-f]{7}';/);
  assert.equal(GAME_SCRIPTS.filter(s => /const BUILD_COMMIT\b/.test(s.text)).length, 1);
});

test('the Discord block is a module loaded from a file, after the classic scripts', () => {
  const tags = [...HTML.matchAll(/<script\b([^>]*)>/gi)].map(m => m[1]);
  const mod = tags.findIndex(a => /type\s*=\s*["']module["']/.test(a));
  assert.ok(mod > -1 && /src\s*=\s*["']\.\/static\/js\/discord\.js["']/.test(tags[mod]));
  assert.equal(mod, tags.length - 1, 'the module is the last script');
  assert.ok(fs.existsSync(path.join(repoRoot, 'static/js/discord.js')));
});

test('files load one by one in a shared global scope without load-time errors', () => {
  const engine = loadEngine({ perFile: true });
  const joined = loadEngine();
  assert.deepEqual(engine.consoleOut.error, []);
  assert.equal(engine.acc.NODES.length, joined.acc.NODES.length);
  assert.equal(engine.acc.CARDS.length, joined.acc.CARDS.length);
  assert.equal(engine.ctx.IS_DISCORD_ACTIVITY, undefined, 'const globals stay lexical, never window properties');
  for (const fn of ['applyIntent', 'startTurn', 'generateRandomBoard', 'pubState', 'adoptState', 'showRules', 'handleHello'])
    assert.equal(typeof engine.f[fn], 'function', fn + ' is a global function');
  engine.dispose(); joined.dispose();
});

test('a game starts on the per-file load (late-file functions are reachable)', async () => {
  const engine = loadEngine({ perFile: true });
  const S = await makeGame(engine, 2);
  assert.equal(S.players.length, 2);
  assert.ok(S.players.every(p => typeof p.money === 'number'));
  engine.dispose();
});
