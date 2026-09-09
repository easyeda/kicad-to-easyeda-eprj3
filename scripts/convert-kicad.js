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
 *     + COMPONENT + PAD_NET, gr_line→LINE, gr_arc→ARC, gr_rect/gr_poly/gr_circle/
 *     bezier→POLY, gr_text→STRING, zone→POUR+POURED (keepout→REGION),
 *     dimension→DIMENSION, Edge.Cuts→POLY BOARD_OUTLINE
 * Not migrated: 3D models, net classes, SPICE models, custom rules; anything
 * unrecognized is skipped with a warning.
 */
const fs = require('fs');
const path = require('path');
const { parse: parseSex, nodeSymbol, extractPts } = require('./lib/kicad');
const {
  buildSymbolRecords, buildFootprintRecords, kicadToEprj3, flipY, flipRot,
  circumcenter, arcSweep, mapStroke, mapFill
} = require('./lib/kicad-to-eprj3');
const { Project, uuid, randId, writeRecords, sheetDocRecords, pcbDocRecords } = require('./lib/eprj3');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'project-name', hasValue: true, desc: 'Override project name' }
];

function toMil(x) { return kicadToEprj3(parseFloat(x)); }

function docHead(docType, docUuid) {
  return { head: { type: 'DOCHEAD' }, body: { docType, client: uuid(16), uuid: docUuid, updateTime: Date.now(), version: String(Date.now()), editVersion: '2.3.0', user: {} } };
}

function metaRec(title, extra = {}) {
  return { head: { type: 'META', ticket: 1, id: 'META' }, body: { title, description: '', tags: [], source: '', ...extra } };
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
  const usage = 'convert-kicad.js convert <KiCadProjectDir> <eprj3Dir> [--project-name <name>]';
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
  const project = await Project.create(dst, projectName);
  console.log(`Created eprj3 project at ${dst}`);

  // Walk schematics
  const schs = fs.readdirSync(src).filter(f => f.endsWith('.kicad_sch'));
  let schIdx = 1;
  for (const schFile of schs) {
    const sch = project.ensureSchematic(`Schematic${schIdx++}`);
    const sheet = project.ensureSheet(sch, 'P1');
    const file = project.sheetFile(sheet);
    convertSchematic(path.join(src, schFile), file, sch, sheet);
    project.save();
    console.log(`  sch: ${schFile} -> ${file}`);
  }

  // Walk PCBs
  const pcbs = fs.readdirSync(src).filter(f => f.endsWith('.kicad_pcb'));
  let pcbIdx = 1;
  for (const pcbFile of pcbs) {
    const pcb = project.ensurePcb(`PCB${pcbIdx++}`);
    const file = project.pcbFile(pcb);
    convertPcb(path.join(src, pcbFile), file, pcb);
    project.save();
    console.log(`  pcb: ${pcbFile} -> ${file}`);
  }

  if (warnCounter > 30) console.warn(`  warn: ... ${warnCounter} warnings total`);
}

// ---------------------------------------------------------------- schematic

