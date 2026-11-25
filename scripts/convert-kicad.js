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
 */

const fs = require('fs');
const path = require('path');
const { parse: parseSex, findChildValue } = require('./lib/kicad');
const { Project, uuid } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');
const { convertSchematic, readSheetNodes, readLegacySymbolInstances } = require('./lib/schematic-convert');
const { convertPcb } = require('./lib/pcb-convert');
const { getWarnCount } = require('./lib/convert-util');

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

  const src = path.resolve(srcArg);
  const dst = path.resolve(dstArg);
  if (!fs.existsSync(src)) die(`Source not found: ${src}`);
  const projectName = opts['project-name'] || path.basename(src);
  const pourFineness = opts['pour-fineness'] === undefined ? 8 : Number(opts['pour-fineness']);
  if (!Number.isInteger(pourFineness) || pourFineness < 1 || pourFineness > 8) {
    die('--pour-fineness must be an integer between 1 and 8', 1);
  }
  const project = await Project.create(dst, projectName);
  console.log(`Created eprj3 project at ${dst}`);

  // ---- schematics: KiCad hierarchy → EasyEDA hierarchy ----
  // KiCad: one root .kicad_sch; (sheet ...) nodes reference child files.
  // EasyEDA: no root page concept. Hierarchy is a block symbol (SYMBOL
  // docType 17) placed on the parent page, linked by *name* to a child
  // schematic. So each KiCad sheet file becomes its own schematic under the
  // same board, and every sheet rectangle becomes a block symbol.
  const schFiles = fs.readdirSync(src).filter(f => f.endsWith('.kicad_sch'));
  const schAbs = schFiles.map(f => path.resolve(src, f));
  const present = new Set(schAbs);

  // child references, resolved from each file's (sheet ...) nodes
  const sheetNodesByFile = new Map();
  const referenced = new Set();
  for (const abs of schAbs) {
    const nodes = readSheetNodes(abs, present);
    sheetNodesByFile.set(abs, nodes);
    for (const n of nodes) if (n.target) referenced.add(n.target);
  }
  // Roots: files no other sheet points at. Prefer the project-name file.
  let roots = schAbs.filter(abs => !referenced.has(abs));
  const preferred = schAbs.find(abs => path.basename(abs, '.kicad_sch') === projectName);
  if (preferred && roots.includes(preferred)) roots = [preferred, ...roots.filter(r => r !== preferred)];
  if (!roots.length) roots = schAbs.slice();

  // One EasyEDA schematic per unique KiCad sheet *file*. A file placed by
  // several sheets becomes a single CBB (reuse module) schematic; every sheet
  // node on the parent page places its own block symbol, so EasyEDA
  // instantiates the page per placement (REF$CBB1, REF$CBB2, ...) and expands
  // those instances in the netlist.
  const usedNames = new Set();
  const sanitize = s => (s || 'Sheet').replace(/[^\w.-]+/g, '_');
  const uniqueName = base => {
    let n = sanitize(base), i = 2;
    while (usedNames.has(n)) n = sanitize(base) + '_' + i++;
    usedNames.add(n);
    return n;
  };
  const rootUuidOf = abs => {
    try { return findChildValue(parseSex(fs.readFileSync(abs, 'utf8')), 'uuid') || ''; } catch (e) { return ''; }
  };
  const legacyRefs = new Map();
  for (const abs of schAbs) {
    for (const [k, v] of readLegacySymbolInstances(abs)) legacyRefs.set(k, v);
  }
  const pages = [];
  const pageByFile = new Map();
  const nameCache = new Map();
  const queue = [];
  const pageNameOf = abs => {
    if (!nameCache.has(abs)) nameCache.set(abs, uniqueName(path.basename(abs, '.kicad_sch')));
    return nameCache.get(abs);
  };
  const seed = (abs, instancePath, legacyPath, isChild) => {
    if (pageByFile.has(abs)) return; // the first instance defines the shared page
    const page = { abs, schName: pageNameOf(abs), instancePath, legacyPath, isChild, children: [] };
    pageByFile.set(abs, page);
    pages.push(page);
    const nodes = sheetNodesByFile.get(abs) || [];
    for (const n of nodes) {
      page.children.push({ node: n, schName: n.target ? pageNameOf(n.target) : null });
      if (n.target) queue.push({
        abs: n.target,
        instancePath: instancePath + '/' + (n.uuid || ''),
        legacyPath: legacyPath + (n.uuid || '') + '/',
        isChild: true
      });
    }
  };
  for (const abs of roots) seed(abs, '/' + (rootUuidOf(abs) || uuid(8)), '/', false);
  while (queue.length) {
    const item = queue.shift();
    seed(item.abs, item.instancePath, item.legacyPath, item.isChild);
  }
  // Files not reachable from any root still get converted (standalone sheets).
  for (const abs of schAbs) {
    if (pageByFile.has(abs)) continue;
    seed(abs, '/' + (rootUuidOf(abs) || uuid(8)), '/', false);
    while (queue.length) {
      const item = queue.shift();
      seed(item.abs, item.instancePath, item.legacyPath, item.isChild);
    }
  }

  const pageCount = pages.length;
  for (const page of pages) {
    const abs = page.abs;
    const schName = page.schName;
    const sch = project.ensureSchematic(schName);
    const sheet = project.ensureSheet(sch, schName);
    const file = project.sheetFile(sheet);
    convertSchematic(abs, file, sch, sheet, {
      projectName, pageCount, project, instancePath: page.instancePath,
      legacyPath: page.legacyPath, legacyRefs, sheetNodes: page.children
    });
    // A CBB child must not keep a schematic-config .ecfg: when the .ecfg's
    // first document is the SCH config the client stops expanding the CBB in
    // the netlist. The block symbol lives in the parent page and in
    // profile.blockSymbols; the client rebuilds the child config on open.
    if (page.isChild) {
      const ecfg = path.join(project.rootDir, 'sch', schName, `${schName}.ecfg`);
      fs.writeFileSync(ecfg, '');
    }
    project.save();
    console.log(`  sch: ${path.basename(abs)} -> ${file}`);
  }

  // Walk PCBs
  const pcbs = fs.readdirSync(src).filter(f => f.endsWith('.kicad_pcb'));
  let pcbIdx = 1;
  const failures = [];
  for (const pcbFile of pcbs) {
    const pcb = project.ensurePcb(`PCB${pcbIdx++}`);
    const file = project.pcbFile(pcb);
    try {
      convertPcb(path.join(src, pcbFile), file, pcb, { pourFineness });
      project.save();
      console.log(`  pcb: ${pcbFile} -> ${file}`);
    } catch (e) {
      // Keep one bad board from aborting the whole batch: drop its index entry
      // and partial file, report it, and continue with the remaining boards.
      delete project.profile.profile.pcbs[pcb.uuid];
      project.save();
      try { fs.unlinkSync(file); } catch (_) { /* nothing was written */ }
      failures.push({ file: pcbFile, message: e.message });
      console.error(`  pcb: ${pcbFile} FAILED: ${e.message}`);
    }
  }

  if (getWarnCount() > 30) console.warn(`  warn: ... ${getWarnCount()} warnings total`);
  if (failures.length) {
    console.error(`\n${failures.length} PCB(s) failed; the remaining project was written.`);
    process.exitCode = 1;
  }
}

main().catch(err => die(err.stack || err.message, 1));
