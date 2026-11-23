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
 *   Schematic: wire→WIRE+LINE, bus→BUS+LINE, bus_entry→BUSENTRY, junction→CIRCLE,
 *     no_connect→LINE×2, label/global_label/hierarchical_label→NETLABEL,
 *     text/text_box→TEXT(+RECT), polyline/rectangle/circle/arc/bezier→POLY/RECT/
 *     CIRCLE/ARC/BEZIER, image→OBJ, hierarchical sheet→RECT+TEXT+NETLABEL,
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
const { parse: parseSex, nodeSymbol, extractPts, extractPads } = require('./lib/kicad');
const {
  buildSymbolRecords, buildFootprintRecords, buildBlockSymbolRecords, buildNetportSymbolRecords, kicadToEprj3, flipY,
  kicadToSchUnit, flipYSch, arcSweep, mapStroke, mapFill
} = require('./lib/kicad-to-eprj3');
const { Project, uuid, randId, writeRecords, sheetDocRecords } = require('./lib/eprj3');
const { findViolation } = require('./lib/hostpath');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'project-name', hasValue: true, desc: 'Override project name' },
  { name: 'pour-fineness', hasValue: true, desc: 'Copper pour fill fineness 1-8 (default 8; lower is faster/coarser)' }
];

// PCB positions are mil; schematic positions are 0.254 mm units.
function toMil(x) { return kicadToEprj3(parseFloat(x)); }
function toSch(x) { return kicadToSchUnit(parseFloat(x)); }

// eprj3 page height in sch units per KiCad paper size. A4 (1170×825) is
// verified against official exports; the rest follow the same √2 A-series
// proportions the EasyEDA template uses.
const PAGE_HEIGHT_UNITS = { A4: 825, A3: 1167, A2: 1651, A1: 2334, A0: 3301, A: 550, B: 848, C: 1100, D: 1550, E: 2200 };
// KiCad paper sizes in mm (page_info.cpp / standardPageSizes)
const PAPER_SIZE_MM = {
  A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6]
};
const MAGIC_PART_ID = 'pid8a0e77bacb214e'; // built-in power flags & sheet frame share this part id
const FRAME_TEMPLATE = require('./lib/frame-a4.json'); // extracted from a real EasyEDA export
// Static PCB editor config (PRIMITIVE/LAYER_PHYS/RULE*/SILK_OPTS/D3_ATTRIBUTE/
// PREFERENCE/PANELIZE) — the client hangs without it; extracted from a real export.
const PCB_CONFIG = require('./lib/pcb-config.json');

function docHead(docType, docUuid) {
  return { head: { type: 'DOCHEAD' }, body: { docType, client: uuid(16), uuid: docUuid, updateTime: Date.now(), version: String(Date.now()), editVersion: '4.1.36', user: {} } };
}

function metaRec(title, extra = {}) {
  return { head: { type: 'META', ticket: 1, id: 'META' }, body: { title, description: '', tags: [], source: '', ...extra } };
}

// The A4 frame template carries fixed document uuids. Each page must embed its
// own copy: the project scanner indexes documents by uuid across all .esch2
// files and rejects duplicates when opening. References to the old uuids
// (frame Symbol/Device ATTRs) are remapped along with the DOCHEADs.
function instantiateFrameTemplate() {
  const oldSymbol = FRAME_TEMPLATE.symbol.find(r => r.type === 'DOCHEAD').body.uuid;
  const oldDevice = FRAME_TEMPLATE.device.find(r => r.type === 'DOCHEAD').body.uuid;
  const symbolUuid = uuid(16);
  const deviceUuid = uuid(16);
  const remap = r => JSON.parse(JSON.stringify(r)
    .split(oldSymbol).join(symbolUuid).split(oldDevice).join(deviceUuid));
  return {
    symbol: FRAME_TEMPLATE.symbol.map(remap),
    device: FRAME_TEMPLATE.device.map(remap),
    pageAttrs: FRAME_TEMPLATE.pageAttrs.map(remap),
    symbolUuid, deviceUuid
  };
}

function findSub(node, key) {
  for (const it of node.slice(1)) if (Array.isArray(it) && it[0].v === key) return it.slice(1).map(x => x.v);
  return null;
}

function findSubNode(node, key) {
  for (const it of node.slice(1)) if (Array.isArray(it) && it[0].v === key) return it;
  return null;
}

function findChildValue(node, key) {
  for (const it of node.slice(1)) if (Array.isArray(it) && it[0].v === key && it[1]) return it[1].v;
  return null;
}

