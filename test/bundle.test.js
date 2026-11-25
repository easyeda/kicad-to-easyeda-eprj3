#!/usr/bin/env node
'use strict';
/**
 * bundle.test.js — Regression tests for the standalone build:
 *   - dist bundle builds and exposes the API/version
 *   - the standalone file works as a Node CLI
 *   - the in-memory browser API converts a project and its ZIP is readable
 *   - the self-contained HTML embeds the bundle and has valid scripts
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readZip } = require('../scripts/lib/zip');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const VERSION = require('../package.json').version;
const BUNDLE = path.join(DIST, `kicad-to-eprj3-${VERSION}.js`);
const HTML = path.join(DIST, 'kicad-to-eprj3.html');
const EXAMPLE = path.join(ROOT, 'example', 'kicad', 'kicad-project');

let failures = 0;
let checks = 0;
function assert(cond, name, detail = '') {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function run(args) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kicad2eprj3-bundle-'));
  try {
    const build = run([path.join(ROOT, 'build', 'bundle.js')]);
    assert(build.status === 0, 'build/bundle.js succeeds', (build.stdout || '') + (build.stderr || ''));
    assert(fs.existsSync(BUNDLE), 'standalone JS is written');
    assert(fs.existsSync(HTML), 'self-contained HTML is written');

    const api = require(BUNDLE);
    assert(api.version === VERSION, 'bundle exposes the package version');
    assert(typeof api.convertProject === 'function' && typeof api.convertProjectFiles === 'function'
      && typeof api.zipStore === 'function', 'bundle exposes the conversion API');

    // ---- Node CLI ----
    const outDir = path.join(tmp, 'cli-out');
    const cli = run([BUNDLE, 'convert', EXAMPLE, outDir, '--project-name', 'kicad-project']);
    assert(cli.status === 0, 'standalone CLI converts a project', (cli.stdout || '') + (cli.stderr || ''));
    const idxFile = path.join(outDir, 'kicad-project.eprj3');
    assert(fs.existsSync(idxFile), 'standalone CLI writes the eprj3 index');
    assert(fs.existsSync(path.join(outDir, 'pcb', 'PCB1.epcb2')), 'standalone CLI writes the PCB');
    assert(fs.existsSync(path.join(outDir, 'sch', 'kicad-project', 'kicad-project.esch2')),
      'standalone CLI writes the schematic');
    let index = null;
    try { index = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch (e) { /* asserted below */ }
    assert(!!index && Object.keys(index.profile.schematics).length === 1
      && Object.keys(index.profile.pcbs).length === 1,
      'standalone index links one schematic and one PCB',
      index && JSON.stringify({
        schematics: Object.keys(index.profile.schematics).length,
        pcbs: Object.keys(index.profile.pcbs).length
      }));

    // ---- in-memory (browser) API ----
    const files = [];
    for (const f of fs.readdirSync(EXAMPLE)) {
      if (!/\.(kicad_sch|kicad_pcb|kicad_pro)$/i.test(f)) continue;
      files.push({ path: f, data: new Uint8Array(fs.readFileSync(path.join(EXAMPLE, f))) });
    }
    const result = await api.convertProjectFiles({ name: 'kicad-project', files });
    const paths = (result.files || []).map(f => f.path).sort();
    assert(paths.length === 5, 'in-memory conversion returns the five project files', JSON.stringify(paths));
    assert(paths.includes('kicad-project/kicad-project.eprj3')
      && paths.includes('kicad-project/pcb/PCB1.epcb2'), 'in-memory output paths are project-prefixed');
    const idx = (result.files || []).find(f => f.path.endsWith('.eprj3'));
    let parsed = null;
    if (idx) { try { parsed = JSON.parse(Buffer.from(idx.data).toString('utf8')); } catch (e) { /* asserted */ } }
    assert(!!parsed && parsed.name === 'kicad-project', 'in-memory index parses');
    assert((result.warningCount | 0) === 0 && (result.failures || []).length === 0,
      'example project converts without warnings/failures');

    // ---- browser code path (no Node module/fs bindings) ----
    const vm = require('vm');
    const sandbox = {
      console, TextEncoder, TextDecoder, setTimeout, clearTimeout, URL,
      crypto: require('crypto').webcrypto,
      Blob: class { constructor(parts) { this.parts = parts; } }
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'kicad-to-eprj3-browser.js' });
    const browserApi = sandbox.KicadToEpj3;
    assert(!!browserApi && browserApi.version === VERSION, 'bundle initializes without Node globals');
    const browserResult = await browserApi.convertProjectFiles({ name: 'browser-test', files });
    const browserPaths = (browserResult.files || []).map(f => f.path).sort();
    assert(browserPaths.length === 5 && browserPaths.includes('browser-test/browser-test.eprj3'),
      'browser-path conversion uses the in-memory filesystem', JSON.stringify(browserPaths));
    assert((browserResult.failures || []).length === 0, 'browser-path conversion has no failures');

    // ---- zip round-trip ----
    const zip = api.zipProject(result);
    let entries = [];
    try { entries = readZip(Buffer.from(zip)); } catch (e) { entries = []; }
    assert(entries.length === 5, 'browser ZIP contains the five output files', `${entries.length} entries`);
    const zipIdx = entries.find(e => e.name.endsWith('.eprj3'));
    assert(!!zipIdx && JSON.parse(zipIdx.data.toString('utf8')).name === 'kicad-project',
      'ZIP index is readable');

    // ---- HTML ----
    const html = fs.readFileSync(HTML, 'utf8');
    assert(html.includes(`kicad-to-eprj3 v${VERSION}`), 'HTML shows the build version');
    assert(!html.includes('__K2E_BUNDLE__') && !html.includes('__K2E_VERSION__'), 'HTML placeholders are replaced');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert(scripts.length === 2 && scripts[0].length > 100000, 'HTML embeds the standalone bundle');
    const scriptDir = path.join(tmp, 'scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    let scriptOk = true;
    scripts.forEach((s, i) => {
      const f = path.join(scriptDir, `s${i}.js`);
      fs.writeFileSync(f, s);
      const r = run(['--check', f]);
      if (r.status !== 0) { scriptOk = false; console.error((r.stderr || '').slice(0, 800)); }
    });
    assert(scriptOk, 'embedded HTML scripts parse');

    if (failures) process.exitCode = 1;
    console.log(`\n${checks - failures}/${checks} checks passed`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