function convertSchematic(srcFile, dst, sch, sheet) {
  const root = parseSex(fs.readFileSync(srcFile, 'utf8'));

  // lib_symbols: top-level entries are keyed by full lib_id (e.g. "Device:R")
  const libs = {};
  for (const node of root.slice(1)) {
    if (Array.isArray(node) && node[0].v === 'lib_symbols') {
      for (const symNode of node.slice(1)) {
        if (Array.isArray(symNode) && symNode[0].v === 'symbol') {
          const sym = nodeSymbol(symNode);
          if (sym.name) libs[sym.name] = sym;
        }
      }
    }
  }

  const libDocs = [];
  const usedLibs = {};
  function ensureSymbolDoc(libId) {
    if (usedLibs[libId]) return usedLibs[libId];
    const shortName = libId.split(':').pop();
    const libSym = libs[libId] || libs[shortName];
    const name = (libSym && libSym.name) || shortName;
    const isPower = /^power:/i.test(libId);
    const symDocUuid = uuid(16);
    const devUuid = uuid(16);
    const { records: symRecs, partId } = buildSymbolRecords(libSym || { name, pins: [], shapes: [] });
    libDocs.push(
      docHead('SYMBOL', symDocUuid),
      metaRec(name, { docType: isPower ? 18 : 2 }),
      ...symRecs
    );
    libDocs.push(
      docHead('DEVICE', devUuid),
      metaRec(name, { images: [], attributes: { Symbol: symDocUuid } })
    );
    usedLibs[libId] = { symDocUuid, devUuid, partId, name };
    return usedLibs[libId];
  }

  const pageRecords = sheetDocRecords(sch, sheet); // DOCHEAD SCH_PAGE + META + CANVAS
  let ticket = 2;
  let busEntryOrder = 0;
  let componentZ = 0; // placed components need a real zIndex (official exports use 1,2,3…)
  const rec = (type, body) => {
    ticket++;
    pageRecords.push({ head: { type, ticket, id: randId() }, body: { ...body, zIndex: body.zIndex != null ? body.zIndex : ticket } });
  };

  for (const node of root.slice(1)) {
    if (!Array.isArray(node)) continue;
    const head = node[0].v;

    if (head === 'wire' || head === 'bus') {
      const groupId = randId();
      rec(head === 'wire' ? 'WIRE' : 'BUS', head === 'wire' ? { groupId: '', locked: false } : { busEntry: {} });
      const pts = extractWirePoints(node);
      for (let i = 0; i < pts.length - 1; i++) {
        ticket++;
        pageRecords.push({
          head: { type: 'LINE', ticket, id: randId() },
          body: {
            fillColor: null, fillStyle: 'NONE', strokeColor: null, strokeStyle: 'SOLID', strokeWidth: null,
            startX: toMil(pts[i][0]), startY: flipY(pts[i][1]),
            endX: toMil(pts[i + 1][0]), endY: flipY(pts[i + 1][1]),
            lineGroup: groupId
          }
        });
      }
    } else if (head === 'bus_entry') {
      const at = findSub(node, 'at');
      const size = findSub(node, 'size');
      if (!at || !size) { warn('bus_entry without at/size'); continue; }
      const x1 = toMil(at[0]), y1 = flipY(at[1]);
      const x2 = toMil(parseFloat(at[0]) + parseFloat(size[0])), y2 = flipY(parseFloat(at[1]) + parseFloat(size[1]));
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
        centerX: toMil(x), centerY: flipY(y), radius: toMil(d) / 2,
        strokeColor: null, strokeStyle: 'SOLID', fillColor: '#000000', strokeWidth: null, fillStyle: 'SOLID'
      });
    } else if (head === 'no_connect') {
      const [x, y] = findAtXY(node);
      const cx = toMil(x), cy = flipY(y);
      const h = 25; // half diagonal of the X marker (mil)
      const ncGroup = randId();
      for (const [dx, dy] of [[h, h], [h, -h]]) {
        rec('LINE', {
          fillColor: null, fillStyle: null, strokeColor: null, strokeStyle: null, strokeWidth: 2,
          startX: cx - dx, startY: cy - dy, endX: cx + dx, endY: cy + dy, lineGroup: ncGroup
        });
      }
    } else if (head === 'label' || head === 'global_label' || head === 'hierarchical_label') {
      const [x, y] = findAtXY(node);
      const val = findValue(node);
      ticket++;
      pageRecords.push({
        head: { type: 'NETLABEL', ticket, id: randId() },
        body: { x: toMil(x), y: flipY(y), color: '#FF0000', fontFamily: 'Arial', fontSize: 12, align: 'CENTER_MIDDLE', value: val, locked: false, zIndex: ticket }
      });
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
          x1 = toMil(pts[0][0]); y1 = flipY(pts[0][1]); x2 = toMil(pts[2][0]); y2 = flipY(pts[2][1]);
        } else if (s && e) {
          x1 = toMil(s[0]); y1 = flipY(s[1]); x2 = toMil(e[0]); y2 = flipY(e[1]);
        } else { x1 = x2 = toMil(x); y1 = y2 = flipY(y); }
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
          groupId: '', x: toMil(x), y: flipY(y), rotation: flipRot(rot || 0), color: null, fontFamily: null,
          fontSize: fx.size || 25, fontWeight: fx.bold || null, italic: fx.italic || null,
          underline: null, strikeout: null, align: fx.align, value: val, fillColor: null,
          locked: false, zIndex: ticket
        }
      });
    } else if (head === 'polyline') {
      const pts = extractWirePoints(node);
      if (pts.length < 2) continue;
      rec('POLY', shapeCommon(node, {
        points: pts.map(p => ({ x: toMil(p[0]), y: flipY(p[1]) })),
        closed: false, startShape: 'NONE', endShape: 'NONE'
      }));
    } else if (head === 'rectangle') {
      const s = findSub(node, 'start');
      const e = findSub(node, 'end');
      if (!s || !e) continue;
      rec('RECT', shapeCommon(node, {
        dotX1: toMil(s[0]), dotY1: flipY(s[1]), dotX2: toMil(e[0]), dotY2: flipY(e[1]),
        radiusX: 0, radiusY: 0, rotation: 0
      }));
    } else if (head === 'circle') {
      const c = findSub(node, 'center');
      const r = findSub(node, 'radius');
      if (!c || !r) continue;
      rec('CIRCLE', shapeCommon(node, {
        centerX: toMil(c[0]), centerY: flipY(c[1]), radius: toMil(r[0])
      }));
    } else if (head === 'arc') {
      const a = require('./lib/kicad').extractArc(node);
      if (a.mx == null) continue;
      const cx1 = toMil(a.x1), cy1 = flipY(a.y1);
      const cxm = toMil(a.mx), cym = flipY(a.my);
      const cx2 = toMil(a.x2), cy2 = flipY(a.y2);
      const c = circumcenter(cx1, cy1, cxm, cym, cx2, cy2);
      rec('ARC', shapeCommon(node, {
        startX: cx1, startY: cy1, referX: c.x, referY: c.y, endX: cx2, endY: cy2
      }));
    } else if (head === 'bezier') {
      const pts = extractWirePoints(node);
      if (pts.length < 4) continue;
      rec('BEZIER', shapeCommon(node, {
        controls: pts.flatMap(p => [toMil(p[0]), flipY(p[1])])
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
          fileName: 'image.png', startX: toMil(x), startY: flipY(y),
          width: Math.round(200 * sx), height: Math.round(200 * sy),
          rotation: 0, isMirror: false,
          content: 'data:image/png;base64,' + dataArr[0]
        }
      });
    } else if (head === 'sheet') {
      convertHierSheet(node, rec);
    } else if (head === 'symbol') {
      const libId = findChildValue(node, 'lib_id');
      if (!libId) continue;
      const lib = ensureSymbolDoc(libId);
      const [x, y, rot] = findAtXY(node);
      const props = collectProperties(node);
      const mirrors = findFlags(node, 'mirror');
      let isMirror = mirrors.includes('y');
      let rotation = flipRot(rot || 0);
      if (mirrors.includes('x')) { isMirror = true; rotation = (rotation + 180) % 360; }
      const compId = randId();
      ticket++;
      pageRecords.push({
        head: { type: 'COMPONENT', ticket, id: compId },
        body: {
          partId: lib.partId,
          x: toMil(x), y: flipY(y), rotation, isMirror,
          attrs: {
            Footprints: '[]', Devices: '[]',
            DeviceName: JSON.stringify({ uuid: lib.devUuid, name: props.Value || lib.name || libId, source: '' }),
            FootprintName: null, pinClass: {}, differentialPairClass: {}, Symbols: '[]'
          },
          zIndex: ++componentZ
        }
      });
      // Binding ATTRs, as in official app exports: EasyEDA resolves the placed
      // symbol through them (Symbol = SYMBOL doc uuid, Device = DEVICE doc uuid);
      // without them the instance renders empty.
      pageRecords.push(pageLinkAttr(compId, ++ticket, 'Symbol', lib.symDocUuid));
      pageRecords.push(pageLinkAttr(compId, ++ticket, 'Device', lib.devUuid));
      pageRecords.push(pageLinkAttr(compId, ++ticket, 'Unique ID', 'gge' + (++ggeCounter)));
      if (props.Reference) pageRecords.push(pageAttr(compId, ++ticket, 'Designator', props.Reference, toMil(x) + 10, flipY(y) - 10, 'LEFT_TOP'));
      if (props.Value) pageRecords.push(pageAttr(compId, ++ticket, 'Value', props.Value, toMil(x) + 10, flipY(y) + 10, 'LEFT_BOTTOM'));
    } else if (!['lib_symbols', 'uuid', 'paper', 'title_block', 'version', 'generator', 'generator_version', 'junction', 'at', 'instances', 'path', 'sheet_instances', 'embedded_fonts'].includes(head)) {
      warn(`schematic: unhandled "${head}" skipped`);
    }
  }

  writeRecords(dst, [...libDocs, ...pageRecords]);
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
function convertHierSheet(node, rec) {
  const at = findSub(node, 'at');
  const size = findSub(node, 'size');
  const props = collectProperties(node);
  if (!at || !size) { warn('sheet without at/size'); return; }
  const x = toMil(at[0]), y = flipY(at[1]);
  const x2 = toMil(parseFloat(at[0]) + parseFloat(size[0]));
  const y2 = flipY(parseFloat(at[1]) + parseFloat(size[1]));
  rec('RECT', {
    partId: '', groupId: '', locked: false,
    dotX1: x, dotY1: y, dotX2: x2, dotY2: y2,
    radiusX: 0, radiusY: 0, rotation: 0,
    strokeColor: null, strokeStyle: null, fillColor: '', strokeWidth: 2, fillStyle: 'NONE'
  });
  const name = props['Sheet name'] || props['SheetName'] || '';
  if (name) {
    rec('TEXT', {
      groupId: '', x: (x + x2) / 2, y: Math.max(y, y2) + 10, rotation: 0, color: null, fontFamily: null,
      fontSize: 25, fontWeight: null, italic: null, underline: null, strikeout: null, align: 'CENTER_BOTTOM',
      value: name, fillColor: null, locked: false
    });
  }
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'pin') {
      const pinName = it[1]?.v || '';
      const atSub = findSub(it, 'at');
      if (!atSub) continue;
      rec('NETLABEL', {
        x: toMil(atSub[0]), y: flipY(atSub[1]), color: '#0000FF', fontFamily: 'Arial',
        fontSize: 12, align: 'CENTER_MIDDLE', value: pinName, locked: false
      });
    }
  }
}

