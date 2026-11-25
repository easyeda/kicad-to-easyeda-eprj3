'use strict';
/**
 * convert-project.js — KiCad project → eprj3 project conversion flow.
 *
 * Extracted from convert-kicad.js so the same code can run under Node (real
 * fs/path) and in the browser build (virtual fs supplied by the host). The
 * caller supplies a `log` callback; the module never touches process.argv or
 * process.exit.
 */

const fs = require('fs');
const path = require('path');
const { parse: parseSex, findChildValue } = require('./kicad');
const { Project, uuid } = require('./eprj3');
const { convertSchematic, readSheetNodes, readLegacySymbolInstances } = require('./schematic-convert');
const { convertPcb } = require('./pcb-convert');
const { getWarnCount } = require('./convert-util');

async function convertProject(srcArg, dstArg, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const src = path.resolve(srcArg);
  const dst = path.resolve(dstArg);
  if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`);
  const projectName = opts.projectName || path.basename(src);
  const pourFineness = opts.pourFineness === undefined ? 8 : Number(opts.pourFineness);
  if (!Number.isInteger(pourFineness) || pourFineness < 1 || pourFineness > 8) {
    throw new Error('pourFineness must be an integer between 1 and 8');
  }
  const project = await Project.create(dst, projectName);
  log(`Created eprj3 project at ${dst}`);

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
  const schematics = [];
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
    schematics.push({ file: path.basename(abs), schematic: schName, output: file });
    log(`  sch: ${path.basename(abs)} -> ${file}`);
  }

  // Walk PCBs
  const pcbs = fs.readdirSync(src).filter(f => f.endsWith('.kicad_pcb'));
  let pcbIdx = 1;
  const failures = [];
  const pcbResults = [];
  for (const pcbFile of pcbs) {
    const pcb = project.ensurePcb(`PCB${pcbIdx++}`);
    const file = project.pcbFile(pcb);
    try {
      convertPcb(path.join(src, pcbFile), file, pcb, { pourFineness });
      project.save();
      pcbResults.push({ file: pcbFile, output: file, failed: false });
      log(`  pcb: ${pcbFile} -> ${file}`);
    } catch (e) {
      // Keep one bad board from aborting the whole batch: drop its index entry
      // and partial file, report it, and continue with the remaining boards.
      delete project.profile.profile.pcbs[pcb.uuid];
      project.save();
      try { fs.unlinkSync(file); } catch (_) { /* nothing was written */ }
      failures.push({ file: pcbFile, message: e.message });
      pcbResults.push({ file: pcbFile, output: null, failed: true, message: e.message });
      log(`  pcb: ${pcbFile} FAILED: ${e.message}`);
    }
  }

  return {
    src, dst, projectName,
    schematics, pcbs: pcbResults, failures,
    warnings: getWarnCount()
  };
}

module.exports = { convertProject };