let ggeCounter = 0;
let warnCounter = 0;
function warn(msg) {
  if (++warnCounter <= 30) console.warn(`  warn: ${msg}`);
}

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

  // One EasyEDA schematic per used KiCad sheet *instance*. A sheet file placed
  // twice (reused hierarchy) is instantiated twice, so each instance keeps its
  // own designators and connectivity instead of sharing one page.
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
  const pages = [];
  const seenPaths = new Set();
  const walk = (abs, instancePath, schName) => {
    const nodes = sheetNodesByFile.get(abs) || [];
    const children = nodes.map(node => ({ node, schName: null }));
    pages.push({ abs, schName, instancePath, children });
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.target) continue;
      const childPath = instancePath + '/' + (n.uuid || uuid(8));
      if (seenPaths.has(childPath)) continue;
      seenPaths.add(childPath);
      // Name pages after the sheet file (matching KiCad's file-based page
      // identity); reused files get a _2/_3 suffix per instance.
      const childName = uniqueName(path.basename(n.target, '.kicad_sch'));
      children[i].schName = childName;
      walk(n.target, childPath, childName);
    }
  };
  for (const abs of roots) {
    const path0 = '/' + (rootUuidOf(abs) || uuid(8));
    if (seenPaths.has(path0)) continue;
    seenPaths.add(path0);
    walk(abs, path0, uniqueName(path.basename(abs, '.kicad_sch')));
  }
  // Files not reachable from any root still get converted (standalone sheets).
  for (const abs of schAbs) {
    if (pages.some(p => p.abs === abs)) continue;
    walk(abs, '/' + (rootUuidOf(abs) || uuid(8)), uniqueName(path.basename(abs, '.kicad_sch')));
  }

  const pageCount = pages.length;
  for (const page of pages) {
    const abs = page.abs;
    const schName = page.schName;
    const sch = project.ensureSchematic(schName);
    const sheet = project.ensureSheet(sch, schName);
    const file = project.sheetFile(sheet);
    convertSchematic(abs, file, sch, sheet, {
      projectName, pageCount, project, instancePath: page.instancePath, sheetNodes: page.children
    });
    // The parent page registered this schematic's block symbol; the client
    // keeps that symbol inside the schematic's own .ecfg document.
    const ownBlock = project.__blockDocs && project.__blockDocs.get(schName);
    if (ownBlock) {
      const ecfg = path.join(project.rootDir, 'sch', schName, `${schName}.ecfg`);
      fs.appendFileSync(ecfg,
        ownBlock.map(r => JSON.stringify(r.head) + '||' + JSON.stringify(r.body) + '|').join('\n') + '\n');
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

  if (warnCounter > 30) console.warn(`  warn: ... ${warnCounter} warnings total`);
  if (failures.length) {
    console.error(`\n${failures.length} PCB(s) failed; the remaining project was written.`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- schematic

function convertSchematic(srcFile, dst, sch, sheet, opts = {}) {
  const root = parseSex(fs.readFileSync(srcFile, 'utf8'));

  const paper = findChildValue(root, 'paper') || 'A4';
  const pageH = PAGE_HEIGHT_UNITS[paper] || PAGE_HEIGHT_UNITS.A4;
  if (!PAGE_HEIGHT_UNITS[paper]) warn(`unknown paper "${paper}", using A4 page height`);
  const pageCount = opts.pageCount || 1;

  // KiCad title_block → the frame's title-block attrs (Company/Drawed/Version).
  const titleBlock = root.slice(1).find(n => Array.isArray(n) && n[0].v === 'title_block');
  const tb = {};
  if (titleBlock) {
    const company = findChildValue(titleBlock, 'company');
    const date = findChildValue(titleBlock, 'date');
    const rev = findChildValue(titleBlock, 'rev');
    if (company) tb.Company = company;
    if (date) tb.Drawed = date;
    if (rev) tb.Version = rev;
  }
  // Values for the KiCad default title-block texts (%x format substitutions).
  const kicadFrameFields = {
    date: (titleBlock && findChildValue(titleBlock, 'date')) || '',
    rev: (titleBlock && findChildValue(titleBlock, 'rev')) || '',
    title: (titleBlock && findChildValue(titleBlock, 'title')) || '',
    company: (titleBlock && findChildValue(titleBlock, 'company')) || '',
    version: findChildValue(root, 'generator_version') || '',
    file: srcFile.split(/[\\/]/).pop() || '',
    comments: (() => {
      const out = {};
      if (titleBlock) for (const it of titleBlock.slice(1)) {
        if (Array.isArray(it) && it[0].v === 'comment') out[it[1]?.v] = it[2]?.v || '';
      }
      return out;
    })()
  };
  // KiCad sheet (Y-down, origin top-left) → eprj3 page (Y-down, origin at the
  // frame's bottom-left corner): only a constant downward shift, no flip.
  const pageY = v => flipYSch(v, pageH);

  // lib_symbols: top-level entries are keyed by full lib_id (e.g. "Device:R")
  const libNodes = {};
  for (const node of root.slice(1)) {
    if (Array.isArray(node) && node[0].v === 'lib_symbols') {
      for (const symNode of node.slice(1)) {
        if (Array.isArray(symNode) && symNode[0].v === 'symbol') {
          const key = symNode[1]?.v || '';
          if (key) libNodes[key] = symNode;
        }
      }
    }
  }

  // KiCad 10 disambiguates multiple embedded symbols with the same base name by
  // appending _<n> (e.g. DIODE_1) while instances still reference the base
  // lib_id (Simulation_SPICE:DIODE). Fall back to that base-name match.
  function findLibNode(libId) {
    const short = libId.split(':').pop();
    if (libNodes[libId]) return libNodes[libId];
    if (libNodes[short]) return libNodes[short];
    for (const key of Object.keys(libNodes)) {
      if (key.split(':').pop().replace(/_\d+$/, '') === short) return libNodes[key];
    }
    return null;
  }

  const libDocs = [];
  const symbolDocs = new Map(); // libId -> one SYMBOL doc holding every used PART/unit
  const usedDevices = {};
  function ensureSymbolDoc(libId, footprintName, unit = 1, forcedPower = false) {
    const shortName = libId.split(':').pop();
    const libNode = findLibNode(libId);
    const libSym = libNode ? nodeSymbol(libNode, unit) : null;
    const name = (libSym && libSym.name) || shortName;
    // Power/net-identifier symbols live in project libraries too; the
    // (power) marker in the lib_symbols entry is authoritative, not the
    // "power:" lib_id prefix.
    const isPower = forcedPower || /^power:/i.test(libId) || !!(libSym && libSym.isPower);
    const netName = isPower ? ((libSym && libSym.properties && libSym.properties.Value) || shortName) : null;

    // Multi-unit symbols must live in ONE SYMBOL document with one PART per
    // unit (EDA multi-part). Separate docs with the same partId made the
    // netlist drop the device entirely.
    const docKey = libId + (forcedPower ? ' P' : '');
    let doc = symbolDocs.get(docKey);
    if (!doc) {
      doc = {
        uuid: uuid(16),
        name, isPower, netName, nameOff: null,
        records: [
          docHead('SYMBOL', uuid(16)),
          isPower
            ? { head: { type: 'META', ticket: 1, id: 'META' }, body: { title: name, description: '', tags: ['特殊器件', '网络标识'], docType: 18, source: '' } }
            : metaRec(name, { docType: 2 })
        ],
        parts: new Map(),
        unitPins: new Map()
      };
      // keep DOCHEAD uuid in sync with the doc uuid
      doc.records[0].body.uuid = doc.uuid;
      symbolDocs.set(docKey, doc);
      libDocs.push({ __symbolDoc: doc });
    }
    let partId = doc.parts.get(unit);
    if (!partId) {
      partId = isPower ? MAGIC_PART_ID : name + '.' + unit;
      const { records, nameOff } = buildSymbolRecords(libSym || { name, pins: [], shapes: [] }, {
        partId,
        partTitle: isPower ? '' : partId,
        isPower,
        netName
      });
      // Extra units contribute only their PART block; CANVAS and the doc-level
      // Device/Symbol attrs are written once.
      const recs = doc.parts.size
        ? records.filter(r => r.head.type !== 'CANVAS'
            && !(r.head.type === 'ATTR' && r.body && r.body.parentId === ''))
        : records;
      doc.records.push(...recs);
      doc.parts.set(unit, partId);
      doc.unitPins.set(unit, (libSym && libSym.pins) || []);
      if (nameOff) doc.nameOff = nameOff;
    }
    const sym = { symDocUuid: doc.uuid, partId, name, isPower, netName, nameOff: doc.nameOff, pins: doc.unitPins.get(unit) || [] };

    // One DEVICE per (symbol, footprint): the same KiCad symbol can be placed
    // with different Footprint properties (R1/R2), and each component must bind
    // to a device whose FootprintName matches. All units share the device.
    const fp = footprintName || '';
    const devKey = libId + '\u0000' + fp;
    let dev = usedDevices[devKey];
    if (!dev) {
      const devUuid = uuid(16);
      const fpJson = fp ? JSON.stringify({ name: fp, uuid: '', source: '' }) : null;
      libDocs.push(
        docHead('DEVICE', devUuid),
        metaRec(sym.name, {
          images: [],
          attributes: sym.isPower
            ? { Symbol: sym.symDocUuid, 'Global Net Name': sym.netName, Description: '', Name: sym.netName, SymbolName: JSON.stringify({ name: sym.name, uuid: sym.symDocUuid, source: '' }) }
            : {
                Symbol: sym.symDocUuid,
                SymbolName: JSON.stringify({ name: sym.name, uuid: sym.symDocUuid, source: '' }),
                FootprintName: fpJson,
                Footprints: '[]'
              }
        })
      );
      dev = { devUuid };
      usedDevices[devKey] = dev;
    }
    return { ...sym, devUuid: dev.devUuid };
  }

  const pageRecords = sheetDocRecords(sch, sheet); // DOCHEAD SCH_PAGE + META + CANVAS
  let ticket = 2;
  let busEntryOrder = 0;
  let componentZ = 0; // placed components need a real zIndex (official exports use 1,2,3…)
  const rec = (type, body, id) => {
    ticket++;
    pageRecords.push({ head: { type, ticket, id: id || randId() }, body: { ...body, zIndex: body.zIndex != null ? body.zIndex : ticket } });
  };

  // KiCad sheet rectangle → EasyEDA block symbol (SYMBOL docType 17) linked by
  // name to the child schematic. The block symbol is appended to the page's
  // embedded docs; the rectangle is placed as a COMPONENT on this page.
  const embeddedBlocks = new Map();
  const emitSheetBlock = entry => {
    const info = entry && entry.node;
    if (!info || !info.target) {
      warn(`schematic: sheet "${info && info.sheetName || '?'}" target file not found, skipped`);
      return;
    }
    const childName = entry.schName;
    if (!childName) { warn(`schematic: no schematic for sheet file ${info.sheetFile}`); return; }
    const W = toSch(info.w), H = toSch(info.h);
    // One block symbol per child schematic per page (same schematic placed
    // twice on one page shares it). Each page embeds its own copy with a fresh
    // document uuid so the project scanner sees no duplicate documents.
    const project = opts.project;
    let blockUuid = embeddedBlocks.get(childName);
    if (!blockUuid) {
      blockUuid = uuid(16);
      embeddedBlocks.set(childName, blockUuid);
      project.profile.profile.blockSymbols = project.profile.profile.blockSymbols || {};
      project.profile.profile.blockSymbols[blockUuid] = {
        uuid: blockUuid, title: childName, docType: 17, source: '',
        version: String(Date.now()), updateTime: Date.now()
      };
      const EPS = 0.01;
      const pins = (info.pins || []).map((p, i) => {
        let lx, ly, rot;
        if (Math.abs(p.x - info.x) < EPS) { lx = -W / 2; ly = H / 2 - toSch(p.y - info.y); rot = 0; }
        else if (Math.abs(p.x - (info.x + info.w)) < EPS) { lx = W / 2; ly = H / 2 - toSch(p.y - info.y); rot = 180; }
        else if (Math.abs(p.y - info.y) < EPS) { lx = toSch(p.x - info.x) - W / 2; ly = H / 2; rot = 90; }
        else if (Math.abs(p.y - (info.y + info.h)) < EPS) { lx = toSch(p.x - info.x) - W / 2; ly = -H / 2; rot = 270; }
        else {
          // Fall back to the pin angle (outward normal, KiCad Y-down).
          const edge = ((p.angle % 360) + 360) % 360;
          if (edge === 0) { lx = W / 2; ly = H / 2 - toSch(p.y - info.y); rot = 180; }
          else if (edge === 90) { lx = toSch(p.x - info.x) - W / 2; ly = H / 2; rot = 90; }
          else if (edge === 270) { lx = toSch(p.x - info.x) - W / 2; ly = -H / 2; rot = 270; }
          else { lx = -W / 2; ly = H / 2 - toSch(p.y - info.y); rot = 0; }
        }
        return { name: p.name, number: i + 1, type: p.type, x: lx, y: ly, rotation: rot, length: 10 };
      });
      // The placed block component references an embedded copy in the parent
      // page; the child schematic's .ecfg stores the schematic's own block
      // symbol (the CBB interface). The two copies must use different document
      // uuids or the CLI rejects the project as a duplicate document.
      const blockDocRecords = [
        docHead('SYMBOL', blockUuid),
        metaRec(childName, { docType: 17 }),
        ...buildBlockSymbolRecords({ title: childName, width: W, height: H, pins })
      ];
      libDocs.push(...blockDocRecords);
      const ecfgRecs = JSON.parse(JSON.stringify(blockDocRecords));
      ecfgRecs[0].body.uuid = uuid(16);
      project.__blockDocs = project.__blockDocs || new Map();
      if (!project.__blockDocs.has(childName)) project.__blockDocs.set(childName, ecfgRecs);
    }
    const compId = randId();
    const cx = toSch(info.x) + W / 2;
    const cy = pageY(info.y) + H / 2;
    opts.project.__cbbCounter = (opts.project.__cbbCounter || 0) + 1;
    ticket++;
    pageRecords.push({
      head: { type: 'COMPONENT', ticket, id: compId },
      body: {
        partId: '1', x: cx, y: cy, rotation: 0, isMirror: false,
        attrs: {}, zIndex: ++componentZ
      }
    });
    const topY = pageY(info.y);
    const bottomY = pageY(info.y + info.h);
    const leftX = toSch(info.x);
    const pos = (key, value, x, y, align, visible) => {
      pageRecords.push(pageAttr(compId, ++ticket, key, value, x, y, align, { valueVisible: visible }));
    };
    pos('Symbol', blockUuid, cx, cy, 'LEFT_BOTTOM', false);
    pos('Name', childName, cx, cy, 'LEFT_BOTTOM', false);
    pos('Designator', 'CBB' + opts.project.__cbbCounter, cx, cy, 'LEFT_BOTTOM', false);
    if (info.sheetName) pos('Sheetname', info.sheetName, leftX, topY - 2.8, 'LEFT_BOTTOM', true);
    if (info.sheetFile) pos('Sheetfile', info.sheetFile, leftX, bottomY + 2.3, 'LEFT_TOP', true);
  };
  // EasyEDA does not join two pins that merely sit on the same point (KiCad
  // does); a wire touching that point connects them. KiCad power symbols are
  // placed directly on pins, so give every power flag / net port a 1-unit stub.
  const emitPinStub = (cx, cy) => {
    const groupId = randId();
    ticket++;
    pageRecords.push({ head: { type: 'WIRE', ticket, id: groupId }, body: { zIndex: ticket } });
    ticket++;
    pageRecords.push({
      head: { type: 'LINE', ticket, id: randId() },
      body: {
        fillColor: null, fillStyle: 'NONE', strokeColor: null, strokeStyle: 'SOLID', strokeWidth: null,
        startX: cx, startY: cy, endX: cx, endY: cy + 1, lineGroup: groupId
      }
    });
    return groupId;
  };

  // Hidden power_in pins (e.g. 74HC04 pins 7/14) are invisible global net
  // connections in KiCad. EasyEDA has no implicit power-pin nets, so place a
  // netflag component bound to the pin name at each such pin.
  const netflagDocs = new Map();
  function ensureNetflagDoc(netName) {
    let d = netflagDocs.get(netName);
    if (d) return d;
    const symUuid = uuid(16);
    const devUuid = uuid(16);
    const synthetic = {
      name: netName, isPower: true, properties: { Value: netName },
      pins: [{ name: netName, number: '1', x: 0, y: 0, rotation: 90, length: 0, electric: 'power_in', style: 'line' }],
      shapes: []
    };
    const { records } = buildSymbolRecords(synthetic, {
      partId: MAGIC_PART_ID, partTitle: '', isPower: true, netName
    });
    libDocs.push(
      docHead('SYMBOL', symUuid),
      { head: { type: 'META', ticket: 1, id: 'META' }, body: { title: netName, description: '', tags: ['特殊器件', '网络标识'], docType: 18, source: '' } },
      ...records,
      docHead('DEVICE', devUuid),
      metaRec(netName, { images: [], attributes: { Symbol: symUuid, 'Global Net Name': netName, Description: '', Name: netName, SymbolName: JSON.stringify({ name: netName, uuid: symUuid, source: '' }) } })
    );
    d = { symUuid, devUuid, netName };
    netflagDocs.set(netName, d);
    return d;
  }
  const placeHiddenPowerPins = (pins, node, mirrors, rot) => {
    const [sx, sy] = findAtXY(node);
    const a = ((rot || 0) % 360) * Math.PI / 180;
    const c = Math.cos(a), sn = Math.sin(a);
    for (const pin of pins || []) {
      if (pin.electric !== 'power_in' || !pin.hide || !pin.name) continue;
      let px = pin.x, py = pin.y;
      if (mirrors.includes('y')) px = -px;
      if (mirrors.includes('x')) py = -py;
      const vx = px, vy = -py;
      const X = toSch(sx + vx * c + vy * sn);
      const Y = pageY(sy - vx * sn + vy * c);
      const d = ensureNetflagDoc(pin.name);
      const compId = randId();
      ticket++;
      pageRecords.push({
        head: { type: 'COMPONENT', ticket, id: compId },
        body: { partId: MAGIC_PART_ID, x: X, y: Y, rotation: 0, isMirror: false,
          attrs: { Footprints: '[]', Devices: '[]', DeviceName: null, FootprintName: null }, zIndex: ++componentZ }
      });
      const vis = { fontSize: null, keyVisible: null, valueVisible: null };
      pageRecords.push(pageAttr(compId, ++ticket, 'Symbol', d.symUuid, X, Y + 10, null, vis));
      pageRecords.push(pageLinkAttr(compId, ++ticket, 'Device', d.devUuid));
      pageRecords.push(pageLinkAttr(compId, ++ticket, 'Relevance', '[]'));
      pageRecords.push(pageAttr(compId, ++ticket, 'Name', pin.name, X, Y + 10, 'CENTER_TOP', vis));
      pageRecords.push(pageAttr(compId, ++ticket, 'Global Net Name', pin.name, X, Y + 10, 'CENTER_TOP', vis));
      emitPinStub(X, Y);
    }
  };

  // Wires: KiCad connectivity is geometric across *all* wire segments, while
  // EasyEDA only joins LINEs that belong to the same WIRE group. Emit one
  // WIRE/BUS group per connected wire network (splitting segments at KiCad
  // junctions), otherwise every KiCad wire becomes an isolated net.
  const emittedWireGroups = [];
  const emitAllWires = () => {    const raw = [];
    for (const node of root.slice(1)) {
      if (!Array.isArray(node) || (node[0].v !== 'wire' && node[0].v !== 'bus')) continue;
      const kind = node[0].v;
      const pts = extractWirePoints(node);
      for (let i = 0; i + 1 < pts.length; i++) raw.push({ kind, a: pts[i], b: pts[i + 1] });
    }
    if (!raw.length) return emittedWireGroups;
    const junctions = [];
    for (const node of root.slice(1)) {
      if (Array.isArray(node) && node[0].v === 'junction') {
        const at = findSub(node, 'at');
        if (at) junctions.push([parseFloat(at[0]), parseFloat(at[1])]);
      }
    }
    const segs = [];
    for (const s of raw) {
      const [ax, ay] = s.a, [bx, by] = s.b;
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
      if (!len2) continue;
      const ts = [];
      for (const [jx, jy] of junctions) {
        const t = ((jx - ax) * (bx - ax) + (jy - ay) * (by - ay)) / len2;
        if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        if (Math.hypot(ax + (bx - ax) * t - jx, ay + (by - ay) * t - jy) > 1e-6) continue;
        ts.push(t);
      }
      ts.sort((p, q) => p - q);
      let prev = s.a;
      for (const t of ts) {
        const p = [ax + (bx - ax) * t, ay + (by - ay) * t];
        segs.push({ kind: s.kind, a: prev, b: p });
        prev = p;
      }
      segs.push({ kind: s.kind, a: prev, b: s.b });
    }
    const pkey = (kind, p) => kind + ':' + p[0].toFixed(6) + ',' + p[1].toFixed(6);
    const parent = new Map();
    const find = k => {
      if (!parent.has(k)) parent.set(k, k);
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r);
      while (parent.get(k) !== r) { const n = parent.get(k); parent.set(k, r); k = n; }
      return r;
    };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (const s of segs) union(pkey(s.kind, s.a), pkey(s.kind, s.b));
    const groups = new Map();
    for (const s of segs) {
      const r = find(pkey(s.kind, s.a));
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(s);
    }
    for (const list of groups.values()) {
      const kind = list[0].kind;
      const groupId = randId();
      ticket++;
      pageRecords.push({ head: { type: kind === 'wire' ? 'WIRE' : 'BUS', ticket, id: groupId }, body: { zIndex: ticket } });
      for (const s of list) {
        ticket++;
        pageRecords.push({
          head: { type: 'LINE', ticket, id: randId() },
          body: {
            fillColor: null, fillStyle: 'NONE', strokeColor: null, strokeStyle: 'SOLID', strokeWidth: null,
            startX: toSch(s.a[0]), startY: pageY(s.a[1]),
            endX: toSch(s.b[0]), endY: pageY(s.b[1]),
            lineGroup: groupId
          }
        });
      }
      emittedWireGroups.push({ groupId, kind, segs: list });
    }
    return emittedWireGroups;
  };
  const wireGroups = emitAllWires();
  // Which WIRE/BUS group owns a point (KiCad labels attach anywhere on a wire)?
  const wireGroupAt = (x, y) => {
    for (const g of wireGroups) {
      for (const s of g.segs) {
        const [ax, ay] = s.a, [bx, by] = s.b;
        const len = Math.hypot(bx - ax, by - ay);
        if (!len) continue;
        const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
        if (Math.abs(cross) / len > 1e-6) continue;
        const dot = (x - ax) * (bx - ax) + (y - ay) * (by - ay);
        if (dot >= -1e-6 && dot <= len * len + 1e-6) return g.groupId;
      }
    }
    return null;
  };

  let sheetNodeIdx = 0;

  // KiCad hierarchical_label → EasyEDA net port (SYMBOL docType 19). Net ports
  // are the child page side of the parent's block-symbol pins; without them the
  // hierarchy is not electrically connected.
  const NETPORT_TYPE = {
    input: 'IN', output: 'OUT', bidirectional: 'BI', tri_state: 'Undefined',
    passive: 'Undefined', unspecified: 'Undefined'
  };
  const netportDocs = new Map();
  const emitNetport = node => {
    const name = findValue(node);
    if (!name) return;
    const [x, y, rot] = findAtXY(node);
    const shapeArr = findSub(node, 'shape');
    const type = NETPORT_TYPE[shapeArr ? shapeArr[0] : 'input'] || 'Undefined';
    let docs = netportDocs.get(name);
    if (!docs) {
      const symUuid = uuid(16);
      const devUuid = uuid(16);
      libDocs.push(
        docHead('SYMBOL', symUuid),
        metaRec(name, { docType: 19 }),
        ...buildNetportSymbolRecords({ name, type }),
        docHead('DEVICE', devUuid),
        metaRec(name, {
          images: [],
          attributes: { Symbol: symUuid, Footprint: '', Description: '', Name: name, 'Add into BOM': 'no' }
        })
      );
      docs = { symUuid, devUuid, type };
      netportDocs.set(name, docs);
    }
    const compId = randId();
    const cx = toSch(x), cy = pageY(y);
    const rotation = ((((rot || 0) % 360) + 360) % 360);
    ticket++;
    pageRecords.push({
      head: { type: 'COMPONENT', ticket, id: compId },
      body: { partId: '1', x: cx, y: cy, rotation, isMirror: false, attrs: {}, zIndex: ++componentZ }
    });
    const ax = cx - 7.5;
    pageRecords.push(pageAttr(compId, ++ticket, 'Device', docs.devUuid, ax, cy, 'RIGHT_MIDDLE', { valueVisible: false }));
    pageRecords.push(pageAttr(compId, ++ticket, 'Symbol', docs.symUuid, ax, cy, 'RIGHT_MIDDLE', { valueVisible: false }));
    pageRecords.push(pageAttr(compId, ++ticket, 'Name', name, ax, cy, 'RIGHT_MIDDLE'));
    // A hier label may attach directly to a pin in KiCad; EasyEDA needs a wire.
    emitPinStub(cx, cy);
  };


  for (const node of root.slice(1)) {
    if (!Array.isArray(node)) continue;
    const head = node[0].v;

    if (head === 'wire' || head === 'bus') {
      // Emitted up-front as one group per connected wire network (emitAllWires).
      continue;
    } else if (head === 'bus_entry') {
      const at = findSub(node, 'at');
      const size = findSub(node, 'size');
      if (!at || !size) { warn('bus_entry without at/size'); continue; }
      const x1 = toSch(at[0]), y1 = pageY(at[1]);
      const x2 = toSch(parseFloat(at[0]) + parseFloat(size[0])), y2 = pageY(parseFloat(at[1]) + parseFloat(size[1]));
      const rot = Math.round((((Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI) % 360) + 360) % 360 / 90) * 90 % 360;
      ticket++;
      pageRecords.push({
        head: { type: 'BUSENTRY', ticket, id: randId() },
        body: { order: ++busEntryOrder, pointX: x2, pointY: y2, rotation: rot, groupId: '', locked: false, zIndex: ticket }
      });
    } else if (head === 'junction') {
      const [x, y] = findAtXY(node);
      const dArr = findSub(node, 'diameter');
      const d = dArr && parseFloat(dArr[0]) > 0 ? parseFloat(dArr[0]) : 1.016; // KiCad diameter 0 = auto (default mm)
      rec('CIRCLE', {
        partId: '', groupId: '', locked: false,
        centerX: toSch(x), centerY: pageY(y), radius: toSch(d) / 2,
        strokeColor: null, strokeStyle: 'SOLID', fillColor: '#000000', strokeWidth: null, fillStyle: 'SOLID'
      });
    } else if (head === 'no_connect') {
      const [x, y] = findAtXY(node);
      const cx = toSch(x), cy = pageY(y);
      const h = 2.5; // half diagonal of the X marker (sch units = 0.635 mm)
      const ncGroup = randId();
      for (const [dx, dy] of [[h, h], [h, -h]]) {
        rec('LINE', {
          fillColor: null, fillStyle: null, strokeColor: null, strokeStyle: null, strokeWidth: 1,
          startX: cx - dx, startY: cy - dy, endX: cx + dx, endY: cy + dy, lineGroup: ncGroup
        });
      }
    } else if (head === 'hierarchical_label') {
      emitNetport(node);
    } else if (head === 'label') {
      // Local net label: official exports name the net through an ATTR key NET
      // attached to the WIRE/BUS group (standalone NETLABEL records are not
      // used for connectivity). A label on a pin gets a stub wire.
      const [x, y] = findAtXY(node);
      const val = findValue(node);
      if (!val) continue;
      let groupId = wireGroupAt(x, y);
      if (!groupId) groupId = emitPinStub(toSch(x), pageY(y));
      pageRecords.push(pageAttr(groupId, ++ticket, 'NET', val, toSch(x), pageY(y), 'LEFT_BOTTOM', { valueVisible: true }));
    } else if (head === 'global_label') {
      // Global labels are global net identifiers: EasyEDA net flags merge by
      // name across the whole design (the standalone NETLABEL record is only
      // a graphic and does not join nets).
      const [x, y] = findAtXY(node);
      const val = findValue(node);
      if (!val) continue;
      const d = ensureNetflagDoc(val);
      const X = toSch(x), Y = pageY(y);
      const compId = randId();
      ticket++;
      pageRecords.push({
        head: { type: 'COMPONENT', ticket, id: compId },
        body: { partId: MAGIC_PART_ID, x: X, y: Y, rotation: 0, isMirror: false,
          attrs: { Footprints: '[]', Devices: '[]', DeviceName: null, FootprintName: null }, zIndex: ++componentZ }
      });
      const vis = { fontSize: null, keyVisible: null, valueVisible: null };
      pageRecords.push(pageAttr(compId, ++ticket, 'Symbol', d.symUuid, X, Y + 10, null, vis));
      pageRecords.push(pageLinkAttr(compId, ++ticket, 'Device', d.devUuid));
      pageRecords.push(pageLinkAttr(compId, ++ticket, 'Relevance', '[]'));
      pageRecords.push(pageAttr(compId, ++ticket, 'Name', val, X, Y + 10, 'CENTER_TOP', vis));
      pageRecords.push(pageAttr(compId, ++ticket, 'Global Net Name', val, X, Y + 10, 'CENTER_TOP', vis));
      emitPinStub(X, Y);
    } else if (head === 'text' || head === 'text_box') {
      const [x, y, rot] = findAtXY(node);
      const val = findValue(node);
      if (!val) continue;
      const fx = textEffects(node);
      if (head === 'text_box') {
        const s = findSub(node, 'start');
        const e = findSub(node, 'end');
        const pts = findPtsSub(node);
        let x1, y1, x2, y2;
        if (pts && pts.length >= 4) {
          x1 = toSch(pts[0][0]); y1 = pageY(pts[0][1]); x2 = toSch(pts[2][0]); y2 = pageY(pts[2][1]);
        } else if (s && e) {
          x1 = toSch(s[0]); y1 = pageY(s[1]); x2 = toSch(e[0]); y2 = pageY(e[1]);
        } else { x1 = x2 = toSch(x); y1 = y2 = pageY(y); }
        rec('RECT', {
          partId: '', groupId: '', locked: false,
          dotX1: x1, dotY1: y1, dotX2: x2, dotY2: y2,
          radiusX: 0, radiusY: 0, rotation: 0,
          strokeColor: null, strokeStyle: null, fillColor: '', strokeWidth: 1, fillStyle: 'NONE'
        });
      }
      ticket++;
      pageRecords.push({
        head: { type: 'TEXT', ticket, id: randId() },
        body: {
          groupId: '', x: toSch(x), y: pageY(y), rotation: ((rot || 0) % 360 + 360) % 360, color: null, fontFamily: null,
          fontSize: fx.size || 5, fontWeight: fx.bold || null, italic: fx.italic || null,
          underline: null, strikeout: null, align: fx.align, value: val, fillColor: null,
          locked: false, zIndex: ticket
        }
      });
    } else if (head === 'polyline') {
      const pts = extractWirePoints(node);
      if (pts.length < 2) continue;
      rec('POLY', shapeCommon(node, {
        points: pts.map(p => ({ x: toSch(p[0]), y: pageY(p[1]) })),
        closed: false, startShape: 'NONE', endShape: 'NONE'
      }));
    } else if (head === 'rectangle') {
      const s = findSub(node, 'start');
      const e = findSub(node, 'end');
      if (!s || !e) continue;
      rec('RECT', shapeCommon(node, {
        dotX1: toSch(s[0]), dotY1: pageY(s[1]), dotX2: toSch(e[0]), dotY2: pageY(e[1]),
        radiusX: 0, radiusY: 0, rotation: 0
      }));
    } else if (head === 'circle') {
      const c = findSub(node, 'center');
      const r = findSub(node, 'radius');
      if (!c || !r) continue;
      rec('CIRCLE', shapeCommon(node, {
        centerX: toSch(c[0]), centerY: pageY(c[1]), radius: toSch(r[0])
      }));
    } else if (head === 'arc') {
      const a = require('./lib/kicad').extractArc(node);
      if (a.mx == null) continue;
      const cx1 = toSch(a.x1), cy1 = pageY(a.y1);
      const cxm = toSch(a.mx), cym = pageY(a.my);
      const cx2 = toSch(a.x2), cy2 = pageY(a.y2);
      // eprj3 schematic ARC refer is a point ON the arc (KiCad's mid), not the
      // circumcenter; writing the center bends the arc the wrong way.
      rec('ARC', shapeCommon(node, {
        startX: cx1, startY: cy1, referX: cxm, referY: cym, endX: cx2, endY: cy2
      }));
    } else if (head === 'bezier') {
      const pts = extractWirePoints(node);
      if (pts.length < 4) continue;
      rec('BEZIER', shapeCommon(node, {
        controls: pts.flatMap(p => [toSch(p[0]), pageY(p[1])])
      }));
    } else if (head === 'image') {
      const [x, y] = findAtXY(node);
      const dataArr = findSub(node, 'data');
      const sc = findSub(node, 'scale');
      const sx = sc ? parseFloat(sc[0]) || 1 : 1;
      const sy = sc ? parseFloat(sc[1]) || 1 : 1;
      if (!dataArr || !dataArr[0]) { warn('image without embedded data'); continue; }
      ticket++;
      pageRecords.push({
        head: { type: 'OBJ', ticket, id: randId() },
        body: {
          partId: '', groupId: '', locked: false, zIndex: ticket,
          fileName: 'image.png', startX: toSch(x), startY: pageY(y),
          width: Math.round(20 * sx), height: Math.round(20 * sy),
          rotation: 0, isMirror: false,
          content: 'data:image/png;base64,' + dataArr[0]
        }
      });
    } else if (head === 'sheet') {
      // Hierarchical sheet rectangle: converted to a block symbol component
      // whose title is the child schematic name (EDA links by title).
      emitSheetBlock((opts.sheetNodes || [])[sheetNodeIdx++]);
    } else if (head === 'symbol') {
      const libId = findChildValue(node, 'lib_id');
      if (!libId) continue;
      const props = collectProperties(node);
      // Reused sheets: the designator/unit live in the instance matching this
      // page's path, not in the shared symbol properties.
      const inst = readSymbolInstance(node, opts.instancePath);
      const unitArr = findSub(node, 'unit');
      const unit = (inst && inst.unit) || (unitArr ? parseInt(unitArr[0], 10) || 1 : 1);
      const ref = (inst && inst.reference) || props.Reference || '';
      // PWR_FLAG is KiCad's ERC-only marker: it attaches to an existing net but
      // does not name one. Converting it as an EDA power flag (Name=PWR_FLAG)
      // ties together every net that carries a flag (GND/VCC/VPP short).
      const shortLib = libId.split(':').pop();
      const libNode = findLibNode(libId);
      const probeSym = libNode ? nodeSymbol(libNode, unit) : null;
      const powerish = /^power:/i.test(libId) || !!(probeSym && probeSym.isPower);
      const flagName = (probeSym && probeSym.name) || shortLib;
      if (powerish && /PWR_FLAG/i.test(flagName)) {
        warn(`schematic: ERC flag ${ref || flagName} skipped (not a net identifier)`);
        continue;
      }
      // A '#' reference marks a KiCad power/net symbol even when its library
      // entry lost the (power) marker: hidden power pins define a global net.
      // KiCad resolves ${SIM.PARAMS} from the Sim.Params field at export time;
      // do the same so simulation symbols keep their real value text.
      const value = props.Value === '${SIM.PARAMS}'
        ? (props['Sim.Params'] || props.Value || '')
        : (props.Value || '');
      const forcedPower = /^#/.test(ref) && !!value;
      const lib = ensureSymbolDoc(libId, props.Footprint || '', unit, forcedPower);
      const [x, y, rot] = findAtXY(node);
      const mirrors = findFlags(node, 'mirror');
      // KiCad (mirror y) = left-right flip = eprj3 isMirror; (mirror x) = top-bottom
      // flip = isMirror + 180°. Sheet angles are CCW-on-screen like eprj3 — no flip.
      let isMirror = mirrors.includes('y');
      let rotation = (((rot || 0) % 360) + 360) % 360;
      if (mirrors.includes('x')) { isMirror = true; rotation = (rotation + 180) % 360; }
      const compId = randId();
      const compX = toSch(x), compY = pageY(y);
      // KiCad property positions are absolute page coords — reuse them so
      // Designator/Name land exactly where KiCad drew them (user issue: big ICs
      // overlapped a fixed +10/+10 offset).
      const propPos = {};
      for (const it of node.slice(1)) {
        if (!(Array.isArray(it) && it[0].v === 'property')) continue;
        const at = findSub(it, 'at');
        if (at && at.length >= 2 && /^[\d.-]+$/.test(String(at[0])) && /^[\d.-]+$/.test(String(at[1]))) {
          propPos[it[1]?.v] = [toSch(at[0]), pageY(at[1])];
        }
      }
      ticket++;
      // KiCad's Footprint property is the package name for this instance.
      // eprj3 stores it in attrs.FootprintName as a JSON string ({uuid,name,
      // source}); the uuid may be empty because the schematic is not bound to
      // a specific PCB footprint document yet.
      const footprintName = props.Footprint || '';
      pageRecords.push({
        head: { type: 'COMPONENT', ticket, id: compId },
        body: {
          partId: lib.partId,
          x: compX, y: compY, rotation, isMirror,
          attrs: lib.isPower
            ? { Footprints: '[]', Devices: '[]', DeviceName: null, FootprintName: null }
            : {
                Footprints: '[]', Devices: '[]',
                DeviceName: JSON.stringify({ uuid: lib.devUuid, name: value || lib.name || libId, source: '' }),
                FootprintName: footprintName
                  ? JSON.stringify({ uuid: '', name: footprintName, source: '' })
                  : null,
                pinClass: {}, differentialPairClass: {}, Symbols: '[]'
              },
          zIndex: ++componentZ
        }
      });
      if (lib.isPower) {
        // Power flags bind through Symbol/Device and carry the net name in
        // Name + Global Net Name, positioned like the symbol-doc attr offsets.
        // Official exports leave kv/vv null here; visibility comes from the
        // symbol doc's own Name attr.
        const powerVis = { fontSize: null, keyVisible: null, valueVisible: null };
        pageRecords.push(pageAttr(compId, ++ticket, 'Symbol', lib.symDocUuid, compX, compY + 30, null, powerVis));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Device', lib.devUuid));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Relevance', '[]'));
        const off = lib.nameOff || { x: 0, y: -10, align: 'CENTER_BOTTOM' };
        pageRecords.push(pageAttr(compId, ++ticket, 'Name', lib.netName || value || lib.name, compX + off.x, compY + off.y, off.align, powerVis));
        pageRecords.push(pageAttr(compId, ++ticket, 'Global Net Name', lib.netName || value || lib.name, compX + off.x, compY + off.y, off.align, powerVis));
        // Connect the power pin to whatever it sits on (KiCad pin-on-pin).
        emitPinStub(compX, compY);
      } else {
        // Binding ATTRs, as in official app exports: EasyEDA resolves the placed
        // symbol through them (Symbol = SYMBOL doc uuid, Device = DEVICE doc uuid);
        // without them the instance renders empty.
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Symbol', lib.symDocUuid));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Device', lib.devUuid));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Unique ID', ref || 'gge' + (++ggeCounter)));
        // Designator/Name at the KiCad property positions when present,
        // otherwise just right of the origin like official exports.
        const [dsgX, dsgY] = propPos.Reference || [compX + 10, compY];
        const [valX, valY] = propPos.Value || [compX + 10, compY + 10];
        if (ref) pageRecords.push(pageAttr(compId, ++ticket, 'Designator', ref, dsgX, dsgY, null, { fontSize: null }));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Footprint', ''));
        if (value) pageRecords.push(pageAttr(compId, ++ticket, 'Name', value, valX, valY, null, { fontSize: null }));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Reuse Block', ''));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Group ID', ''));
        pageRecords.push(pageLinkAttr(compId, ++ticket, 'Channel ID', ''));
        placeHiddenPowerPins(lib.pins, node, mirrors, rot);
      }
    } else if (!['lib_symbols', 'uuid', 'paper', 'title_block', 'version', 'generator', 'generator_version', 'junction', 'at', 'instances', 'path', 'sheet_instances', 'embedded_fonts'].includes(head)) {
      warn(`schematic: unhandled "${head}" skipped`);
    }
  }

  // Sheet frame (docType 20 "Drawing-Symbol_A4"): the app renders the border
  // from this built-in template; we embed its SYMBOL + DEVICE docs verbatim and
  // place a frame COMPONENT at the page origin with the title-block ATTRs.
  // Every page needs its own document uuid: project files are scanned by doc
  // uuid across all .esch2 files, and reusing the template's uuid in several
  // pages makes the CLI refuse to open the project (DUPLICATE_DOCUMENT_FILE).
  const frame = instantiateFrameTemplate();
  const frameCompId = randId();
  const frameDeviceUuid = frame.deviceUuid;
  const frameSymbolUuid = frame.symbolUuid;
  const now = new Date();
  const pad2 = n => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const frameValueOverrides = {
    '@Project Name': opts.projectName || 'KiCad Project',
    '@Schematic Name': sch.title || 'Schematic1',
    '@Page Name': sheet.title,
    '@Page No': String(sheet.zIndex || 1),
    '@Page Count': String(pageCount),
    '@Create Date': dateStr, '@Update Date': dateStr,
    '@Create Time': timeStr, '@Update Time': timeStr,
    // The built-in frame graphics are suppressed; KiCad's own frame is drawn
    // below as native records instead (keeps the A4 page size handling).
    Border: '0', 'Title Block': '0',
    ...tb
  };
  pageRecords.push({
    head: { type: 'COMPONENT', ticket: ++ticket, id: frameCompId },
    body: {
      partId: MAGIC_PART_ID, x: 0, y: 0, rotation: 0, isMirror: false,
      attrs: {
        Footprints: '[]', Devices: '[]',
        DeviceName: JSON.stringify({ uuid: frameDeviceUuid, name: 'Drawing-Symbol_A4', source: '' })
      },
      zIndex: null
    }
  });
  for (const r of frame.pageAttrs) {
    ticket++;
    pageRecords.push({
      head: { type: 'ATTR', ticket, id: randId() },
      body: { ...r.body, parentId: frameCompId, value: frameValueOverrides[r.body.key] != null ? frameValueOverrides[r.body.key] : r.body.value, zIndex: ticket }
    });
  }
  drawKicadFrame(rec, paper, pageH, {
    ...kicadFrameFields,
    sheetNo: String(sheet.zIndex || 1),
    sheetCount: String(pageCount),
    paper,
    sheetPath: '/'
  });

  writeRecords(dst, [
    ...frame.symbol, ...frame.device,
    ...libDocs.flatMap(e => e && e.__symbolDoc ? e.__symbolDoc.records : [e]), ...pageRecords
  ]);
}

