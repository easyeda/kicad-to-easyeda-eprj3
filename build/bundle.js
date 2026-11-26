#!/usr/bin/env node
'use strict';
/**
 * bundle.js — Build the standalone artifacts:
 *
 *   dist/kicad-to-eprj3-<version>.js      UMD bundle (Node CLI + browser API)
 *   dist/kicad-to-eprj3.html              self-contained browser page
 *   dist/README.md                        bilingual end-user instructions
 *   dist/kicad-to-eprj3-<version>.zip     the three files above (+ LICENSE)
 *
 * No bundler dependency: modules are CommonJS with static relative requires,
 * so they are wrapped in a tiny registry. Node builtins are injected from the
 * host in Node and replaced with browser shims in the page.
 */
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const { createZip } = require('../scripts/lib/zip');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ENTRY = 'scripts/browser/entry.js';
const BUILTINS = new Set(['fs', 'path', 'crypto', 'zlib', 'child_process', '@env']);
const VERSION = process.env.K2E_VERSION || pkg.version;

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

// ---- module graph ---------------------------------------------------------

function normalizeId(id) {
  return path.posix.normalize(id).replace(/^\/+/, '');
}

function resolveRequire(fromId, spec) {
  if (!spec.startsWith('.')) return null; // builtin
  let target = normalizeId(path.posix.join(path.posix.dirname(fromId), spec));
  if (!target.endsWith('.js') && !target.endsWith('.json')) {
    if (fs.existsSync(path.join(ROOT, target + '.js'))) target += '.js';
    else if (fs.existsSync(path.join(ROOT, target + '.json'))) target += '.json';
  }
  return target;
}

const modules = new Map(); // id -> { source | json }
const queue = [ENTRY];
// Builtin shims are referenced by the runtime registry, not by a static
// require in the entry, so seed them explicitly.
queue.push(
  'scripts/browser/node-shims/fs.js',
  'scripts/browser/node-shims/path-facade.js',
  'scripts/browser/node-shims/crypto.js',
  'scripts/browser/node-shims/zlib.js',
  'scripts/browser/node-shims/child_process.js'
);

while (queue.length) {
  const id = queue.shift();
  if (modules.has(id)) continue;
  const abs = path.join(ROOT, id);
  const raw = fs.readFileSync(abs, 'utf8');
  if (id.endsWith('.json')) {
    modules.set(id, { json: raw });
    continue;
  }
  // A literal NUL in the source is a valid JS string character but makes
  // editors/tools treat the bundle as binary; emit the escape instead.
  const source = raw.replace(/\u0000/g, '\\u0000');
  modules.set(id, { source });
  // Scan requires outside comments/documentation examples.
  const scan = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(scan))) {
    const dep = resolveRequire(id, m[1]);
    if (dep) queue.push(dep);
    else if (!BUILTINS.has(m[1])) throw new Error(`Unsupported require('${m[1]}') in ${id}`);
  }
}

// ---- bundle ----------------------------------------------------------------

function moduleBody(id, mod) {
  if (mod.json) {
    return `module.exports = JSON.parse(${JSON.stringify(mod.json)});`;
  }
  return mod.source;
}

let out = '';
out += `/*! kicad-to-eprj3 v${VERSION} — KiCad → EasyEDA Pro .eprj3 converter (standalone bundle) */\n`;
out += `(function (root, factory) {\n`;
out += `  if (typeof module === 'object' && module.exports) {\n`;
out += `    module.exports = factory({\n`;
out += `      fs: require('fs'), path: require('path'), crypto: require('crypto'),\n`;
out += `      zlib: require('zlib'), child_process: require('child_process'),\n`;
out += `      isNode: true, isMain: require.main === module\n`;
out += `    });\n`;
out += `  } else {\n`;
out += `    root.KicadToEpj3 = factory({ isNode: false, isMain: false });\n`;
out += `  }\n`;
out += `})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (__HOST__) {\n`;
out += `  'use strict';\n`;
out += `  var __modules = Object.create(null);\n`;
out += `  var __cache = Object.create(null);\n`;
out += `  function __normalize(p) {\n`;
out += `    var abs = p.charAt(0) === '/';\n`;
out += `    var out = [];\n`;
out += `    var segs = p.split('/');\n`;
out += `    for (var i = 0; i < segs.length; i++) {\n`;
out += `      var s = segs[i];\n`;
out += `      if (!s || s === '.') continue;\n`;
out += `      if (s === '..') { if (out.length) out.pop(); else if (!abs) out.push('..'); }\n`;
out += `      else out.push(s);\n`;
out += `    }\n`;
out += `    return (abs ? '/' : '') + out.join('/');\n`;
out += `  }\n`;
out += `  function __dirnameOf(id) {\n`;
out += `    var i = id.lastIndexOf('/');\n`;
out += `    return i < 0 ? '' : id.slice(0, i);\n`;
out += `  }\n`;
out += `  function __makeRequire(id) {\n`;
out += `    return function (spec) {\n`;
out += `      if (spec.charAt(0) !== '.') return __builtins[spec];\n`;
out += `      var t = __normalize((__dirnameOf(id) ? __dirnameOf(id) + '/' : '') + spec);\n`;
out += `      if (!__modules[t]) {\n`;
out += `        if (__modules[t + '.js']) t += '.js';\n`;
out += `        else if (__modules[t + '.json']) t += '.json';\n`;
out += `      }\n`;
out += `      if (!__modules[t]) throw new Error('Module not found: ' + spec + ' (from ' + id + ')');\n`;
out += `      return __load(t);\n`;
out += `    };\n`;
out += `  }\n`;
out += `  function __load(id) {\n`;
out += `    if (__cache[id]) return __cache[id].exports;\n`;
out += `    var mod = __cache[id] = { exports: {} };\n`;
out += `    __modules[id](mod, mod.exports, __makeRequire(id));\n`;
out += `    return mod.exports;\n`;
out += `  }\n`;

