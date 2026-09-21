/**
 * The dashboard is plain static assets, so a typo in them is invisible until
 * someone opens a browser. These check the parts that fail silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assets } from '../src/dashboard/serve.ts';

const all = assets();
const html = all['/']!.body;
const js = all['/app.js']!.body;
const css = all['/style.css']!.body;

test('every asset the page references is served', () => {
  // An asset blocked or missing renders nothing and logs nothing.
  assert.ok(all['/app.js'], 'app.js');
  assert.ok(all['/style.css'], 'style.css');
  assert.match(html, /<script src="\/app\.js">/);
  assert.match(html, /href="style\.css"/);
});

test('provider marks are inlined, not fetched from another origin', () => {
  // The marks are injected as a JSON string literal, so their quotes are
  // escaped. Match on the attribute and value, not on a quoting style that
  // depends on how they were embedded.
  assert.match(html, /viewBox=\\?"0 0 100 100/, 'Claude mark missing');
  assert.match(html, /viewBox=\\?"0 0 320 320/, 'ChatGPT mark missing');
  assert.doesNotMatch(html, /<img/, 'no external images');
  assert.doesNotMatch(css, /url\(https?:/, 'no external CSS urls');
});

test('the page has all four sections and the nav to reach them', () => {
  for (const id of ['p-overview', 'p-logs', 'p-settings', 'p-help']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} missing`);
  }
  for (const page of ['overview', 'logs', 'settings', 'help']) {
    assert.match(html, new RegExp(`data-p="${page}"`), `${page} tab missing`);
  }
});

test('every element the script fills exists in the markup', () => {
  // A renamed id fails silently — the panel simply stays empty. Ids created
  // at runtime (the rename dialog's input) are excluded, since they are not
  // in the shell by design.
  const runtime = new Set(['alias-in']);
  for (const id of js.matchAll(/getElementById\('([a-z-]+)'\)/g)) {
    if (runtime.has(id[1]!)) continue;
    assert.match(html, new RegExp(`id="${id[1]}"`), `#${id[1]} is filled by the script but absent from the HTML`);
  }
});

test('REGRESSION: every hex colour is valid', () => {
  // A malformed value (#e08ab \u2014 five digits) is silently ignored by browsers.
  for (const m of css.matchAll(/:\s*(#[0-9a-fA-F]+)/g)) {
    assert.ok([4, 7, 9].includes(m[1]!.length), `invalid hex colour ${m[1]}`);
  }
});

test('both themes define every colour token', () => {
  for (const token of ['--claude', '--codex', '--accent', '--ok', '--warn', '--bad']) {
    const defined = [...css.matchAll(new RegExp(`${token}:`, 'g'))].length;
    assert.ok(defined >= 2, `${token} must be defined in both light and dark`);
  }
});

test('the script carries no leftover mock data', () => {
  // The mockup shipped invented accounts and history; shipping those would
  // show a user numbers that are not theirs.
  assert.doesNotMatch(js, /s\.xhoxhaj6@gmail\.com/, 'a hardcoded account survived the port');
  assert.doesNotMatch(js, /claude-unlimited|nmbrs-api|visma-connect/, 'mock project names survived');
  assert.doesNotMatch(js, /Math\.sin\(/, 'the fake calendar generator survived');
});

test('all three languages are complete', () => {
  const start = js.indexOf('const I18N = {');
  const end = js.indexOf('let lang', start);
  const I18N = new Function(js.slice(start, end) + ' return I18N;')() as Record<string, Record<string, string>>;
  assert.deepEqual(Object.keys(I18N).sort(), ['de', 'en', 'nl']);
  const en = Object.keys(I18N['en']!);
  for (const lang of ['nl', 'de']) {
    const missing = en.filter((k) => !(k in I18N[lang]!));
    assert.deepEqual(missing, [], `${lang} is missing: ${missing.join(', ')}`);
  }
});

test('REGRESSION: every action button is actually wired to something', () => {
  // "Scan now" shipped as markup with no handler and no endpoint behind it:
  // it looked like a working control and did nothing. A button with an id
  // must be referenced by the script.
  const ids = [...html.matchAll(/<button[^>]*\bid="([a-z-]+)"/g)].map((m) => m[1]!);
  assert.ok(ids.length > 0, 'expected some identified buttons');
  for (const id of ids) {
    assert.ok(js.includes(`'${id}'`), `#${id} is a button in the HTML that the script never references`);
  }
});

test('the scan endpoint the button calls is one the server serves', () => {
  // A handler pointing at a path that does not exist fails only at runtime.
  const server = readFileSync(new URL('../src/proxy/server.ts', import.meta.url), 'utf8');
  for (const m of js.matchAll(/fetch\('(\/api\/[a-z/]+)'/g)) {
    assert.ok(server.includes(`'${m[1]}'`), `the page calls ${m[1]} but the server has no such route`);
  }
});

test('REGRESSION: every function the script calls is actually defined', () => {
  // displayName() and clock() were each used in several places and defined in
  // none. The render threw on first paint and the panel came up blank — a
  // missing function is invisible until the browser runs it.
  //
  // Quoted strings are blanked so prose like "Suche…(" is not read as a call,
  // but template literals are KEPT: most of this page's calls live inside
  // them, and stripping those is what let clock() through the first time.
  const code = js
    // Comments are prose: "…internally (draining, …)" is not a call. Strip
    // them first, then quoted strings, before looking for call sites.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  const defined = new Set([
    ...[...js.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!),
    ...[...js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]!),
    ...[...js.matchAll(/([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)].map((m) => m[1]!),
  ]);
  const builtin = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'fetch', 'setTimeout',
    'setInterval', 'parseInt', 'parseFloat', 'isNaN', 'matchMedia', 'alert', 'confirm', 'prompt',
    'async', 'await', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'yield',
  ]);

  const missing = new Set<string>();
  for (const m of code.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_$]*)\s*\(/g)) {
    const name = m[1]!;
    if (defined.has(name) || builtin.has(name)) continue;
    missing.add(name);
  }
  assert.deepEqual([...missing], [], `called but never defined: ${[...missing].join(', ')}`);
});