// Draw KiCad's default worksheet frame (double border, 50 mm grid references,
// title block) as native LINE/TEXT records — a faithful port of
// kicad-source-mirror common/page_layout/page_layout_default_description.cpp:
// margins 10 mm, ref pitch 50 mm, title block 108×32 mm at the bottom-right,
// all coordinates relative to the corners (default = bottom-right).
function drawKicadFrame(rec, paper, pageH, f) {
  const [W, H] = PAPER_SIZE_MM[paper] || PAPER_SIZE_MM.A4;
  const M = 10; // margins in mm
  const X = mm => toSch(mm);
  const Y = mm => flipYSch(mm, pageH);
  const LW = 0.59; // KiCad default 0.15 mm stroke
  // The drawing sheet and its title-block table are graphics, not electrical
  // wires: emit POLY (折线) records, not WIRE+LINE groups.
  const line = (x1, y1, x2, y2) => {
    rec('POLY', {
      partId: '', groupId: '', locked: false,
      points: [{ x: X(x1), y: Y(y1) }, { x: X(x2), y: Y(y2) }],
      closed: false, startShape: 'NONE', endShape: 'NONE',
      strokeColor: null, strokeStyle: 'SOLID', fillColor: '', fillStyle: 'NONE',
      strokeWidth: LW
    });
  };
  const text = (value, xmm, ymm, fontSize, opts = {}) => {
    if (!value) return;
    rec('TEXT', {
      groupId: '', x: X(xmm), y: Y(ymm), rotation: 0, color: null, fontFamily: null,
      fontSize, fontWeight: opts.bold || null, italic: opts.italic || null,
      underline: null, strikeout: null, align: opts.align || 'LEFT_MIDDLE',
      value, fillColor: null, locked: false
    });
  };
  const nextNum = v => (/\d/.test(v) ? String(parseInt(v, 10) + 1) : String.fromCharCode(v.charCodeAt(0) + 1));

  // double border: (M,M)-(W-M,H-M) and (M+2,M+2)-(W-M-2,H-M-2)
  line(M, M, W - M, M); line(W - M, M, W - M, H - M); line(W - M, H - M, M, H - M); line(M, H - M, M, M);
  line(M + 2, M + 2, W - M - 2, M + 2); line(W - M - 2, M + 2, W - M - 2, H - M - 2); line(W - M - 2, H - M - 2, M + 2, H - M - 2); line(M + 2, H - M - 2, M + 2, M + 2);

  // grid reference bands: ticks + auto-incrementing refs (1,2,3... / A,B,C...).
  // Top/bottom refs count from the left; left counts from the top, right from
  // the bottom (ltcorner/lbcorner/rtcorner origins in the KiCad description).
  const refSize = 5.1; // 1.3 mm
  for (let x = M + 50; x < W - M; x += 50) { line(x, M, x, M + 2); line(x, H - M - 2, x, H - M); }
  for (let y = M + 50; y < H - M; y += 50) line(M, y, M + 2, y);
  for (let y = H - M - 50; y > M; y -= 50) line(W - M - 2, y, W - M, y);
  for (let x = M + 25, n = '1'; x <= W - M; x += 50, n = nextNum(n)) {
    text(n, x, M + 1, refSize, { align: 'CENTER_MIDDLE' });
    text(n, x, H - M - 1, refSize, { align: 'CENTER_MIDDLE' });
  }
  for (let y = M + 25, n = 'A'; y <= H - M; y += 50, n = nextNum(n)) {
    text(n, M + 1, y, refSize, { align: 'CENTER_MIDDLE' });
    text(n, W - M - 1, H - y, refSize, { align: 'CENTER_MIDDLE' });
  }

  // title block, anchored to the INNER frame border so no cell falls outside
  const TB_R = W - M - 2, TB_B = H - M - 2;
  const TX = TB_R - 110, TY = TB_B - 34, BX = TB_R, BY = TB_B;
  line(TX, TY, BX, TY); line(BX, TY, BX, BY); line(BX, BY, TX, BY); line(TX, BY, TX, TY);
  line(TX, BY - 3.5, BX, BY - 3.5);
  line(TX, BY - 6.5, BX, BY - 6.5);
  line(TX, BY - 10.5, BX, BY - 10.5);
  line(TX, BY - 16.5, BX, BY - 16.5);
  line(BX - 88, BY - 6.5, BX - 88, BY - 3.5);
  line(BX - 24, BY - 6.5, BX - 24, BY);
  const ts = 5.9;  // 1.5 mm default text
  text(`Id: ${f.sheetNo}/${f.sheetCount}`, BX - 22, BY - 2.1, ts);
  text(f.version, BX - 107, BY - 2.1, ts);
  text(`Date: ${f.date}`, BX - 85, BY - 4.9, ts);
  text(`Rev: ${f.rev}`, BX - 22, BY - 4.9, ts, { bold: true });
  text(`Size: ${f.paper}`, BX - 107, BY - 4.9, ts);
  text(`Title: ${f.title}`, BX - 107, BY - 8.7, 7.9, { bold: true, italic: true });
  text(`File: ${f.file}`, BX - 107, BY - 12.3, ts);
  text(`Sheet: ${f.sheetPath}`, BX - 107, BY - 15, ts);
  text(f.company, BX - 107, BY - 18, ts, { bold: true });
  for (let i = 0; i < 4; i++) text(f.comments[i] || '', BX - 107, BY - 21 - 3 * i, ts);
}

