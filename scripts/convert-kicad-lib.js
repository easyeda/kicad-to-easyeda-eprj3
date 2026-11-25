#!/usr/bin/env node
'use strict';
/**
 * convert-kicad-lib.js — Convert KiCad libraries into one EasyEDA Pro
 *                       library package (.elibz2).
 *
 * Usage:
 *   node scripts/convert-kicad-lib.js convert <KiCadLibDir> <output.elibz2> [--name <LibName>]
 *
 * The directory is scanned for:
 *   - *.kicad_sym            symbol libraries  → SYMBOL docs + devices
 *   - *.pretty/*.kicad_mod   footprint libraries → FOOTPRINT docs
 * Symbols whose Footprint property matches a converted footprint name are
 * linked to it in device2.json automatically.
 *
 * The conversion flow lives in lib/convert-lib.js (shared with the standalone
 * build); this file is only the Node CLI wrapper.
 */
const { parseArgs, printHelp, die } = require('./lib/utils');
const { convertLibrary } = require('./lib/convert-lib');

const schema = [{ name: 'name', hasValue: true, desc: 'Override package/elibu base name' }];

function main() {
  const usage = 'convert-kicad-lib.js convert <KiCadLibDir> <output.elibz2> [--name <LibName>]';
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp(usage, schema); process.exit(sub ? 0 : 1); }
  if (sub !== 'convert') die(`Unknown command: ${sub}`);
  const { opts, positional } = parseArgs(process.argv.slice(3), schema);
  const [srcArg, dstArg] = positional;
  if (!srcArg || !dstArg) { printHelp(usage, schema); die('Missing <KiCadLibDir> or <output.elibz2>', 1); }

  try {
    convertLibrary(srcArg, dstArg, {
      name: opts.name ? String(opts.name) : undefined,
      log: msg => console.log(msg)
    });
  } catch (err) {
    die(err && err.message ? err.message : String(err));
  }
}

main();
