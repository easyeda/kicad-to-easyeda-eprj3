#!/usr/bin/env node
'use strict';
/**
 * import-kicad-lib.js — Import a symbol from a KiCad library (.kicad_sym)
 *                       into an existing eprj3 project as a SYMBOL document.
 *
 * Usage:
 *   node scripts/import-kicad-lib.js import \
 *     --dir <projectDir> \
 *     --library <fileOrDir> \
 *     --component <name>
 *
 * --library may be a single .kicad_sym file or a directory that is scanned
 * for the first .kicad_sym containing the requested component.
 */
const fs = require('fs');
const path = require('path');
const { Project, uuid, writeRecords } = require('./lib/eprj3');
const { parseSymbolFile } = require('./lib/kicad');
const { buildSymbolRecords } = require('./lib/kicad-to-eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, required: true, desc: 'eprj3 project root directory' },
  { name: 'library', hasValue: true, required: true, desc: '.kicad_sym file or directory containing one' },
  { name: 'component', hasValue: true, required: true, desc: 'Symbol name inside the library' }
];

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printHelp('import-kicad-lib.js import [options]', schema); process.exit(sub ? 0 : 1);
  }
  const { opts } = parseArgs(process.argv.slice(3), schema);
  if (sub !== 'import') die(`Unknown command: ${sub}`);

  await Project.load(path.resolve(opts.dir));
  const projectRoot = path.resolve(opts.dir);
  const lib = path.resolve(opts.library);
  if (!fs.existsSync(lib)) die(`Library not found: ${lib}`);

  let sym = null;
  if (fs.statSync(lib).isFile()) {
    sym = parseSymbolFile(lib).find(s => s.name === opts.component);
  } else {
    for (const libFile of fs.readdirSync(lib).filter(f => f.endsWith('.kicad_sym'))) {
      sym = parseSymbolFile(path.join(lib, libFile)).find(s => s.name === opts.component);
      if (sym) break;
    }
  }
  if (!sym) die(`Symbol "${opts.component}" not found in ${lib}`);

  const outDir = path.join(projectRoot, 'sch', '__symbols__');
  fs.mkdirSync(outDir, { recursive: true });
  const head = {
    head: { type: 'DOCHEAD' },
    body: { docType: 'SYMBOL', client: 'kicad-to-easyeda-eprj3', uuid: uuid(16), updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} }
  };
  const { records } = buildSymbolRecords(sym);
  const meta = { head: { type: 'META', ticket: 1, id: 'META' }, body: { title: sym.name, description: '', tags: [], docType: 2, source: '' } };
  const file = path.join(outDir, `${sym.name}.esch2`);
  writeRecords(file, [head, meta, ...records]);
  console.log(`Imported KiCad symbol "${sym.name}" -> ${file}`);
}

main().catch(err => die(err.message, 1));