// KiCad graphical-item stroke/fill → eprj3 schematic shape common fields
function shapeCommon(node, extra) {
  const strokeNode = findSubNode(node, 'stroke');
  const fillNode = findSubNode(node, 'fill');
  const s = strokeNode ? mapStroke({ width: parseFloat((findSub(strokeNode, 'width') || [null])[0]), type: (findSub(strokeNode, 'type') || [null])[0] }) : { strokeWidth: null, strokeStyle: 'SOLID' };
  const f = mapFill(fillNode ? (findSub(fillNode, 'type') || [null])[0] : null);
  return {
    partId: '', groupId: '', locked: false,
    strokeColor: null, strokeStyle: s.strokeStyle, fillColor: f.fillColor,
    strokeWidth: s.strokeWidth, fillStyle: f.fillStyle,
    ...extra
  };
}

// Hierarchical sheet: box + name text + per-pin net labels
function textEffects(node) {
  const out = { size: null, bold: null, italic: null, align: null };
  const eff = findSubNode(node, 'effects');
  if (!eff) return out;
  const font = findSubNode(eff, 'font');
  if (font) {
    const size = findSub(font, 'size');
    if (size) out.size = Math.max(1, Math.round(toSch(size[0]) * 100) / 100);
    out.bold = findFlags(font, 'bold').length ? true : null;
    out.italic = findFlags(font, 'italic').length ? true : null;
  }
  const justify = findSub(eff, 'justify');
  if (justify) {
    const h = justify.includes('left') ? 'LEFT' : justify.includes('right') ? 'RIGHT' : 'CENTER';
    const v = justify.includes('top') ? 'TOP' : justify.includes('bottom') ? 'BOTTOM' : 'MIDDLE';
    out.align = `${h}_${v}`;
  }
  return out;
}

