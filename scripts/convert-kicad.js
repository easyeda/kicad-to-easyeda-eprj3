#!/usr/bin/env node
'use strict';
/**
 * convert-kicad.js — Convert a KiCad project (.kicad_pro + .kicad_sch + .kicad_pcb)
 *                    into an eprj3 project.
 *
 * Usage:
 *   node scripts/convert-kicad.js convert <KiCadProjectDir> <eprj3Dir> [--project-name <name>]
 *
 * The converter emits:
 *   - <dst>/<name>.eprj3                    project index
 *   - <dst>/sch/<Schematic1>/{P1.esch2,<name>.ecfg,<name>.evar}
 *         .esch2 embeds one SYMBOL doc + one DEVICE doc per used lib_id, then the
 *         SCH_PAGE doc whose DOCHEAD uuid equals the index' sheet uuid
 *   - <dst>/pcb/<PCB1>.epcb2
 *         embeds FOOTPRINT + DEVICE docs per used footprint, then the PCB doc
 *         (uuid == index' pcb uuid)
 *
 * Primitive coverage (per KiCad file-format docs → EasyEDA file-format docs):
 *   Schematic: wire→WIRE+LINE, bus→BUS+LINE, bus_entry→BUSENTRY,
 *     junction→wire split only (no dot), no_connect→LINE×2,
 *     label→NET attr, global_label→net flag, hierarchical_label→net port,
 *     text/text_box→TEXT(+RECT), polyline/rectangle/circle/arc/bezier→POLY/RECT/
 *     CIRCLE/ARC/BEZIER, image→OBJ, hierarchical sheet→reuse block COMPONENT
 *     (SYMBOL docType 17) linked to the child schematic,
 *     symbol→COMPONENT(+ATTR)
 *   PCB: segment→LINE (copper track), arc(track)→ARC, via→VIA, footprint→FOOTPRINT doc
 *     + COMPONENT + PAD_NET, gr_line→LINE, gr_arc→ARC (Edge.Cuts arcs are
 *     flattened and chained into one outline), gr_rect/gr_poly/gr_circle/
 *     bezier/gr_curve→POLY (sampled; the host outline decoder rejects 'C'),
 *     gr_text→STRING, zone→POUR+POURED (keepout→REGION),
 *     dimension→DIMENSION, Edge.Cuts→POLY BOARD_OUTLINE
 * Not migrated: 3D models, net classes, SPICE models, custom rules; anything
 * unrecognized is skipped with a warning.
 *
 * The conversion flow lives in lib/convert-project.js (shared with the
 * browser/standalone build); this file is only the Node CLI wrapper.
 */

const { parseArgs, printHelp, die } = require('./lib/utils');
const { convertProject } = require('./lib/convert-project');

const schema = [
  { name: 'project-name', hasValue: true, desc: 'Override project name' },
  { name: 'pour-fineness', hasValue: true, desc: 'Copper pour fill fineness 1-8 (default 8; lower is faster/coarser)' }
];

async function main() {
  const usage = 'convert-kicad.js convert <KiCadProjectDir> <eprj3Dir> [--project-name <name>] [--pour-fineness <1-8>]';
  const sub = process.argv[2];
  if (!sub || sub === 'help') { printHelp(usage, schema); process.exit(sub ? 0 : 1); }
  if (sub !== 'convert') die(`Unknown command: ${sub}`);
  const { opts, positional } = parseArgs(process.argv.slice(3), schema);
  const [srcArg, dstArg] = positional;
  if (!srcArg || !dstArg) { printHelp(usage, schema); die('Missing <KiCadProjectDir> or <eprj3Dir>', 1); }

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

main().catch(err => die(err.stack || err.message, 1));