function textEffects(node) {
  const out = { size: null, bold: null, italic: null, align: null };
  const eff = findSubNode(node, 'effects');
  if (!eff) return out;
  const font = findSubNode(eff, 'font');
  if (font) {
    const size = findSub(font, 'size');
    if (size) out.size = Math.max(5, Math.round(toMil(size[0])));
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

function pageAttr(parentId, ticket, key, value, x, y, align) {
  return {
    head: { type: 'ATTR', ticket, id: randId() },
    body: {
      x, y, rotation: 0, color: null, fontFamily: null, fontSize: 10,
      fontWeight: null, italic: null, underline: null, strikeout: null, align,
      value, keyVisible: false, valueVisible: true, key,
      fillColor: null, groupId: '', parentId, zIndex: ticket, locked: false
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

function convertPcb(srcFile, dst, pcb) {
  const root = parseSex(fs.readFileSync(srcFile, 'utf8'));

  // (net <num> "<name>") table at board level
  const netNames = {};
  for (const node of root.slice(1)) {
    if (Array.isArray(node) && node[0].v === 'net' && node[1] && /^\d+$/.test(node[1].v || '')) {
      const name = node[2]?.v || '';
      if (name) netNames[node[1].v] = name;
    }
  }

  const libDocs = [];
  const usedFps = {};
  function ensureFootprintDoc(name, fpData) {
    if (usedFps[name]) return usedFps[name];
    const docUuid = uuid(16);
    const devUuid = uuid(16);
    // Library docs carry no instance nets — nets are wired per placement via PAD_NET.
    const anonymized = { ...fpData, pads: fpData.pads.map(p => ({ ...p, netName: '' })) };
    const { records: fpRecs, pads } = buildFootprintRecords({ name, pads: anonymized.pads, shapes: anonymized.shapes, value: fpData.value });
    libDocs.push(docHead('FOOTPRINT', docUuid), metaRec(name), ...fpRecs);
    libDocs.push(docHead('DEVICE', devUuid), metaRec(name, { images: [], attributes: { Symbol: '', Footprint: docUuid } }));
    usedFps[name] = { docUuid, devUuid, pads };
    return usedFps[name];
  }

  const docRecords = pcbDocRecords(pcb); // DOCHEAD PCB + META + CANVAS + LAYERs + ACTIVE_LAYER
  let ticket = docRecords.length;
  const body = [];
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
      convertFootprint(node, {
        netNames, usedNets, usedFps, ensureFootprintDoc, nextTicket, push, body
      });
    } else if (head === 'gr_line' || head === 'gr_arc' || head === 'gr_rect' || head === 'gr_circle' || head === 'gr_poly' || head === 'bezier') {
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
          outlinePaths.push(arcOutlinePath(s, m, e));
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
        const path = [...flat, flat[0], flat[1]];
        if (isEdge) outlinePaths.push(path);
        else push('POLY', { ...pcbLineCommon, netName: '', layerId: layerToId(lname), width: toMil(strokeWidthOf(node, 0.15)), path, polyType: 'NORMAL' });
      } else if (head === 'bezier') {
        const pts = extractPts(node);
        if (!pts || pts.length < 4) continue;
        const flat = [];
        for (const p of pts) flat.push(toMil(p.x), flipY(p.y));
        push('POLY', {
          ...pcbLineCommon, netName: '', layerId: layerToId(lname), width: toMil(strokeWidthOf(node, 0.15)),
          path: [flat[0], flat[1], 'C', ...flat.slice(2)], polyType: 'NORMAL'
        });
      }
    } else if (head === 'gr_text') {
      const val = typeof node[1]?.v === 'string' ? node[1].v : '';
      if (!val) continue;
      push('STRING', pcbString(node, val));
    } else if (head === 'dimension') {
      convertDimension(node, push);
    } else if (head === 'zone') {
      convertZone(node, { netNames, usedNets, push });
    } else if (!['kicad_pcb', 'version', 'generator', 'generator_version', 'general', 'paper', 'layers', 'setup', 'net', 'property', 'images', 'group', 'embedded_fonts'].includes(head)) {
      warn(`pcb: unhandled "${head}" skipped`);
    }
  }

  // Stitch Edge.Cuts line segments into (closed where possible) outline polylines
  for (const chain of chainSegments(openSegments)) {
    const closed = Math.abs(chain[0] - chain[chain.length - 2]) < 0.5 && Math.abs(chain[1] - chain[chain.length - 1]) < 0.5;
    const path = closed ? chain : [...chain, chain[0], chain[1]];
    outlinePaths.push(path);
  }
  for (const path of outlinePaths) {
    push('POLY', { ...pcbLineCommon, netName: '', layerId: 11, width: 10, path, polyType: 'BOARD_OUTLINE' });
  }

  // NET index records (payload as written by the official app; head id is the net name)
  for (const netName of usedNets) {
    ticket++;
    body.push({
      head: { type: 'NET', ticket, id: netName },
      body: { netType: null, specialColor: null, retLine: true, differentialName: null, isPositiveNet: false, equalLengthGroupName: null }
    });
  }

  writeRecords(dst, [...libDocs, ...docRecords, ...body]);
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

// Edge.Cuts arc → closed outline single-polygon with an ARC segment
function arcOutlinePath(s, m, e) {
  const x1 = toMil(s[0]), y1 = flipY(s[1]);
  const mx = toMil(m[0]), my = flipY(m[1]);
  const x2 = toMil(e[0]), y2 = flipY(e[1]);
  const { sweep } = arcSweep(x1, y1, mx, my, x2, y2);
  return [x1, y1, 'ARC', r2(sweep), x2, y2, x1, y1];
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
    angle: flipRot(at && at[2] || 0),
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
function convertZone(node, { netNames, usedNets, push }) {
  const minThick = findSub(node, 'min_thickness');
  const width = minThick ? toMil(minThick[0]) : 10;
  const nameArr = findSub(node, 'name');
  const prioArr = findSub(node, 'priority');
  const keepout = findSubNode(node, 'keepout');

  // polygons: one or more (polygon (pts ...))
  const polys = [];
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'polygon') {
      const pts = extractPts(it);
      if (pts && pts.length > 2) {
        const flat = [];
        for (const p of pts) flat.push(r2(toMil(p.x)), r2(flipY(p.y)));
        polys.push([...flat, flat[0], flat[1]]);
      }
    }
  }

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
  const netName = (netNameArr && netNameArr[0]) || (netArr ? (netNames[netArr[0]] || '') : '');
  if (netName) usedNets.add(netName);

  if (!polys.length) { warn('zone without polygon'); return; }

  for (const lname of layers) {
    const pourId = randId();
    push('POUR', {
      partitionId: '', groupId: 0, locked: false, zIndex: -1,
      netName, layerId: layerToId(lname), width,
      name: (nameArr && nameArr[0]) || '', order: prioArr ? parseInt(prioArr[0], 10) || 0 : 0,
      path: polys, pourType: { pourType: 'SOLID', fineness: 8 }, keepIsland: false
    }, pourId);
    // poured fill results: one POURED per zone+layer, head id = ["POURED", pourId]
    const pourFill = [];
    for (const it of node.slice(1)) {
      if (!(Array.isArray(it) && it[0].v === 'filled_polygon')) continue;
      const fpLayer = findSub(it, 'layer');
      if (fpLayer && fpLayer[0] !== lname) continue;
      const pts = extractPts(it);
      if (!pts || pts.length < 3) continue;
      const flat = [];
      for (const p of pts) flat.push(r2(toMil(p.x)), r2(flipY(p.y)));
      pourFill.push({ id: randId(), strokeWidth: 0, fill: true, path: [[...flat, flat[0], flat[1]]] });
    }
    if (pourFill.length) {
      push('POURED', { pourFill }, JSON.stringify(['POURED', pourId]));
    }
  }
}


function convertFootprint(node, ctx) {
  const { netNames, usedNets, ensureFootprintDoc, nextTicket, push, body } = ctx;
  const fpName = node[1]?.v || 'FP';
  const at = findSub(node, 'at');
  const layerArr = findSub(node, 'layer');
  const fpLayer = layerArr ? layerArr[0] : 'F.Cu';
  const pads = extractPads(node);
  const shapes = extractFpShapes(node);
  const texts = extractFpTexts(node);
  const lib = ensureFootprintDoc(fpName, { pads, shapes, value: texts.Value || '' });
  for (const p of pads) if (p.netName) usedNets.add(p.netName);

  const compId = randId();
  const compAngle = flipRot(at && at[2] || 0);
  const cx = toMil(at && at[0] || 0);
  const cy = flipY(at && at[1] || 0);
  const atTicket = push('COMPONENT', {
    partitionId: '', groupId: 0, layerId: /B\./.test(fpLayer) ? 2 : 1,
    x: cx, y: cy, angle: compAngle,
    attrs: {
      'Reuse Block': '', 'Group ID': '', 'Channel ID': '',
      'Unique ID': 'gge' + (++ggeCounter),
      DeviceName: JSON.stringify({ uuid: lib.devUuid, name: fpName, source: '' })
    },
    locked: false, zIndex: -1, pinSwap: false, pinSwapInfo: {}, footprintPrimitives: true
  }, compId);
  body.push(pcbAttr(nextTicket(), compId, 'Footprint', lib.docUuid, null, null, false, compAngle, atTicket));
  body.push(pcbAttr(nextTicket(), compId, 'Device', lib.devUuid, null, null, false, compAngle, -1));
  const designator = texts.Reference || '';
  if (designator) body.push(pcbAttr(nextTicket(), compId, 'Designator', designator, cx, cy, true, compAngle, atTicket));
  lib.pads.forEach((p, idx) => {
    const netName = pads[idx] && pads[idx].netName;
    if (!netName) return;
    body.push({
      head: { type: 'PAD_NET', ticket: nextTicket(), id: JSON.stringify(['PAD_NET', compId, p.num, p.id]) },
      body: { partitionId: '', componentId: compId, padNum: p.num, padNet: netName, padId: p.id, padLen: 0, propagationDelay: 0, attrsMap: {} }
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
  const near = (x1, y1, x2, y2) => Math.abs(x1 - x2) < EPS && Math.abs(y1 - y2) < EPS;
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

function extractPads(node) {
  const pads = [];
  for (const it of node.slice(1)) if (Array.isArray(it) && it[0].v === 'pad') {
    // (pad "<num>" <smd|thru_hole|np_thru_hole> <rect|circle|oval|roundrect|custom|trapezoid> ...)
    const pad = { number: it[1]?.v || '', type: it[2]?.v || 'smd', shape: it[3]?.v || 'rect', at: [], size: [], layers: [], angle: 0, netName: '', drill: null, drillOval: null };
    for (const sub of it.slice(1)) {
      if (!Array.isArray(sub)) continue;
      const sh = sub[0].v;
      if (sh === 'at') { pad.at = sub.slice(1).map(x => x.v); if (pad.at.length > 2) pad.angle = parseFloat(pad.at[2]) || 0; }
      else if (sh === 'size') pad.size = sub.slice(1).map(x => x.v);
      else if (sh === 'layers') pad.layers = sub.slice(1).map(x => x.v);
      else if (sh === 'drill') {
        const nums = sub.slice(1).filter(x => typeof x.v === 'string' && /^[\d.]+$/.test(x.v)).map(x => x.v);
        const isOval = sub.slice(1).some(x => x.v === 'oval');
        pad.drill = nums[0];
        if (isOval && nums[1]) pad.drillOval = nums[1];
      }
      else if (sh === 'net') pad.netName = sub[2]?.v || '';
    }
    pads.push(pad);
  }
  return pads;
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