function pageAttr(parentId, ticket, key, value, x, y, align, extra = {}) {
  return {
    head: { type: 'ATTR', ticket, id: randId() },
    body: {
      x, y, rotation: 0, color: null, fontFamily: null, fontSize: 5,
      fontWeight: null, italic: null, underline: null, strikeout: null, align,
      value, keyVisible: false, valueVisible: true, key,
      fillColor: null, groupId: '', parentId, zIndex: ticket, locked: false,
      ...extra
    }
  };
}

// Non-visual binding ATTR (Symbol/Device/Unique ID): no position, as the
// official app writes them on placed components.
function pageLinkAttr(parentId, ticket, key, value) {
  return {
    head: { type: 'ATTR', ticket, id: randId() },
    body: {
      x: null, y: null, rotation: null, color: null, fontFamily: null, fontSize: null,
      fontWeight: null, italic: null, underline: null, strikeout: null, align: null,
      value, keyVisible: null, valueVisible: null, key,
      fillColor: null, parentId, zIndex: ticket
    }
  };
}

function extractWirePoints(node) {
  // wire/polyline nodes have (pts (xy x y) (xy x y) ...)
  const out = [];
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'pts') {
      for (const xy of it.slice(1)) {
        if (Array.isArray(xy) && xy[0].v === 'xy') out.push([parseFloat(xy[1].v), parseFloat(xy[2].v)]);
      }
    }
  }
  return out;
}

function findPtsSub(node) {
  const ptsNode = findSubNode(node, 'pts');
  if (!ptsNode) return null;
  const out = [];
  for (const xy of ptsNode.slice(1)) {
    if (Array.isArray(xy) && xy[0].v === 'xy') out.push([parseFloat(xy[1].v), parseFloat(xy[2].v)]);
  }
  return out.length ? out : null;
}

function findAtXY(node) {
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'at') return [parseFloat(it[1].v), parseFloat(it[2].v), parseFloat(it[3]?.v || 0)];
  }
  return [0, 0, 0];
}

function findValue(node) {
  // first bare quoted-string argument (token t === 'str')
  for (const it of node.slice(1)) {
    if (it && typeof it === 'object' && it.t === 'str') return it.v;
  }
  return '';
}

function findFlags(node, name) {
  const out = [];
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === name) {
      for (const x of it.slice(1)) if (x && typeof x.v === 'string') out.push(x.v);
    }
  }
  return out;
}

function collectProperties(node) {
  const out = {};
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'property') out[it[1]?.v] = it[2]?.v;
  }
  return out;
}

// ---- KiCad hierarchical sheets ----
// Symbols carry their per-instance designator under (instances (project ...
// (path "/root/sheetUuid" (reference "R1") (unit 1)))). A sheet file placed
// twice has two entries, so the designator depends on the instance path.
function readSymbolInstance(node, instancePath) {
  let best = null, single = null, count = 0;
  for (const it of node.slice(1)) {
    if (!Array.isArray(it) || it[0].v !== 'instances') continue;
    for (const proj of it.slice(1)) {
      if (!Array.isArray(proj) || proj[0].v !== 'project') continue;
      for (const p of proj.slice(2)) {
        if (!Array.isArray(p) || p[0].v !== 'path') continue;
        count++;
        const rec = { path: p[1]?.v || '', reference: '', unit: 0 };
        for (const x of p.slice(2)) {
          if (!Array.isArray(x)) continue;
          if (x[0].v === 'reference') rec.reference = x[1]?.v || '';
          else if (x[0].v === 'unit') rec.unit = parseInt(x[1]?.v, 10) || 0;
        }
        if (instancePath && rec.path === instancePath) best = rec;
        if (!single) single = rec;
      }
    }
  }
  return best || (count === 1 ? single : null);
}
// Reads every (sheet ...) node of a .kicad_sch: rectangle, Sheetname/Sheetfile
// and the sheet pins (the hierarchical interface to the child page).
function readSheetNodes(absFile, present) {
  const out = [];
  let root;
  try { root = parseSex(fs.readFileSync(absFile, 'utf8')); } catch (e) { return out; }
  for (const node of root.slice(1)) {
    if (!Array.isArray(node) || node[0].v !== 'sheet') continue;
    const at = findSub(node, 'at');
    let size = findSub(node, 'size');
    let x = 0, y = 0, w = 0, h = 0;
    if (at) {
      x = parseFloat(at[0]) || 0; y = parseFloat(at[1]) || 0;
      if (at.length >= 4 && !size) { w = parseFloat(at[2]) || 0; h = parseFloat(at[3]) || 0; }
    }
    if (size) { w = parseFloat(size[0]) || 0; h = parseFloat(size[1]) || 0; }
    const props = collectProperties(node);
    const sheetFile = props.Sheetfile || '';
    const target = sheetFile ? path.resolve(path.dirname(absFile), sheetFile) : null;
    const pins = [];
    for (const it of node.slice(1)) {
      if (!Array.isArray(it) || it[0].v !== 'pin') continue;
      const pat = findSub(it, 'at');
      pins.push({
        name: it[1]?.v || '',
        type: it[2]?.v || 'passive',
        x: pat ? parseFloat(pat[0]) : x,
        y: pat ? parseFloat(pat[1]) : y,
        angle: pat && pat[2] != null ? parseFloat(pat[2]) || 0 : 0
      });
    }
    out.push({
      x, y, w, h,
      uuid: findChildValue(node, 'uuid') || '',
      sheetName: props.Sheetname || '',
      sheetFile,
      target: target && present.has(target) ? target : null,
      pins
    });
  }
  return out;
}

