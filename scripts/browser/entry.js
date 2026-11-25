'use strict';
/**
 * entry.js — entry point of the standalone bundle.
 *
 * Node:      node kicad-to-eprj3-<version>.js convert <src> <dst> [...]
 *            node kicad-to-eprj3-<version>.js convert-lib <src> <dst.elibz2> [...]
 *            const api = require('./kicad-to-eprj3-<version>.js')
 * Browser:   <script src="kicad-to-eprj3-<version>.js"></script> → window.KicadToEpj3
 *            KicadToEpj3.convertProjectFiles({ name, files, pourFineness })
 */
const { convertProject } = require('../lib/convert-project');
const { convertLibrary } = require('../lib/convert-lib');
const { resetWarnings, setWarnSink } = require('../lib/convert-util');
const { VirtualFs } = require('./vfs');
const { setActiveFs } = require('./active-fs');
const { zipStore } = require('./zip-store');
const { parseArgs, printHelp, die } = require('../lib/utils');
const { setNodeFs } = require('./node-fs');
const { setNodePath } = require('./node-path');
const VERSION = require('../../package.json').version;
const env = require('@env');

if (env.isNode) {
  if (env.nodeFs) setNodeFs(env.nodeFs);
  if (env.nodePath) setNodePath(env.nodePath);
}

const PROJECT_SCHEMA = [
  { name: 'project-name', hasValue: true, desc: 'Override project name' },
  { name: 'pour-fineness', hasValue: true, desc: 'Copper pour fill fineness 1-8 (default 8)' }
];

/**
 * Browser conversion: files are [{ path, data:Uint8Array }] relative to the
 * selected KiCad project folder. Returns the written eprj3 files under a
 * "<projectName>/" prefix, ready to be zipped/downloaded.
 *
 * Calls are serialized: the in-memory fs/warning sink are process-global, so
 * converting two projects in parallel would mix their files.
 */
let convertQueue = Promise.resolve();
function convertProjectFiles(input) {
  const run = () => doConvertProjectFiles(input);
  const next = convertQueue.then(run, run);
  convertQueue = next.then(() => {}, () => {});
  return next;
}

async function doConvertProjectFiles(input) {
  const opts = input || {};
  const files = Array.isArray(opts.files) ? opts.files : [];
  if (!files.length) throw new Error('No input files');
  const rawName = String(opts.name || 'project');
  const projectName = rawName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+$/, '') || 'project';
  const vfs = new VirtualFs();
  vfs.seed(projectName, files);
  const logs = [];
  const warnings = [];
  const log = msg => {
    const line = String(msg);
    logs.push(line);
    if (typeof opts.log === 'function') opts.log(line);
  };
  setWarnSink(msg => warnings.push(String(msg)));
  resetWarnings();
  setActiveFs(vfs);
  try {
    const result = await convertProject('/' + projectName, '/out', {
      projectName,
      pourFineness: opts.pourFineness === undefined ? 8 : Number(opts.pourFineness),
      log
    });
    const out = vfs.collect('/out').map(f => ({ path: projectName + '/' + f.path, data: f.data }));
    return {
      projectName,
      schematics: result.schematics,
      pcbs: result.pcbs,
      failures: result.failures,
      warningCount: result.warnings,
      warnings,
      logs,
      files: out
    };
  } finally {
    setWarnSink(null);
    setActiveFs(null);
  }
}

/** Zip the output of convertProjectFiles() (store-only, browser-safe). */
function zipProject(result) {
  const files = (result && result.files) || [];
  return zipStore(files.map(f => ({ name: f.path, data: f.data })));
}

/** Zip several convertProjectFiles() results into one archive. */
function zipProjects(results) {
  const files = [];
  for (const r of results || []) for (const f of r.files || []) files.push({ name: f.path, data: f.data });
  return zipStore(files);
}

// ---- Node CLI ------------------------------------------------------------

async function cliProject(argv) {
  const usage = 'kicad-to-eprj3.js convert <KiCadProjectDir> <eprj3Dir> [--project-name <name>] [--pour-fineness <1-8>]';
  const { opts, positional } = parseArgs(argv, PROJECT_SCHEMA);
  const [srcArg, dstArg] = positional;
  if (!srcArg || !dstArg) { printHelp(usage, PROJECT_SCHEMA); die('Missing <KiCadProjectDir> or <eprj3Dir>', 1); }
  const result = await convertProject(srcArg, dstArg, {
    projectName: opts['project-name'] ? String(opts['project-name']) : undefined,
    pourFineness: opts['pour-fineness'] === undefined ? 8 : Number(opts['pour-fineness']),
    log: msg => console.log(msg)
  });
  if (result.warnings > 30) console.warn(`  warn: ... ${result.warnings} warnings total`);
  if (result.failures.length) {
    console.error(`\n${result.failures.length} PCB(s) failed; the remaining project was written.`);
    process.exitCode = 1;
  }
}

function cliLibrary(argv) {
  const usage = 'kicad-to-eprj3.js convert-lib <KiCadLibDir> <output.elibz2> [--name <LibName>]';
  const schema = [{ name: 'name', hasValue: true, desc: 'Override package/elibu base name' }];
  const { opts, positional } = parseArgs(argv, schema);
  const [srcArg, dstArg] = positional;
  if (!srcArg || !dstArg) { printHelp(usage, schema); die('Missing <KiCadLibDir> or <output.elibz2>', 1); }
  convertLibrary(srcArg, dstArg, {
    name: opts.name ? String(opts.name) : undefined,
    log: msg => console.log(msg)
  });
}

function runCli() {
  const argv = process.argv;
  const sub = argv[2];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log([`kicad-to-eprj3 v${VERSION}`, '',
      'Usage:',
      '  kicad-to-eprj3.js convert <KiCadProjectDir> <eprj3Dir> [--project-name <name>] [--pour-fineness <1-8>]',
      '  kicad-to-eprj3.js convert-lib <KiCadLibDir> <output.elibz2> [--name <LibName>]',
      '  kicad-to-eprj3.js help'].join('\n'));
    return;
  }
  if (sub === 'convert') {
    cliProject(argv.slice(3)).catch(err => die(err.stack || err.message, 1));
  } else if (sub === 'convert-lib') {
    try { cliLibrary(argv.slice(3)); } catch (err) { die(err.stack || err.message, 1); }
  } else {
    die(`Unknown command: ${sub}`);
  }
}

const api = {
  version: VERSION,
  convertProject,
  convertLibrary,
  convertProjectFiles,
  zipProject,
  zipProjects,
  zipStore,
  VirtualFs
};

if (env.isNode && env.isMain) runCli();

module.exports = api;