for (const [id, mod] of modules) {
  out += `\n  __modules[${JSON.stringify(id)}] = function (module, exports, require) {\n`;
  // Emit the body verbatim: indenting it would change template-literal values.
  out += moduleBody(id, mod);
  out += `\n  };\n`;
}
// Builtins are initialized after the module table exists, because loading the
// fs/path shims goes through the registry.
out += `\n  var __builtins = Object.create(null);\n`;
out += `  __builtins['fs'] = __load('scripts/browser/node-shims/fs.js');\n`;
out += `  __builtins['path'] = __load('scripts/browser/node-shims/path-facade.js');\n`;
out += `  __builtins['crypto'] = __HOST__.crypto || __load('scripts/browser/node-shims/crypto.js');\n`;
out += `  __builtins['zlib'] = __HOST__.zlib || __load('scripts/browser/node-shims/zlib.js');\n`;
out += `  __builtins['child_process'] = __HOST__.child_process || __load('scripts/browser/node-shims/child_process.js');\n`;
out += `  __builtins['@env'] = { isNode: !!__HOST__.isNode, isMain: !!__HOST__.isMain, nodeFs: __HOST__.fs || null, nodePath: __HOST__.path || null, version: ${JSON.stringify(VERSION)} };\n`;
out += `\n  return __load(${JSON.stringify(ENTRY)});\n`;
out += `});\n`;

const bundleFile = path.join(DIST, `kicad-to-eprj3-${VERSION}.js`);
fs.writeFileSync(bundleFile, out, 'utf8');

// ---- self-contained HTML page ----------------------------------------------

const template = fs.readFileSync(path.join(ROOT, 'build', 'app.html'), 'utf8');
const safeBundle = out.replace(/<\/script/gi, '<\\/script');
const html = template
  .replace(/__K2E_VERSION__/g, VERSION)
  .replace(/\/\*__K2E_BUNDLE__\*\//g, () => safeBundle);
const htmlFile = path.join(DIST, 'kicad-to-eprj3.html');
fs.writeFileSync(htmlFile, html, 'utf8');

// ---- bilingual end-user README ---------------------------------------------

const readmeTemplate = fs.readFileSync(path.join(ROOT, 'build', 'artifact-readme.md'), 'utf8');
const readme = readmeTemplate.replace(/__K2E_VERSION__/g, VERSION);
const readmeFile = path.join(DIST, 'README.md');
fs.writeFileSync(readmeFile, readme, 'utf8');

// ---- zip -------------------------------------------------------------------

const zipFile = path.join(DIST, `kicad-to-eprj3-${VERSION}.zip`);
const licenseFile = path.join(ROOT, 'LICENSE');
const entries = [
  { name: `kicad-to-eprj3-${VERSION}/kicad-to-eprj3-${VERSION}.js`, data: out },
  { name: `kicad-to-eprj3-${VERSION}/kicad-to-eprj3.html`, data: html },
  { name: `kicad-to-eprj3-${VERSION}/README.md`, data: readme }
];
if (fs.existsSync(licenseFile)) {
  entries.push({ name: `kicad-to-eprj3-${VERSION}/LICENSE`, data: fs.readFileSync(licenseFile) });
}
const licensesDir = path.join(ROOT, 'build', 'licenses');
if (fs.existsSync(licensesDir)) {
  for (const f of fs.readdirSync(licensesDir).sort()) {
    entries.push({
      name: `kicad-to-eprj3-${VERSION}/LICENSES/${f}`,
      data: fs.readFileSync(path.join(licensesDir, f))
    });
  }
}
fs.writeFileSync(zipFile, createZip(entries));

const kb = n => `${(n / 1024).toFixed(1)} KB`;
console.log(`kicad-to-eprj3 v${VERSION}`);
console.log(`  ${path.relative(ROOT, bundleFile)}  (${kb(out.length)})`);
console.log(`  ${path.relative(ROOT, htmlFile)}    (${kb(html.length)})`);
console.log(`  ${path.relative(ROOT, readmeFile)}  (${kb(readme.length)})`);
console.log(`  ${path.relative(ROOT, zipFile)}     (${kb(fs.statSync(zipFile).size)})`);