// ---------------------------------------------------------------------- pcb

// KiCad canonical layer → eprj3 layerId (official 60-layer table)
const LAYER_IDS = {
  'F.Cu': 1, 'B.Cu': 2, 'F.SilkS': 3, 'B.SilkS': 4,
  'F.Mask': 5, 'B.Mask': 6, 'F.Paste': 7, 'B.Paste': 8,
  'F.Adhes': 9, 'B.Adhes': 10, 'Edge.Cuts': 11,
  'F.CrtYd': 13, 'B.CrtYd': 13, 'Dwgs.User': 13, 'Cmts.User': 13,
  'F.Fab': 9, 'B.Fab': 10, 'Eco1.User': 14, 'Eco2.User': 14
};

function layerToId(name) {
  if (!name) return 1;
  if (LAYER_IDS[name] !== undefined) return LAYER_IDS[name];
  const m = /^In(\d+)\.Cu$/.exec(name);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 32) return 14 + n;
  }
  if (/^User\.\d+$/.test(name)) return 14;
  return 1;
}

function convertPcb(srcFile, dst, pcb, opts = {}) {
  const pourFineness = opts.pourFineness || 8;
  const root = parseSex(fs.readFileSync(srcFile, 'utf8'));

  // (net <num> "<name>") table at board level
  const netNames = {};
  for (const node of root.slice(1)) {
    if (Array.isArray(node) && node[0].v === 'net' && node[1] && /^\d+$/.test(node[1].v || '')) {
      const name = normNet(node[2]?.v || '');
      if (name) netNames[node[1].v] = name;
    }
  }

  const libDocs = [];
  const usedFps = {};
  function ensureFootprintDoc(name, fpData) {
    // KiCad board footprints may share a library name but carry per-instance
    // edits (e.g. two Connect:1pin footprints with different custom pads), so
    // key the doc by name + geometry, not by name alone.
    const anonymized = { ...fpData, pads: fpData.pads.map(p => ({ ...p, netName: '' })) };
    const key = name + '\u0000' + JSON.stringify({ pads: anonymized.pads, shapes: anonymized.shapes, value: fpData.value || '' });
    if (usedFps[key]) return usedFps[key];
    const docUuid = uuid(16);
    const devUuid = uuid(16);
    // Library docs carry no instance nets — nets are wired per placement via PAD_NET.
    const { records: fpRecs, pads } = buildFootprintRecords({ name, pads: anonymized.pads, shapes: anonymized.shapes, value: fpData.value });
    libDocs.push(docHead('FOOTPRINT', docUuid), metaRec(name), ...fpRecs);
    libDocs.push(docHead('DEVICE', devUuid), metaRec(name, { images: [], attributes: { Symbol: '', Footprint: docUuid } }));
    usedFps[key] = { docUuid, devUuid, pads };
    return usedFps[key];
  }

  // DOCHEAD + META + the static editor config block the client requires.
  const docRecords = [
    docHead('PCB', pcb.uuid),
    { head: { type: 'META', ticket: 1, id: 'META' }, body: { title: pcb.title, parent: '', source: '', board: pcb.board, zIndex: null } },
    ...PCB_CONFIG.map((r, i) => ({ head: { type: r.type, ticket: 2 + i, id: r.id }, body: r.body }))
  ];
  let ticket = docRecords.length + 1;
  const body = [];
  const compBody = [];
  const usedNets = new Set();
  const outlinePaths = [];
  const openSegments = [];
  const nextTicket = () => ++ticket;
  const push = (type, recBody, id) => {
    body.push({ head: { type, ticket: nextTicket(), id: id || randId() }, body: recBody });
    return ticket;
  };
  const pcbLineCommon = { partitionId: '', groupId: 0, locked: false, zIndex: -1 };

  for (const node of root.slice(1)) {
    if (!Array.isArray(node)) continue;
    const head = node[0].v;

    if (head === 'segment') {
      const start = findSub(node, 'start');
      const end = findSub(node, 'end');
      if (!start || !end) continue;
      const widthArr = findSub(node, 'width');
      const width = widthArr ? parseFloat(widthArr[0]) : 0.25;
      const layerArr = findSub(node, 'layer');
      const layerId = layerToId(layerArr ? layerArr[0] : 'F.Cu');
      const netName = netOf(node, netNames);
      if (netName) usedNets.add(netName);
      push('LINE', {
        ...pcbLineCommon, netName, layerId,
        startX: toMil(start[0]), startY: flipY(start[1]),
        endX: toMil(end[0]), endY: flipY(end[1]),
        width: toMil(width)
      });
    } else if (head === 'arc') {
      // track arc: start/mid/end → ARC (start/end + CCW-positive sweep angle)
      const s = findSub(node, 'start');
      const m = findSub(node, 'mid');
      const e = findSub(node, 'end');
      if (!s || !m || !e) { warn('track arc without start/mid/end'); continue; }
      const widthArr = findSub(node, 'width');
      const width = widthArr ? parseFloat(widthArr[0]) : 0.25;
      const layerArr = findSub(node, 'layer');
      const layerId = layerToId(layerArr ? layerArr[0] : 'F.Cu');
      const netName = netOf(node, netNames);
      if (netName) usedNets.add(netName);
      const x1 = toMil(s[0]), y1 = flipY(s[1]);
      const mx = toMil(m[0]), my = flipY(m[1]);
      const x2 = toMil(e[0]), y2 = flipY(e[1]);
      const { sweep } = arcSweep(x1, y1, mx, my, x2, y2);
      push('ARC', {
        ...pcbLineCommon, netName, layerId,
        startX: x1, startY: y1, endX: x2, endY: y2,
        angle: r2(sweep), width: toMil(width)
      });
    } else if (head === 'via') {
      const at = findSub(node, 'at');
      const sizeArr = findSub(node, 'size');
      const drillArr = findSub(node, 'drill');
      if (!at) continue;
      const netName = netOf(node, netNames);
      if (netName) usedNets.add(netName);
      push('VIA', {
        ...pcbLineCommon, groupId: '0', netName, ruleName: '',
        centerX: toMil(at[0]), centerY: flipY(at[1]),
        holeDiameter: drillArr ? toMil(drillArr[0]) : 0,
        viaDiameter: sizeArr ? toMil(sizeArr[0]) : 0,
        viaType: 'NORMAL', topSolderExpansion: null, bottomSolderExpansion: null,
        unusedInnerLayers: [], propagationDelay: 0
      });
    } else if (head === 'footprint') {
      const pushComp = (type, recBody, id) => {
        compBody.push({ head: { type, ticket: nextTicket(), id: id || randId() }, body: recBody });
        return ticket;
      };
      convertFootprint(node, {
        netNames, usedNets, usedFps, ensureFootprintDoc, nextTicket, push: pushComp, body: compBody
      });
    } else if (head === 'gr_line' || head === 'gr_arc' || head === 'gr_rect' || head === 'gr_circle' || head === 'gr_poly' || head === 'bezier' || head === 'gr_curve') {
      const layerArr = findSub(node, 'layer');
      const lname = layerArr ? layerArr[0] : '';
      const isEdge = lname === 'Edge.Cuts';
      if (head === 'gr_line') {
        const s = findSub(node, 'start');
        const e = findSub(node, 'end');
        if (!s || !e) continue;
        const width = strokeWidthOf(node, 0.15);
        if (isEdge) {
          openSegments.push([toMil(s[0]), flipY(s[1]), toMil(e[0]), flipY(e[1])]);
        } else {
          push('LINE', {
            ...pcbLineCommon, netName: '', layerId: layerToId(lname),
            startX: toMil(s[0]), startY: flipY(s[1]), endX: toMil(e[0]), endY: flipY(e[1]),
            width: toMil(width)
          });
        }
      } else if (head === 'gr_arc') {
        const s = findSub(node, 'start');
        const m = findSub(node, 'mid');
        const e = findSub(node, 'end');
        if (!s || !m || !e) { warn('gr_arc without start/mid/end'); continue; }
        const width = strokeWidthOf(node, 0.15);
        if (isEdge) {
          // Edge.Cuts arcs are flattened so chainSegments can stitch lines and
          // arcs into one closed outline. The host cannot chain a standalone
          // per-arc outline; sampling density follows the sagitta (not a fixed
          // angle) so large-radius arcs keep the same accuracy as small ones.
          const segs = arcSegments(
            toMil(s[0]), flipY(s[1]),
            toMil(m[0]), flipY(m[1]),
            toMil(e[0]), flipY(e[1])
          );
          if (!segs) { warn('gr_arc with degenerate geometry skipped'); continue; }
          for (const seg of segs) openSegments.push(seg);
        } else {
          const x1 = toMil(s[0]), y1 = flipY(s[1]);
          const mx = toMil(m[0]), my = flipY(m[1]);
          const x2 = toMil(e[0]), y2 = flipY(e[1]);
          const { sweep } = arcSweep(x1, y1, mx, my, x2, y2);
          push('ARC', {
            ...pcbLineCommon, netName: '', layerId: layerToId(lname),
            startX: x1, startY: y1, endX: x2, endY: y2,
            angle: r2(sweep), width: toMil(width)
          });
        }
      } else if (head === 'gr_rect') {
        const s = findSub(node, 'start');
        const e = findSub(node, 'end');
        if (!s || !e) continue;
        const x1 = toMil(s[0]), y1 = flipY(s[1]), x2 = toMil(e[0]), y2 = flipY(e[1]);
        const path = [x1, y1, 'L', x2, y1, x2, y2, x1, y2, x1, y1];
        if (isEdge) outlinePaths.push(path);
        else push('POLY', { ...pcbLineCommon, netName: '', layerId: layerToId(lname), width: toMil(strokeWidthOf(node, 0.15)), path, polyType: 'NORMAL' });
      } else if (head === 'gr_circle') {
        const c = findSub(node, 'center');
        const e = findSub(node, 'end');
        if (!c || !e) continue;
        const cx = toMil(c[0]), cy = flipY(c[1]);
        const r = Math.hypot(toMil(e[0]) - cx, flipY(e[1]) - cy);
        if (isEdge) {
          outlinePaths.push([['CIRCLE', cx, cy, r, 1]]);
        } else {
          push('POLY', { ...pcbLineCommon, netName: '', layerId: layerToId(lname), width: toMil(strokeWidthOf(node, 0.15)), path: [['CIRCLE', cx, cy, r, 1]], polyType: 'NORMAL' });
        }
      } else if (head === 'gr_poly') {
        const pts = extractPts(node);
        if (!pts || pts.length < 3) continue;
        const flat = [];
        for (const p of pts) flat.push(toMil(p.x), flipY(p.y));
        const path = [flat[0], flat[1], 'L', ...flat.slice(2), flat[0], flat[1]];
        if (isEdge) outlinePaths.push(path);
        else push('POLY', { ...pcbLineCommon, netName: '', layerId: layerToId(lname), width: toMil(strokeWidthOf(node, 0.15)), path, polyType: 'NORMAL' });
      } else if (head === 'bezier' || head === 'gr_curve') {
        // The host's POLY outline decoder only understands L/ARC/CARC and
        // throws on 'C', so sample the cubic Bezier into line segments instead
        // of emitting a 'C' path (a C-token POLY is silently dropped).
        const pts = extractPts(node);
        if (!pts || pts.length < 4) continue;
        const flat = [];
        for (const p of pts) flat.push(toMil(p.x), flipY(p.y));
        const sampled = flattenCubicBezier(flat);
        if (isEdge) {
          for (let i = 0; i + 3 < sampled.length; i += 2) {
            openSegments.push([sampled[i], sampled[i + 1], sampled[i + 2], sampled[i + 3]]);
          }
        } else {
          push('POLY', {
            ...pcbLineCommon, netName: '', layerId: layerToId(lname), width: toMil(strokeWidthOf(node, 0.15)),
            path: [sampled[0], sampled[1], 'L', ...sampled.slice(2)], polyType: 'NORMAL'
          });
        }
      }
    } else if (head === 'gr_text') {
      const val = typeof node[1]?.v === 'string' ? node[1].v : '';
      if (!val) continue;
      push('STRING', pcbString(node, val));
    } else if (head === 'dimension') {
      convertDimension(node, push);
    } else if (head === 'zone') {
      convertZone(node, { netNames, usedNets, push, pourFineness });
    } else if (!['kicad_pcb', 'version', 'generator', 'generator_version', 'general', 'paper', 'layers', 'setup', 'net', 'property', 'images', 'group', 'embedded_fonts'].includes(head)) {
      warn(`pcb: unhandled "${head}" skipped`);
    }
  }

  // Stitch Edge.Cuts line segments into (closed where possible) outline polylines
  for (const chain of chainSegments(openSegments)) {
    const closed = Math.hypot(chain[0] - chain[chain.length - 2], chain[1] - chain[chain.length - 1]) < 0.5;
    const path = closed ? chain : [...chain, chain[0], chain[1]];
    outlinePaths.push(path);
  }
  for (const path of outlinePaths) {
    // Rectangular boards are written as the "R" descriptor in real exports.
    // Otherwise ensure an explicit 'L' after the first point: tokenless paths
    // (and bare close-back pairs) hit "invalid rawData" in the host parser.
    // Nested shapes such as [['CIRCLE',...]] and already-tokened paths are
    // left untouched.
    const outPath = rectDescriptor(path) || withLToken(path);
    push('POLY', { ...pcbLineCommon, netName: '', layerId: 11, width: 10, path: outPath, polyType: 'BOARD_OUTLINE' });
  }

  // NET index records — the official head id is the JSON array ["NET",<name>]
  // and the default net "" has an empty payload.
  const netRecords = [];
  for (const netName of [...usedNets].sort()) {
    if (!netName) continue;
    netRecords.push({
      head: { type: 'NET', ticket: nextTicket(), id: JSON.stringify(['NET', netName]) },
      body: { netType: null, specialColor: null, retLine: true, differentialName: null, isPositiveNet: false, equalLengthGroupName: null }
    });
  }

  // File order mirrors real exports: config → NETs → components(+PAD_NET/ATTR) →
  // default RULE_SELECTOR → drawing items. Tickets are renumbered to match.
  const ordered = [
    ...docRecords,
    ...netRecords,
    ...compBody,
    { head: { type: 'RULE_SELECTOR', ticket: 0, id: JSON.stringify(['RULE_SELECTOR', ['NET', '']]) }, body: {} },
    ...body
  ];
  let t = 1;
  for (const rec of ordered) {
    if (rec.head.type === 'DOCHEAD') continue;
    rec.head.ticket = ++t;
  }
  // Validate every path-bearing record against the host path grammar before
  // writing; fail loudly instead of shipping a file the client silently drops.
  const allRecords = [...libDocs, ...ordered];
  const bad = findViolation(allRecords);
  if (bad) throw new Error(`host-path grammar violation in ${bad.type} ${bad.id}: ${bad.reason}`);
  writeRecords(dst, allRecords);
}

