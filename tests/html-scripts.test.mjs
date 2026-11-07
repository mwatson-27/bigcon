import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html')).sort();

const JS_TYPES = new Set([
  '', 'text/javascript', 'application/javascript', 'application/x-javascript',
  'text/ecmascript', 'application/ecmascript', 'text/jscript', 'text/babel'
]);

// Compile (never run) every classic inline script; return a list of failures.
export function checkInlineScripts(html, page) {
  const errors = [];
  let n = 0;
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)) {
    n++;
    const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(m[1]);
    const t = type ? type[1].toLowerCase() : '';
    if (!JS_TYPES.has(t) || t === 'text/babel') continue;
    try {
      new vm.Script(m[2], { filename: `${page}#script${n}` });
    } catch (e) {
      errors.push(`${page} script #${n}: ${e.message}`);
    }
  }
  return errors;
}

test('html pages discovered', () => {
  assert.ok(pages.length > 0, 'no *.html pages found in repo root');
});

for (const page of pages) {
  test(`${page}: inline scripts compile`, () => {
    const html = fs.readFileSync(new URL(page, root), 'utf8');
    const errors = checkInlineScripts(html, page);
    assert.deepEqual(errors, [], errors.join('\n'));
  });
}
