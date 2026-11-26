#!/usr/bin/env node
'use strict';
/**
 * ui.test.js — Drives the generated browser page in a fake DOM:
 *   - folder picker (File System Access API) scans a parent and lists projects
 *   - multi-select modal adds only the checked projects
 *   - conversion/download actions wire up
 *   - <input webkitdirectory> fallback splits a parent folder into projects
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'dist', 'kicad-to-eprj3.html');

let checks = 0;
let failures = 0;
function assert(cond, name, detail = '') {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}

function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', disabled: false, hidden: false, value: '', files: [], type: '',
    _listeners: {},
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type, ev) { for (const fn of this._listeners[type] || []) fn(ev || { target: this }); },
    click() { this.dispatch('click', { target: this }); },
    getAttribute(name) { return this[name]; },
    closest() { return null; },
    remove() {}
  };
}

function fileEntry(name) {
  return {
    name, kind: 'file',
    async getFile() {
      return { name, async arrayBuffer() { return new TextEncoder().encode('file:' + name).buffer; } };
    }
  };
}
function fakeDir(name, children) {
  return {
    name, kind: 'directory',
    async *entries() { for (const c of children) yield [c.name, c]; }
  };
}
function inputFile(rel) {
  return {
    name: rel.split('/').pop(),
    webkitRelativePath: rel,
    async arrayBuffer() { return new TextEncoder().encode(rel).buffer; }
  };
}

function createPage(opts = {}) {
  const html = fs.readFileSync(HTML, 'utf8');
  const pageScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const els = {};
  for (const id of ids) els[id] = makeEl(id);
  const alerts = [];
  const sandbox = {
    console,
    TextEncoder, TextDecoder, setTimeout, clearTimeout, Promise, Map, Set, Uint8Array, Date, Math, JSON,
    navigator: { language: 'zh-CN' },
    localStorage: { getItem() { return null; }, setItem() {} },
    alert: msg => alerts.push(String(msg)),
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL() { return 'blob:x'; }, revokeObjectURL() {} },
    document: {
      documentElement: {},
      getElementById: id => els[id] || (els[id] = makeEl(id)),
      createElement: tag => makeEl(tag),
      body: { appendChild() {} }
    },
    KicadToEpj3: {
      version: 'test',
      async convertProjectFiles({ name, files }) {
        return {
          projectName: name, files: files.map(f => ({ path: name + '/' + f.path, data: new Uint8Array([1]) })),
          failures: [], warnings: [], warningCount: 0, logs: [], schematics: [], pcbs: []
        };
      },
      zipProject() { return new Uint8Array([1, 2, 3]); },
      zipStore() { return new Uint8Array([1, 2, 3]); }
    }
  };
  if (opts.showDirectoryPicker) sandbox.showDirectoryPicker = opts.showDirectoryPicker;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pageScript, sandbox, { filename: 'page.js' });
  return { els, alerts };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // ---- 1) File System Access picker: parent with two projects ----
  const parent = fakeDir('parent', [
    fakeDir('projA', [fileEntry('projA.kicad_sch'), fileEntry('projA.kicad_pcb')]),
    fakeDir('projB', [fileEntry('projB.kicad_sch')])
  ]);
  const page = createPage({ showDirectoryPicker: async () => parent });
  const { els } = page;

  els.drop.dispatch('click', { target: els.drop });
  await wait(50);
  assert(!els.modal.hidden, 'picker opens the multi-select modal');
  assert(els.modalList.innerHTML.includes('projA') && els.modalList.innerHTML.includes('projB'),
    'both project folders are listed', els.modalList.innerHTML);
  assert(!els.modalOk.disabled && els.modalOk.textContent.includes('2'),
    'modal offers adding both projects', els.modalOk.textContent);

  els.modalList.dispatch('change', { target: { type: 'checkbox', checked: false, getAttribute: () => '1' } });
  els.modalOk.dispatch('click', { target: els.modalOk });
  await wait(100);
  assert(els.modal.hidden, 'modal closes after adding');
  assert(els.list.innerHTML.includes('projA') && !els.list.innerHTML.includes('projB'),
    'only the checked project is added', els.list.innerHTML);
  assert(els.list.innerHTML.includes('2 个文件'), 'project file count is shown', els.list.innerHTML);

  els.convertBtn.dispatch('click', { target: els.convertBtn });
  await wait(150);
  assert(els.list.innerHTML.includes('完成'), 'conversion finishes', els.list.innerHTML);
  assert(els.list.innerHTML.includes('下载 .eprj3.zip'), 'per-project download is available');

  // ---- 2) <input webkitdirectory> fallback: split a parent folder ----
  const page2 = createPage();
  const picker = page2.els.picker;
  picker.files = [
    inputFile('parent/projA/a.kicad_sch'),
    inputFile('parent/projA/a.kicad_pcb'),
    inputFile('parent/projB/b.kicad_sch'),
    inputFile('parent/readme.txt')
  ];
  picker.dispatch('change', { target: picker });
  await wait(50);
  assert(!page2.els.modal.hidden, 'folder input opens the multi-select modal');
  assert(page2.els.modalList.innerHTML.includes('projA') && page2.els.modalList.innerHTML.includes('projB'),
    'input fallback detects both projects', page2.els.modalList.innerHTML);
  page2.els.modalOk.dispatch('click', { target: page2.els.modalOk });
  await wait(100);
  assert(page2.els.list.innerHTML.includes('projA') && page2.els.list.innerHTML.includes('projB'),
    'input fallback adds both projects', page2.els.list.innerHTML);

  if (failures) process.exitCode = 1;
  console.log(`\n${checks - failures}/${checks} checks passed`);
}

main().catch(err => { console.error(err); process.exit(1); });