// KiCad escapes '/' in net names as {slash}; unconnected-(...) placeholders
// mean the pad has no net yet (EasyEDA models those with net '').
function normNet(name) {
  if (!name) return '';
  if (/^unconnected-\(/.test(name)) return '';
  return name.replace(/\{slash\}/g, '/');
}

function r2(v) { return Math.round(v * 100) / 100; }

function netOf(node, netNames) {
  const netArr = findSub(node, 'net');
  return netArr ? (netNames[netArr[0]] || '') : '';
}



function strokeWidthOf(node, fallback) {
  const w = findSub(node, 'width');
  if (w) return parseFloat(w[0]);
  const stroke = findSubNode(node, 'stroke');
  if (stroke) {
    const sw = findSub(stroke, 'width');
    if (sw) return parseFloat(sw[0]);
  }
  return fallback;
}

// Flat path without a leading instruction token → insert 'L' after the start
// point. Nested shapes ([['CIRCLE',...]]) and already-tokened paths are kept.
function withLToken(path) {
  if (!Array.isArray(path) || !path.length) return path;
  if (Array.isArray(path[0]) || typeof path[2] === 'string') return path;
  return [path[0], path[1], 'L', ...path.slice(2)];
}

// Arc → line segments for Edge.Cuts chaining. Step count follows the radius so
// the sagitta stays <= 0.2 mil (~5 µm) at any radius (a fixed 2° step would be
// 15–30 µm off on large-radius arcs).
function arcSegments(x1, y1, mx, my, x2, y2) {
  const { cx, cy, sweep } = arcSweep(x1, y1, mx, my, x2, y2);
  const r = Math.hypot(x1 - cx, y1 - cy);
  if (!(r > 0.01) || !isFinite(sweep) || Math.abs(sweep) < 0.01) return null;
  const maxTurn = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - 0.2 / r))) * 180 / Math.PI;
  const steps = Math.max(2, Math.min(720, Math.ceil(Math.abs(sweep) / Math.max(maxTurn, 0.05))));
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const segs = [];
  let px = x1, py = y1;
  for (let i = 1; i <= steps; i++) {
    const a = a0 + sweep * Math.PI / 180 * (i / steps);
    const nx = cx + r * Math.cos(a), ny = cy + r * Math.sin(a);
    segs.push([px, py, nx, ny]);
    px = nx; py = ny;
  }
  return segs;
}

// KiCad cubic Bezier (4 control points) → sampled open polyline in mil.
// The client's POLY outline decoder rejects the 'C' path instruction, so the
// curve must be flattened before it is written (a C-token POLY is silently
// dropped). Segment count follows the control-polygon length (~10 mil each),
// clamped so small and large curves stay both smooth and compact.
function flattenCubicBezier(flat) {
  if (flat.length !== 8) return flat.slice();
  const [x0, y0, x1, y1, x2, y2, x3, y3] = flat;
  const ctrlLen = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
  const steps = Math.max(12, Math.min(64, Math.ceil(ctrlLen / 10)));
  const out = [x0, y0];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push(a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3);
  }
  return out;
}

// gr_text → PCB STRING record body
function pcbString(node, val) {
  const at = findSub(node, 'at');
  const layerArr = findSub(node, 'layer');
  const layerId = layerToId(layerArr ? layerArr[0].replace(/ knockout$/, '') : 'F.SilkS');
  const eff = findSubNode(node, 'effects');
  const font = eff ? findSubNode(eff, 'font') : null;
  const size = font ? findSub(font, 'size') : null;
  const fontSize = size ? Math.max(5, toMil(size[0])) : 25;
  const thick = font ? findSub(font, 'thickness') : null;
  const justify = eff ? findSub(eff, 'justify') : null;
  const h = justify && justify.includes('left') ? 'LEFT' : justify && justify.includes('right') ? 'RIGHT' : 'CENTER';
  const v = justify && justify.includes('top') ? 'TOP' : justify && justify.includes('bottom') ? 'BOTTOM' : 'MIDDLE';
  const knockout = layerArr && layerArr[0] && /knockout/.test(layerArr[0]);
  return {
    partitionId: '', groupId: 0, locked: false, zIndex: -1, layerId,
    x: at ? toMil(at[0]) : 0, y: at ? flipY(at[1]) : 0,
    text: val, fontFamily: 'default', fontSize,
    strokeWidth: thick ? Math.max(1, toMil(thick[0])) : 6,
    bold: font && findFlags(font, 'bold').length ? 1 : 0,
    italic: font && findFlags(font, 'italic').length ? 1 : 0,
    origin: `${h}_${v}`,
    // PCB angles are CCW on screen in both formats - pass KiCad's angle through.
    angle: (((parseFloat(at && at[2]) || 0) % 360) + 360) % 360,
    reverse: !!knockout, expansion: 0,
    mirror: layerId === 2,
    specialColor: null
  };
}

// KiCad dimension → eprj3 DIMENSION (payload shape follows real app exports:
// dimensionType "LENGTH-CONSTRAINT" + controlDot, not the TS-shape schema)
function convertDimension(node, push) {
  const typeArr = findSub(node, 'type');
  const ktype = typeArr ? typeArr[0] : 'aligned';
  const layerArr = findSub(node, 'layer');
  const layerId = layerToId(layerArr ? layerArr[0] : 'Cmts.User');
  const ptsNode = findSubNode(node, 'pts');
  const pts = [];
  if (ptsNode) {
    for (const xy of ptsNode.slice(1)) {
      if (Array.isArray(xy) && xy[0].v === 'xy') pts.push([toMil(xy[1].v), flipY(xy[2].v)]);
    }
  }
  const style = findSubNode(node, 'style');
  const thick = style ? findSub(style, 'thickness') : null;
  const common = {
    layerId, dimensionType: 'LENGTH-CONSTRAINT', unit: '', strokeWidth: thick ? Math.max(1, toMil(thick[0])) : 0,
    accuracy: 0, relationIds: [], locked: false, visible: true, cover: 0, name: '', valid: true
  };
  let controlDot = null;
  if ((ktype === 'aligned' || ktype === 'orthogonal') && pts.length >= 2) {
    const heightArr = findSub(node, 'height');
    const hMm = heightArr ? parseFloat(heightArr[0]) : 0;
    const [p1, p2] = pts;
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L * toMil(hMm), ny = dx / L * toMil(hMm);
    controlDot = [p1[0], p1[1], p2[0], p2[1], r2(p2[0] + nx), r2(p2[1] + ny), r2(p1[0] + nx), r2(p1[1] + ny)];
  } else if (ktype === 'leader' && pts.length >= 2) {
    controlDot = [pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[1][0], pts[1][1], pts[0][0], pts[0][1]];
  } else if (ktype === 'radial' && pts.length >= 2) {
    controlDot = [pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[1][0], pts[1][1], pts[0][0], pts[0][1]];
  } else {
    warn(`dimension type "${ktype}" not convertible`);
    return;
  }
  push('DIMENSION', { ...common, controlDot });
}

// zone → POUR (+POURED per filled_polygon) or REGION for keepouts
function convertZone(node, { netNames, usedNets, push, pourFineness }) {
  // POUR.width is stored in mm in eprj3 files (real exports: 0.2) even though
  // every other PCB coordinate is mil.
  const minThick = findSub(node, 'min_thickness');
  const width = minThick ? parseFloat(minThick[0]) || 0.2 : 0.2;
  const nameArr = findSub(node, 'name');
  const prioArr = findSub(node, 'priority');
  const keepout = findSubNode(node, 'keepout');

  // polygons: one or more (polygon (pts ...)) → "L"-token polyline sub-paths
  const polys = [];
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'polygon') {
      const pts = extractPts(it);
      if (pts && pts.length > 2) {
        const flat = [];
        for (const p of pts) flat.push(r2(toMil(p.x)), r2(flipY(p.y)));
        polys.push([flat[0], flat[1], 'L', ...flat.slice(2), flat[0], flat[1]]);
      }
    }
  }
  // Real exports write rectangular pour borders as the "R" rect descriptor
  // [minX, maxY, w, h, 0, 0] (second value is the TOP edge on the Y-up canvas),
  // not as a polyline.
  polys.forEach((poly, i) => {
    const rect = rectDescriptor(poly);
    if (rect) polys[i] = rect;
  });

  const layers = [];
  const layerArr = findSub(node, 'layer');
  const layersArr = findSub(node, 'layerS') || findSub(node, 'layers');
  if (layerArr) layers.push(layerArr[0]);
  if (layersArr) for (const l of layersArr) layers.push(l);
  if (!layers.length) layers.push('F.Cu');

  if (keepout) {
    const prohibit = [];
    for (const it of keepout.slice(1)) {
      if (!Array.isArray(it)) continue;
      const kind = it[0].v;
      const blocked = it[1]?.v === 'not_allowed';
      if (!blocked) continue;
      if (kind === 'tracks') prohibit.push('TRACK');
      else if (kind === 'vias') prohibit.push('VIA');
      else if (kind === 'pads' || kind === 'footprints') prohibit.push('COMPONENT');
      else if (kind === 'copperpour') prohibit.push('COPPER');
    }
    for (const lname of layers) {
      for (const poly of polys) {
        push('REGION', {
          partitionId: '', groupId: 0, locked: false, zIndex: -1,
          layerId: layerToId(lname), width, prohibitType: [...new Set(prohibit)],
          path: [poly], name: nameArr ? nameArr[0] : '', regionType: 'PROHIBIT'
        });
      }
    }
    return;
  }

  const netArr = findSub(node, 'net');
  const netNameArr = findSub(node, 'net_name');
  // KiCad 8+ writes zones as (net "NAME") instead of a numeric index. The
  // netNames table is keyed by the numeric index, so fall back to the name
  // string when the lookup misses (otherwise the pour silently loses its net).
  const netName = normNet((netNameArr && netNameArr[0]) || (netArr
    ? (netNames[netArr[0]] || (String(netArr[0]).match(/^\d+$/) ? '' : netArr[0]))
    : ''));
  if (netName) usedNets.add(netName);

  if (!polys.length) { warn('zone without polygon'); return; }

  for (const lname of layers) {
    const pourId = randId();
    const order = prioArr ? parseInt(prioArr[0], 10) || 0 : 0;
    push('POUR', {
      partitionId: '', groupId: 0, locked: false, zIndex: -1,
      netName, layerId: layerToId(lname), width,
      name: (nameArr && nameArr[0]) || `POUR${order + 1}`, order,
      path: polys, pourType: { pourType: 'SOLID', fineness: pourFineness || 8 }, keepIsland: false
    }, pourId);
    // poured fill results: one POURED per zone+layer, head id = ["POURED", pourId].
    // POURED.pourFill paths use the 0.254 mm unit (10 mil, like schematic data),
    // NOT the mil of the surrounding PCB document — verified against a real
    // export where fill·10 mil sits exactly clearance-inside the board outline
    // and fill arcs land on component pads.
    const pourFill = [];
    for (const it of node.slice(1)) {
      if (!(Array.isArray(it) && it[0].v === 'filled_polygon')) continue;
      const fpLayer = findSub(it, 'layer');
      if (fpLayer && fpLayer[0] !== lname) continue;
      const pts = extractPts(it);
      if (!pts || pts.length < 3) continue;
      const flat = [];
      for (const p of pts) flat.push(r2(toFillUnit(p.x)), r2(-toFillUnit(p.y)));
      pourFill.push({ id: randId(), strokeWidth: 0, fill: true, path: [[flat[0], flat[1], 'L', ...flat.slice(2), flat[0], flat[1]]] });
    }
    if (pourFill.length) {
      push('POURED', { pourFill }, JSON.stringify(['POURED', pourId]));
    }
  }
}

// mil-unit closed polyline (bare start + "L" tokens) → "R" descriptor when the
// path is an axis-aligned rectangle, else null.
function rectDescriptor(poly) {
  if (poly[2] !== 'L') return null;
  const rest = poly.slice(3);
  if (rest.length % 2 !== 0 || rest.some(v => typeof v !== 'number')) return null;
  const pts = [[poly[0], poly[1]]];
  for (let i = 0; i < rest.length; i += 2) pts.push([rest[i], rest[i + 1]]);
  if (pts.length !== 5) return null;
  const [x0, y0] = pts[0];
  if (pts[4][0] !== x0 || pts[4][1] !== y0) return null;
  const xs = new Set(pts.slice(0, 4).map(p => p[0])), ys = new Set(pts.slice(0, 4).map(p => p[1]));
  if (xs.size !== 2 || ys.size !== 2) return null;
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return ['R', minX, maxY, r2(maxX - minX), r2(maxY - minY), 0, 0];
}

// KiCad mm → 0.254 mm canvas unit (10 mil) — the POURED fill coordinate unit.
function toFillUnit(mm) {
  return mm / 0.254;
}


function convertFootprint(node, ctx) {
  const { netNames, usedNets, ensureFootprintDoc, nextTicket, push, body } = ctx;
  const fpName = node[1]?.v || 'FP';
  const at = findSub(node, 'at');
  const layerArr = findSub(node, 'layer');
  const fpLayer = layerArr ? layerArr[0] : 'F.Cu';
  const pads = extractPads(node);
  // KiCad board files store the pad angle in board space (library angle +
  // footprint rotation), while the FOOTPRINT doc is local to the footprint and
  // the COMPONENT rotation is applied on top. Subtract the footprint angle so
  // rotated footprints (e.g. J1 at 90°) are not rotated twice.
  const fpAngle = parseFloat(at && at[2]) || 0;
  for (const p of pads) p.angle = ((p.angle - fpAngle) % 360 + 360) % 360;
  const shapes = extractFpShapes(node);
  const texts = extractFpTexts(node);
  const lib = ensureFootprintDoc(fpName, { pads, shapes, value: texts.Value || '' });
  for (const p of pads) { const n = normNet(p.netName); if (n) usedNets.add(n); }

  const compId = randId();
  // KiCad and eprj3 both rotate CCW on screen, so the footprint angle passes
  // through unchanged. Negating it (the old Y-flip reasoning) rotated the
  // footprint's internals to the wrong side of the anchor — the U1/J1 offset.
  const compAngle = (((parseFloat(at && at[2]) || 0) % 360) + 360) % 360;
  const cx = toMil(at && at[0] || 0);
  const cy = flipY(at && at[1] || 0);
  const pinSwapInfo = {};
  for (const p of lib.pads) pinSwapInfo[compId + p.id] = { pinClass: '', differentialPairClass: '' };
  const atTicket = push('COMPONENT', {
    partitionId: '', groupId: 0, layerId: /B\./.test(fpLayer) ? 2 : 1,
    x: cx, y: cy, angle: compAngle,
    attrs: {
      'Reuse Block': '', 'Group ID': '', 'Channel ID': '',
      'Unique ID': texts.Reference || 'gge' + (++ggeCounter),
      DeviceName: JSON.stringify({ uuid: lib.devUuid, name: fpName, source: '' })
    },
    locked: false, zIndex: -1, pinSwap: false, pinSwapInfo, footprintPrimitives: true
  }, compId);
  body.push(pcbAttr(nextTicket(), compId, 'Footprint', lib.docUuid, null, null, false, compAngle, atTicket));
  body.push(pcbAttr(nextTicket(), compId, 'Device', lib.devUuid, null, null, false, compAngle, -1));
  const designator = texts.Reference || '';
  if (designator) body.push(pcbAttr(nextTicket(), compId, 'Designator', designator, cx, cy, true, compAngle, atTicket));
  lib.pads.forEach((p, idx) => {
    const netName = normNet(pads[idx] && pads[idx].netName);
    if (!netName) return;
    body.push({
      head: { type: 'PAD_NET', ticket: nextTicket(), id: JSON.stringify(['PAD_NET', compId, p.num, p.id]) },
      body: { partitionId: '', padNet: netName, padLen: null, propagationDelay: null, attrsMap: {} }
    });
  });
}

function pcbAttr(ticket, parentId, key, value, x, y, valueVisible, angle, zIndex) {
  return {
    head: { type: 'ATTR', ticket, id: randId() },
    body: {
      partitionId: '', groupID: 0, parentId, layerId: 3, x, y,
      key, value, keyVisible: false, valueVisible,
      fontFamily: 'default', fontSize: 45, strokeWidth: 6,
      bold: 0, italic: 0, origin: 'LEFT_BOTTOM', angle,
      reverse: false, expansion: 0, mirror: false, locked: false, zIndex, specialColor: null
    }
  };
}

function chainSegments(segments) {
  const EPS = 0.5; // mil
  // Euclidean, not the old box test (|dx|,|dy|): dense arc samples can sit
  // ~0.5 mil apart in each axis while being ~0.7 mil apart in reality; the box
  // test would let the greedy chain skip real samples and strand fragments.
  const near = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2) < EPS;
  const remaining = segments.map(s => s.slice());
  const chains = [];
  while (remaining.length) {
    const chain = remaining.shift();
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const s = remaining[i];
        const headX = chain[chain.length - 2], headY = chain[chain.length - 1];
        const tailX = chain[0], tailY = chain[1];
        if (near(headX, headY, s[0], s[1])) { chain.push(s[2], s[3]); }
        else if (near(headX, headY, s[2], s[3])) { chain.push(s[0], s[1]); }
        else if (near(tailX, tailY, s[2], s[3])) { chain.unshift(s[0], s[1]); }
        else if (near(tailX, tailY, s[0], s[1])) { chain.unshift(s[2], s[3]); }
        else continue;
        remaining.splice(i, 1);
        extended = true;
      }
    }
    chains.push(chain);
  }
  return chains;
}

function extractFpShapes(node) {
  const out = [];
  for (const it of node.slice(1)) {
    if (!Array.isArray(it)) continue;
    const h = it[0].v;
    if (h === 'fp_line' || h === 'fp_rect') {
      const xy = findSub(it, 'start');
      const xy2 = findSub(it, 'end');
      const layerArr = findSub(it, 'layer');
      out.push({
        kind: h,
        x1: xy ? +xy[0] : 0, y1: xy ? +xy[1] : 0,
        x2: xy2 ? +xy2[0] : 0, y2: xy2 ? +xy2[1] : 0,
        layer: layerArr ? layerArr[0] : 'F.SilkS',
        width: strokeWidthOf(it, 0.15)
      });
    } else if (h === 'fp_circle') {
      const c = findSub(it, 'center');
      const e = findSub(it, 'end');
      const layerArr = findSub(it, 'layer');
      if (!c || !e) continue;
      const r = Math.hypot(+e[0] - +c[0], +e[1] - +c[1]);
      out.push({ kind: h, cx: +c[0], cy: +c[1], r, layer: layerArr ? layerArr[0] : 'F.SilkS', width: strokeWidthOf(it, 0.15) });
    } else if (h === 'fp_arc') {
      const a = require('./lib/kicad').extractArc(it);
      const layerArr = findSub(it, 'layer');
      if (a.mx == null) continue;
      out.push({ kind: h, ...a, layer: layerArr ? layerArr[0] : 'F.SilkS', width: strokeWidthOf(it, 0.15) });
    } else if (h === 'fp_poly') {
      const layerArr = findSub(it, 'layer');
      out.push({ kind: h, pts: extractPts(it), layer: layerArr ? layerArr[0] : 'F.SilkS', width: strokeWidthOf(it, 0.15) });
    }
  }
  return out;
}

function extractFpTexts(node) {
  const out = {};
  for (const it of node.slice(1)) {
    if (!Array.isArray(it) || it[0].v !== 'fp_text') continue;
    const kind = it[1]?.v;       // reference | value | user
    const text = it[2]?.v || '';
    if ((kind === 'reference' || kind === 'value') && !out[kind === 'reference' ? 'Reference' : 'Value']) {
      out[kind === 'reference' ? 'Reference' : 'Value'] = text;
    }
  }
  // KiCad >= 8 stores reference/value as (property "Reference" "R1") too
  const props = collectProperties(node);
  if (props.Reference && !out.Reference) out.Reference = props.Reference;
  if (props.Value && !out.Value) out.Value = props.Value;
  return out;
}

main().catch(err => die(err.stack || err.message, 1));