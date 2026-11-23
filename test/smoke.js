#!/usr/bin/env node
'use strict';
/**
 * smoke.js — End-to-end regression test for the KiCad → eprj3 converter.
 *
 * Runs the real scripts against a throwaway directory in the OS temp dir and
 * asserts the invariants that have historically regressed:
 *   - KiCad symbol parser handles nested unit symbols (pins/shapes merged)
 *   - converter maps layer names to the right layer ids (B.Cu → 2)
 *   - PCB doc defines the official 60-layer stack with layerId fields
 *   - uuid linkage: page/pcb/ecfg DOCHEAD uuids equal the index profile uuids
 *   - schematic embeds SYMBOL + DEVICE docs; COMPONENT partId/DeviceName link to them
 *   - pcb embeds FOOTPRINT + DEVICE docs, COMPONENT placements, PAD_NET/NET records
 *   - Edge.Cuts becomes a POLY BOARD_OUTLINE on layer 11
 *   - track segments become LINE records, track arcs become ARC records
 *   - schematic primitives: bus/bus_entry/junction/no_connect/labels/text/shapes
 *   - pcb primitives: via/track-arc/gr_arc/gr_circle/gr_poly/gr_text/zone/dimension
 *   - library dir → elibz2: device2.json + <name>.elibu with linked uuids
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const { readRecords } = require(path.join(SCRIPTS, 'lib', 'eprj3'));
const { kicadToEprj3, kicadToSchUnit, flipYSch } = require(path.join(SCRIPTS, 'lib', 'kicad-to-eprj3'));

let failures = 0;
let checks = 0;
function assert(cond, name, detail = '') {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}

function run(args, expectCode = 0) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT });
  if (expectCode !== null && r.status !== expectCode) {
    assert(false, `node ${path.basename(args[0])} ${args.slice(1, 3).join(' ')}`,
      `exit ${r.status} (expected ${expectCode})\n${(r.stdout || '') + (r.stderr || '')}`.trim());
  }
  return r;
}

const kicadSymSample = `(kicad_symbol_lib (version 20220914) (generator kicad_symbol_editor)
  (symbol "MY_RES" (pin_numbers hide) (pin_names (offset 0) hide) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "MY_RES" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (property "Footprint" "MY_FP:R_0805" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "MY_RES_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
      (polyline (pts (xy -1.016 3.81) (xy 1.016 3.81)) (stroke (width 0) (type default)) (fill (type none)))
      (arc (start -1.016 2.54) (mid 0 3.048) (end 1.016 2.54) (stroke (width 0.1524) (type default)) (fill (type none)))
    )
    (symbol "MY_RES_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
    )
  )
)`;

const kicadSchSample = `(kicad_sch (version 20230121) (generator eeschema)
  (lib_symbols
    (symbol "Device:R" (pin_numbers hide)
      (property "Reference" "R" (at 2 0 90) (effects (font (size 1.27 1.27))))
      (symbol "Device:R_0_1"
        (rectangle (start -1 -2.5) (end 1 2.5) (stroke (width 0.25) (type default)) (fill (type none)))
        (polyline (pts (xy -1 2.54) (xy 1 2.54)) (stroke (width 0) (type default)) (fill (type none)))
        (arc (start -1 2.54) (mid 0 3.048) (end 1 2.54) (stroke (width 0.1524) (type default)) (fill (type none)))
      )
      (symbol "Device:R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
      )
    )
  )
  (wire (pts (xy 10 10) (xy 20 10)))
  (bus (pts (xy 10 20) (xy 20 20)))
  (bus_entry (at 10 20) (size 2.54 2.54) (stroke (width 0) (type default)))
  (junction (at 15 10) (diameter 0) (color 0 0 0 0))
  (no_connect (at 25 10) (uuid x))
  (label "NET1" (at 10 10 0) (effects (font (size 1.27 1.27))))
  (global_label "GLOB" (at 20 30 0) (effects (font (size 1.27 1.27))))
  (text "hello" (at 40 40 0) (effects (font (size 2 2))))
  (rectangle (start 50 10) (end 60 20) (stroke (width 0.25) (type solid)) (fill none))
  (circle (center 65 15) (radius 2) (stroke (width 0.25) (type solid)) (fill none))
  (arc (start 70 10) (mid 72.5 12.5) (end 75 10) (stroke (width 0.25) (type solid)) (fill none))
  (symbol (lib_id "Device:R") (at 30 50 0) (unit 1)
    (property "Reference" "R1" (at 30 48 0) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 30 52 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "Package:R_0805" (at 30 50 0) (effects (font (size 1.27 1.27))))
  )
)`;

const kicadPcbSample = `(kicad_pcb (version 20221018) (generator pcbnew)
  (net 0 "")
  (net 1 "GND")
  (net 2 "VCC")
  (segment (start 0 0) (end 10 0) (width 0.25) (layer "B.Cu") (net 1))
  (arc (start 10 0) (mid 12.5 2.5) (end 15 0) (width 0.25) (layer "B.Cu") (net 1))
  (via (at 15 0) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))
  (gr_rect (start 0 0) (end 40 30) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))
  (gr_circle (center 20 25) (end 22 25) (stroke (width 0.15) (type solid)) (fill none) (layer "F.SilkS"))
  (gr_arc (start 30 25) (mid 32.5 22.5) (end 35 25) (stroke (width 0.15) (type solid)) (fill none) (layer "F.SilkS"))
  (gr_poly (pts (xy 0 25) (xy 5 25) (xy 5 30)) (stroke (width 0.15) (type solid)) (fill none) (layer "F.SilkS"))
  (gr_curve (pts (xy 10 20) (xy 15 30) (xy 25 10) (xy 30 20)) (stroke (width 0.15) (type solid)) (fill none) (layer "F.SilkS"))
  (gr_text "board" (at 10 35 0) (layer "F.SilkS") (effects (font (size 1.2 1.2) (thickness 0.2))))
  (dimension (type aligned) (layer "Cmts.User") (pts (xy 0 0) (xy 40 0)) (height 5)
    (gr_text "40 mm" (at 20 -2 0)) (style (thickness 0.2)))
  (zone (net 2) (net_name "VCC") (layer "F.Cu") (name "zone1") (min_thickness 0.2)
    (polygon (pts (xy 0 0) (xy 40 0) (xy 40 30) (xy 0 30)))
    (filled_polygon (layer "F.Cu") (pts (xy 0.5 0.5) (xy 39.5 0.5) (xy 39.5 29.5) (xy 0.5 29.5))))
  (zone (net "GND") (layer "F.Cu") (name "zone2") (min_thickness 0.2)
    (polygon (pts (xy 0 0) (xy 20 0) (xy 20 15) (xy 0 15))))
  (footprint "R_0603" (layer "F.Cu") (at 5 5 90)
    (property "Reference" "R1" (at 5 4 0) (layer "F.SilkS"))
    (pad "1" smd rect (at -0.75 0 90) (size 0.8 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "GND"))
    (pad "2" smd custom (at 0.75 0 90) (size 0.8 0.8) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "GND")
      (options (clearance outline) (anchor circle))
      (primitives
        (gr_poly (pts (xy -0.4 -0.4) (xy 0.4 -0.4) (xy 0.4 0.4) (xy -0.4 0.4)) (width 0) (fill yes))))
    (fp_line (start -1.5 -0.8) (end 1.5 -0.8) (stroke (width 0.1) (type solid)) (layer "F.SilkS"))
    (fp_arc (start -1 -1) (mid 0 0) (end 1 -1) (stroke (width 0.15) (type solid)) (layer "F.SilkS"))
  )
)`;

const kicadFpSample = `(footprint "R_0805" (layer "F.Cu")
  (at 0 0)
  (attr smd)
  (fp_text reference "REF**" (at 0 -1.43 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (fp_line (start -1 -0.6) (end 1 -0.6) (stroke (width 0.1) (type solid)) (layer "F.SilkS"))
  (fp_arc (start -1 -1) (mid 0 0) (end 1 -1) (stroke (width 0.15) (type solid)) (layer "F.SilkS"))
  (pad "1" smd rect (at -0.9 0) (size 0.8 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "2" smd rect (at 0.9 0) (size 0.8 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
)`;

function docSegments(records) {
  // Split a record list into doc segments at DOCHEAD boundaries
  const docs = [];
  let cur = null;
  for (const r of records) {
    if (r.type === 'DOCHEAD') { cur = { head: r, records: [] }; docs.push(cur); }
    else if (cur) cur.records.push(r);
  }
  return docs;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kicad2eprj3-smoke-'));

  try {
    fs.writeFileSync(path.join(tmp, 'sample.kicad_sym'), kicadSymSample);
    fs.writeFileSync(path.join(tmp, 'sample.kicad_sch'), kicadSchSample);
    fs.writeFileSync(path.join(tmp, 'sample.kicad_pcb'), kicadPcbSample);

    // ---- project conversion (batch: walks every .kicad_sch / .kicad_pcb) ----
    const dst = path.join(tmp, 'conv');
    run([SCRIPTS + '/convert-kicad.js', 'convert', tmp, dst, '--project-name', 'conv']);
    assert(fs.existsSync(path.join(dst, 'conv.eprj3')), 'convert-kicad creates the project index');

    const index = JSON.parse(fs.readFileSync(path.join(dst, 'conv.eprj3'), 'utf8'));
    const boards = Object.values(index.profile.boards);
    const schEntry = Object.values(index.profile.schematics)[0];
    const sheetEntry = Object.values(index.profile.sheets)[0];
    const pcbEntry = Object.values(index.profile.pcbs)[0];
    assert(boards.length === 1 && boards[0].uuid.length === 16, 'one board with a 16-hex uuid');
    assert(index.owner_uuid.length === 32, 'owner uuid is 32 hex (official length)');

    // ---- schematic side ----
    assert(fs.existsSync(path.join(dst, 'sch', 'sample', 'sample.ecfg')), 'convert-kicad writes the schematic .ecfg');
    assert(fs.existsSync(path.join(dst, 'sch', 'sample', 'sample.evar')), 'convert-kicad writes the schematic .evar');
    const ecfg = readRecords(path.join(dst, 'sch', 'sample', 'sample.ecfg'));
    const ecfgHead = ecfg.find(r => r.type === 'DOCHEAD');
    assert(ecfgHead && ecfgHead.body.docType === 'SCH' && ecfgHead.body.uuid === schEntry.uuid,
      '.ecfg is a SCH doc whose uuid equals the index schematic uuid');

    const convSch = readRecords(path.join(dst, 'sch', 'sample', 'sample.esch2'));
    const schDocs = docSegments(convSch);
    const pageDoc = schDocs[schDocs.length - 1];
    const symDocs = schDocs.filter(d => d.head.body.docType === 'SYMBOL');
    const devDocs = schDocs.filter(d => d.head.body.docType === 'DEVICE');
    assert(pageDoc && pageDoc.head.body.docType === 'SCH_PAGE', 'last .esch2 segment is a SCH_PAGE doc');
    assert(pageDoc.head.body.uuid === sheetEntry.uuid, 'page DOCHEAD uuid equals the index sheet uuid');
    const pageMeta = pageDoc.records.find(r => r.type === 'META');
    assert(pageMeta && pageMeta.body.title === 'sample' && pageMeta.body.schematic === schEntry.uuid && pageMeta.body.zIndex === 1,
      'page META links title/schematic/zIndex per the official format');
    // frame docs (docType 20) + one SYMBOL/DEVICE pair per used lib_id
    const symMeta = d => { const m = d.records.find(r => r.type === 'META'); return m ? m.body.docType : null; };
    const partDocs = schDocs.filter(d => d.head.body.docType === 'SYMBOL' && symMeta(d) === 2);
    const devDocsAll = schDocs.filter(d => d.head.body.docType === 'DEVICE');
    const frameDoc = schDocs.find(d => d.head.body.docType === 'SYMBOL' && symMeta(d) === 20);
    assert(frameDoc && partDocs.length === 1 && devDocsAll.length === 2,
      '.esch2 embeds the A4 frame doc plus one SYMBOL and one DEVICE doc');
    const symDoc = partDocs[0];
    const symPart = symDoc.records.find(r => r.type === 'PART');
    const comp = pageDoc.records.find(r => r.type === 'COMPONENT' && r.body.partId === symPart.head.id);
    assert(comp && symPart && comp.body.partId === symPart.head.id, 'COMPONENT.partId references the embedded PART id');
    const devName = comp && JSON.parse(comp.body.attrs.DeviceName);
    const devHead = devDocsAll[0] && devDocsAll[0].head;
    assert(devName && devHead && devDocsAll.some(d => d.head.body.uuid === devName.uuid),
      'COMPONENT DeviceName uuid references the embedded DEVICE doc');
    const compDev = devDocsAll.find(d => d.head.body.uuid === devName.uuid);
    const compDevMeta = compDev && compDev.records.find(r => r.type === 'META');
    const compDevFp = compDevMeta && compDevMeta.body.attributes && compDevMeta.body.attributes.FootprintName;
    const devFp = compDevFp ? JSON.parse(compDevFp) : null;
    assert(!!devFp && devFp.name === 'Package:R_0805' && devFp.uuid === '',
      'DEVICE META.attributes.FootprintName carries the symbol footprint name');
    assert(typeof comp.body.zIndex === 'number', 'COMPONENT carries a numeric zIndex (official exports)');
    const compFp = comp.body.attrs.FootprintName ? JSON.parse(comp.body.attrs.FootprintName) : null;
    assert(!!compFp && compFp.name === 'Package:R_0805' && compFp.uuid === '' && compFp.source === '',
      'COMPONENT.attrs.FootprintName carries the KiCad footprint name in the official JSON string form',
      JSON.stringify(comp.body.attrs.FootprintName));
    const symAttr = pageDoc.records.find(r => r.type === 'ATTR' && r.body.key === 'Symbol' && r.body.parentId === comp.head.id);
    const devAttr = pageDoc.records.find(r => r.type === 'ATTR' && r.body.key === 'Device' && r.body.parentId === comp.head.id);
    assert(symAttr && symAttr.body.value === symDoc.head.body.uuid, 'COMPONENT Symbol ATTR references the SYMBOL doc uuid');
    assert(devAttr && devAttr.body.value === devName.uuid, 'COMPONENT Device ATTR references the DEVICE doc uuid');
    assert(!(comp.body.id), 'COMPONENT body carries no duplicate id field');
    assert(convSch.some(r => r.type === 'ATTR' && r.body.key === 'Designator' && r.body.value === 'R1')
        && convSch.some(r => r.type === 'ATTR' && r.body.key === 'Name' && r.body.value === '10k'),
      'convert-kicad emits Designator/Name ATTRs linked to the component');
    const frameComp = pageDoc.records.find(r => r.type === 'COMPONENT' && r.body.zIndex === null);
    const pageAttrs = pageDoc.records.filter(r => r.type === 'ATTR');
    assert(pageAttrs.every(r => r.body.parentId === comp.head.id || (frameComp && r.body.parentId === frameComp.head.id)),
      'every page ATTR.parentId == COMPONENT id (frame attrs belong to the frame COMPONENT)');
    const wireRec = pageDoc.records.find(r => r.type === 'WIRE');
    assert(pageDoc.records.some(r => r.type === 'LINE' && r.body.lineGroup)
      && wireRec && pageDoc.records.some(r => r.type === 'LINE' && r.body.lineGroup === wireRec.head.id),
      'WIRE head.id equals the LINE children lineGroup (official grouping)');
    assert(pageDoc.records.some(r => r.type === 'LINE' && r.body.startY < 0), 'page items map into the frame area (y <= 0)');
    // symbol geometry: sch units, Y negated (KiCad lib Y-up → eprj3 records Y-down), identity pin rotation
    const pinDown = symDoc.records.filter(r => r.type === 'PIN');
    const pinAtTop = pinDown.find(p => Math.abs(p.body.y + kicadToSchUnit(3.81)) < 0.01);
    assert(!!pinAtTop && pinAtTop.body.rotation === 270 && Math.abs(pinAtTop.body.length - kicadToSchUnit(1.27)) < 0.01
      && pinAtTop.body.display === true,
      'PIN flips y into the Y-down record space, keeps rotation, carries display:true',
      JSON.stringify(pinDown.map(p => ({ y: p.body.y, rot: p.body.rotation }))));
    const pinTypeAttr = symDoc.records.find(r => r.type === 'ATTR' && r.body.key === 'Pin Type');
    assert(!!pinTypeAttr && pinTypeAttr.body.value === 'Undefined' && pinTypeAttr.body.x === null,
      'Pin Type ATTR carries the electric type with null position (official shape)');
    const symArc = symDoc.records.find(r => r.type === 'ARC');
    assert(!!symArc && Math.abs(symArc.body.referX) < 0.01
      && Math.abs(symArc.body.referY + kicadToSchUnit(3.048)) < 0.01,
      'symbol arc refer is the KiCad mid point, not the circumcenter',
      symArc && JSON.stringify({ referX: symArc.body.referX, referY: symArc.body.referY }));
    const symZeroStroke = symDoc.records.find(r => r.type === 'POLY' && r.body.strokeWidth === null);
    assert(!!symZeroStroke, 'KiCad stroke width 0 maps to the client default (null strokeWidth)');
    const compAttr = pageDoc.records.find(r => r.type === 'ATTR' && r.body.key === 'Designator' && r.body.parentId === comp.head.id);
    assert(compAttr && Math.abs(compAttr.body.y - (kicadToSchUnit(48) - 825)) < 0.01
      && Math.abs(compAttr.body.x - kicadToSchUnit(30)) < 0.01,
      'Designator ATTR sits at the KiCad property position on the shifted page frame');
    const nameAttr = pageDoc.records.find(r => r.type === 'ATTR' && r.body.key === 'Name' && r.body.parentId === comp.head.id);
    assert(nameAttr && Math.abs(nameAttr.body.y - (kicadToSchUnit(52) - 825)) < 0.01,
      'Name ATTR sits at the KiCad Value property position');

    // ---- pcb side ----
    const convPcb = readRecords(path.join(dst, 'pcb', 'PCB1.epcb2'));
    const pcbDocs = docSegments(convPcb);
    const pcbDoc = pcbDocs[pcbDocs.length - 1];
    assert(pcbDoc.head.body.docType === 'PCB' && pcbDoc.head.body.uuid === pcbEntry.uuid,
      'PCB DOCHEAD uuid equals the index pcb uuid');
    const pcbMeta = pcbDoc.records.find(r => r.type === 'META');
    assert(pcbMeta && pcbMeta.body.title === 'PCB1' && pcbMeta.body.board === boards[0].uuid && pcbMeta.body.parent === '',
      'PCB META links title/board/parent per the official format');
    const layers = pcbDoc.records.filter(r => r.type === 'LAYER');
    assert(layers.length === 60, 'PCB doc defines the official 60-layer stack', `layers=${layers.length}`);
    assert(layers.every(r => r.body.layerId !== undefined), 'LAYER payloads carry layerId');
    const outline = pcbDoc.records.find(r => r.type === 'POLY' && r.body.polyType === 'BOARD_OUTLINE');
    assert(outline && outline.body.layerId === 11, 'Edge.Cuts becomes a BOARD_OUTLINE POLY on layer 11');
    const track = pcbDoc.records.find(r => r.type === 'LINE');
    assert(track && track.body.layerId === 2 && track.body.netName === 'GND', 'B.Cu segments become LINE tracks on layerId 2 with net name');
    assert(track && Math.abs(track.body.width - kicadToEprj3(0.25)) < 0.01, 'track keeps the KiCad wire width');
    assert(!pcbDoc.records.some(r => r.type === 'FILL'), 'tracks are not emitted as FILL fill regions');

    const fpDocs = pcbDocs.filter(d => d.head.body.docType === 'FOOTPRINT');
    const pcbDevDocs = pcbDocs.filter(d => d.head.body.docType === 'DEVICE');
    assert(fpDocs.length === 1 && pcbDevDocs.length === 1, '.epcb2 embeds FOOTPRINT and DEVICE docs');
    assert(convPcb.some(r => r.type === 'PAD' && r.body.num === '1'), 'footprint doc contains pads');
    const fpDoc = fpDocs[0];
    assert(!!fpDoc && !fpDoc.records.some(r => r.type === 'ARC'),
      'FOOTPRINT doc emits no standalone ARC record (client drops components after it, issue #4)');
    const fpArcPoly = fpDoc && fpDoc.records.find(r => r.type === 'POLY' && Array.isArray(r.body.path) && r.body.path.includes('ARC'));
    assert(!!fpArcPoly && fpArcPoly.body.path[2] === 'ARC' && fpArcPoly.body.layerId === 3
      && Math.abs(fpArcPoly.body.path[3]) > 0 && Math.abs(fpArcPoly.body.path[3]) < 360,
      'fp_arc becomes a POLY with an ARC path and a valid sweep angle', fpArcPoly && JSON.stringify(fpArcPoly.body.path));
    const pcbComp = pcbDoc.records.find(r => r.type === 'COMPONENT');
    assert(pcbComp && pcbComp.body.layerId === 1, 'PCB COMPONENT placements reference a copper layer');
    assert(pcbComp && pcbComp.body.angle === 90,
      'a footprint rotated 90° keeps a 90° component angle (both formats are CCW on screen)',
      pcbComp && pcbComp.body.angle);
    const fpPad = fpDoc && fpDoc.records.find(r => r.type === 'PAD' && r.body.num === '1');
    assert(!!fpPad && fpPad.body.padAngle === 0,
      'pad angle is stored relative to the footprint (no double rotation)',
      fpPad && JSON.stringify({ padAngle: fpPad.body.padAngle }));
    const fpCustomFill = fpDoc && fpDoc.records.find(r => r.type === 'FILL' && r.body.layerId === 1);
    assert(!!fpCustomFill && fpCustomFill.body.fillStyle === 'SOLID' && Array.isArray(fpCustomFill.body.path),
      'custom pad fill becomes a FILL on F.Cu');
    const fpCustomPad = fpDoc && fpDoc.records.find(r => r.type === 'PAD' && r.body.num === '2');
    assert(!!fpCustomPad && fpCustomPad.body.defaultPad.padType === 'ELLIPSE',
      'custom pad keeps a circular anchor PAD');
    const pcbDevName = pcbComp && JSON.parse(pcbComp.body.attrs.DeviceName);
    assert(pcbDevName && pcbDevName.uuid === pcbDevDocs[0].head.body.uuid, 'PCB COMPONENT DeviceName references the DEVICE doc');
    const padNet = pcbDoc.records.find(r => r.type === 'PAD_NET');
    assert(padNet && padNet.head.id.includes(pcbComp.head.id) && padNet.head.id.includes('"1"') && padNet.body.padNet === 'GND',
      'PAD_NET links component pad to its net');
    assert(pcbDoc.records.some(r => r.type === 'NET' && r.head.id === JSON.stringify(['NET','GND'])), 'NET index record exists for used nets');
    const desig = pcbDoc.records.find(r => r.type === 'ATTR' && r.body.key === 'Designator');
    assert(desig && desig.body.value === 'R1' && desig.body.parentId === pcbComp.head.id, 'PCB Designator ATTR linked to COMPONENT');

    // ---- schematic primitives (new coverage) ----
    const busEntry = pageDoc.records.find(r => r.type === 'BUSENTRY');
    assert(!!busEntry && busEntry.body.rotation % 90 === 0, 'bus_entry becomes a BUSENTRY with 90° rotation');
    assert(pageDoc.records.some(r => r.type === 'BUS'), 'bus becomes a BUS record');
    const junction = pageDoc.records.find(r => r.type === 'CIRCLE' && r.body.fillStyle === 'SOLID');
    assert(!!junction && junction.body.radius > 0, 'junction becomes a filled CIRCLE dot');
    const ncLines = pageDoc.records.filter(r => r.type === 'LINE' && r.body.strokeWidth === 1);
    assert(ncLines.length === 2 && ncLines[0].body.lineGroup && ncLines[0].body.lineGroup === ncLines[1].body.lineGroup,
      'no_connect becomes two LINE records sharing a group id');
    assert(pageDoc.records.some(r => r.type === 'NETLABEL' && r.body.value === 'GLOB'), 'global_label becomes a NETLABEL');
    const txt = pageDoc.records.find(r => r.type === 'TEXT' && r.body.value === 'hello');
    assert(txt && Math.abs(txt.body.x - kicadToSchUnit(40)) < 0.01 && txt.body.y < 0 && txt.body.fontSize === 7.87,
      'text becomes a TEXT record in flipped 0.254 mm units (2 mm font = 7.87 units)');
    const pageRect = pageDoc.records.find(r => r.type === 'RECT' && Math.abs(r.body.dotX1 - kicadToSchUnit(50)) < 0.01);
    assert(!!pageRect, 'page rectangle becomes a RECT');
    const pageCircle = pageDoc.records.find(r => r.type === 'CIRCLE' && Math.abs(r.body.radius - kicadToSchUnit(2)) < 0.01);
    assert(!!pageCircle, 'page circle becomes a CIRCLE');
    const pageArc = pageDoc.records.find(r => r.type === 'ARC');
    assert(!!pageArc && Math.abs(pageArc.body.referX - kicadToSchUnit(72.5)) < 0.01
      && Math.abs(pageArc.body.referY - (kicadToSchUnit(12.5) - 825)) < 0.01,
      'page arc refer is the KiCad mid point (not the circumcenter)',
      pageArc && JSON.stringify({ referX: pageArc.body.referX, referY: pageArc.body.referY }));
    // Drawing sheet / title block: graphics are POLY (not WIRE), and the table
    // is anchored to the inner A4 border instead of hanging outside it.
    const framePolys = pageDoc.records.filter(r => r.type === 'POLY' && Array.isArray(r.body.points));
    assert(framePolys.length > 10, 'drawing sheet frame/table is emitted as POLY records', `polys=${framePolys.length}`);
    assert(pageDoc.records.filter(r => r.type === 'WIRE').length === 1,
      'drawing sheet lines are not emitted as WIRE records');
    const framePt = (x, y) => framePolys.some(r => r.body.points.some(p => Math.abs(p.x - x) < 0.01 && Math.abs(p.y - y) < 0.01));
    assert(framePt(kicadToSchUnit(297 - 12), flipYSch(210 - 12, 825)),
      'title block bottom-right sits on the inner A4 border');
    assert(!framePt(kicadToSchUnit(295), flipYSch(208, 825)),
      'title block is not drawn outside the frame');

    // ---- pcb primitives (new coverage) ----
    const via = pcbDoc.records.find(r => r.type === 'VIA');
    assert(via && Math.abs(via.body.viaDiameter - kicadToEprj3(0.8)) < 0.01 && Math.abs(via.body.holeDiameter - kicadToEprj3(0.4)) < 0.01,
      'via becomes a VIA with via/hole diameters');
    const arcTrack = pcbDoc.records.find(r => r.type === 'ARC' && r.body.layerId === 2);
    assert(!!arcTrack && arcTrack.body.netName === 'GND' && typeof arcTrack.body.angle === 'number',
      'track arc becomes an ARC record with a sweep angle');
    const grArc = pcbDoc.records.find(r => r.type === 'ARC' && r.body.layerId === 3);
    assert(!!grArc, 'gr_arc becomes an ARC on the silkscreen layer');
    const grCircle = pcbDoc.records.find(r => r.type === 'POLY' && Array.isArray(r.body.path[0]) && r.body.path[0][0] === 'CIRCLE');
    assert(!!grCircle && grCircle.body.layerId === 3, 'gr_circle becomes a POLY with a CIRCLE path');
    const grPoly = pcbDoc.records.find(r => r.type === 'POLY' && r.body.polyType === 'NORMAL' && !Array.isArray(r.body.path[0]));
    assert(!!grPoly && grPoly.body.layerId === 3, 'gr_poly becomes a closed NORMAL POLY');
    const grCurve = pcbDoc.records.find(r => r.type === 'POLY'
      && Math.abs(r.body.path[0] - kicadToEprj3(10)) < 0.01
      && Math.abs(r.body.path[1] + kicadToEprj3(20)) < 0.01);
    assert(!!grCurve && grCurve.body.layerId === 3 && grCurve.body.path[2] === 'L'
      && grCurve.body.path.filter(v => typeof v === 'string').every(v => v === 'L'),
      'gr_curve is flattened to an L-only POLY (no C token)', grCurve && JSON.stringify(grCurve.body.path).slice(0, 120));
    assert(!!grCurve && (grCurve.body.path.length - 1) / 2 >= 12,
      'gr_curve keeps enough samples for a smooth curve');
    assert(!pcbDoc.records.some(r => r.type === 'POLY' && Array.isArray(r.body.path) && r.body.path.includes('C')),
      'no POLY path uses the client-rejected C token');
    const str = pcbDoc.records.find(r => r.type === 'STRING' && r.body.text === 'board');
    assert(!!str && str.body.layerId === 3, 'gr_text becomes a STRING record');
    const dim = pcbDoc.records.find(r => r.type === 'DIMENSION');
    assert(dim && dim.body.dimensionType === 'LENGTH-CONSTRAINT' && dim.body.controlDot.length === 8, 'dimension becomes a LENGTH-CONSTRAINT DIMENSION');
    const pours = pcbDoc.records.filter(r => r.type === 'POUR');
    const pour = pours.find(r => r.body.name === 'zone1');
    const pour2 = pours.find(r => r.body.name === 'zone2');
    const poured = pcbDoc.records.find(r => r.type === 'POURED');
    assert(pour && pour.body.netName === 'VCC' && pour.body.layerId === 1 && pour.body.pourType.fineness === 8,
      'zone becomes a POUR on F.Cu with its net (default fineness 8)');
    assert(pour2 && pour2.body.netName === 'GND', 'zone (net "GND") keeps the name-string net');
    assert(poured && pour && poured.head.id === JSON.stringify(['POURED', pour.head.id]) && poured.body.pourFill.length >= 1,
      'filled_polygon becomes a POURED linked to the POUR');
    assert(pcbDoc.records.some(r => r.type === 'NET' && r.head.id === JSON.stringify(['NET','VCC'])), 'NET index record exists for zone net');

    // ---- KiCad library dir → elibz2 package ----
    const libDir = path.join(tmp, 'libsrc');
    fs.mkdirSync(path.join(libDir, 'MY_FP.pretty'), { recursive: true });
    fs.writeFileSync(path.join(libDir, 'MY_LIB.kicad_sym'), kicadSymSample);
    fs.writeFileSync(path.join(libDir, 'MY_FP.pretty', 'R_0805.kicad_mod'), kicadFpSample);
    const elibzPath = path.join(tmp, 'MYLIB.elibz2');
    run([SCRIPTS + '/convert-kicad-lib.js', 'convert', libDir, elibzPath, '--name', 'MYLIB']);

    const { readZip } = require(path.join(SCRIPTS, 'lib', 'zip'));
    const zipEntries = readZip(fs.readFileSync(elibzPath));
    assert(zipEntries.some(e => e.name === 'device2.json'), 'elibz2 contains device2.json');
    const elibuEntry = zipEntries.find(e => e.name === 'MYLIB.elibu');
    assert(!!elibuEntry, 'elibz2 contains <name>.elibu');

    const device2 = JSON.parse(zipEntries.find(e => e.name === 'device2.json').data.toString('utf8'));
    const symUuids = Object.keys(device2.symbols);
    const fpUuids = Object.keys(device2.footprints);
    assert(symUuids.length === 1 && fpUuids.length === 1, 'device2 indexes one symbol and one footprint');
    assert(device2.symbols[symUuids[0]].docType === 2 && device2.footprints[fpUuids[0]].docType === 4,
      'index docTypes: symbol 2 / footprint 4');
    const devUuids = Object.keys(device2.devices);
    const dev = device2.devices[devUuids[0]];
    assert(dev && dev.attributes.Symbol === symUuids[0] && dev.attributes.Footprint === fpUuids[0],
      'device attributes link the symbol + footprint (via the KiCad Footprint property)');
    assert(dev && dev.attributes.Designator === 'R?', 'device Designator derives from the Reference property');

    const elibuFile = path.join(tmp, 'MYLIB.elibu');
    fs.writeFileSync(elibuFile, elibuEntry.data);
    const elibu = readRecords(elibuFile);
    const elibuDocs = docSegments(elibu);
    // each library doc is written as two segments (DOCHEAD+META, DOCHEAD+records);
    // merge segments that share the same doc uuid
    const elibuByUuid = {};
    for (const d of elibuDocs) {
      const u = d.head.body.uuid;
      if (!elibuByUuid[u]) elibuByUuid[u] = { head: d.head, records: [] };
      elibuByUuid[u].records.push(...d.records);
    }
    const libSymDoc = elibuByUuid[symUuids[0]];
    const libFpDoc = elibuByUuid[fpUuids[0]];
    assert(!!libSymDoc && libSymDoc.head.body.uuid === symUuids[0], 'elibu SYMBOL doc uuid matches the device2 index');
    assert(libSymDoc && libSymDoc.records.some(r => r.type === 'PIN'), 'library symbol doc contains PIN records');
    assert(libSymDoc && libSymDoc.records.some(r => r.type === 'META' && r.body.docType === 2), 'symbol META carries docType 2');
    assert(!!libFpDoc && libFpDoc.head.body.uuid === fpUuids[0], 'elibu FOOTPRINT doc uuid matches the device2 index');
    assert(libFpDoc && libFpDoc.records.filter(r => r.type === 'LAYER').length === 19, 'footprint doc defines the 19-layer table');
    assert(libFpDoc && libFpDoc.records.some(r => r.type === 'PAD' && r.body.num === '1'), 'footprint doc contains pads');
    assert(libFpDoc && !libFpDoc.records.some(r => r.type === 'PART'), 'library footprint docs carry no PART record');
    assert(libFpDoc && !libFpDoc.records.some(r => r.type === 'ARC'),
      'library FOOTPRINT docs emit no standalone ARC record (issue #4)');
    const libFpArc = libFpDoc && libFpDoc.records.find(r => r.type === 'POLY' && Array.isArray(r.body.path) && r.body.path.includes('ARC'));
    assert(!!libFpArc && libFpArc.body.path[2] === 'ARC' && Math.abs(libFpArc.body.path[3]) < 360,
      'library fp_arc becomes a POLY with an ARC path');

    // ---- PCB outline shapes (regressions: circular / polygonal boards) ----
    const roundrect = [
      '(gr_line (start 0 25) (end 0 5) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))',
      '(gr_arc (start 0 5) (mid 1.4645 1.4645) (end 5 0) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))',
      '(gr_line (start 5 0) (end 35 0) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))',
      '(gr_arc (start 35 0) (mid 38.5355 1.4645) (end 40 5) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))',
      '(gr_line (start 40 5) (end 40 25) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))',
      '(gr_arc (start 40 25) (mid 38.5355 28.5355) (end 35 30) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))',
      '(gr_line (start 35 30) (end 5 30) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))',
      '(gr_arc (start 5 30) (mid 1.4645 28.5355) (end 0 25) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))'
    ].join('\n  ');
    const outlineCases = {
      rect: '(gr_rect (start 0 0) (end 40 30) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))',
      poly: '(gr_poly (pts (xy 0 0) (xy 30 0) (xy 40 20) (xy 15 30) (xy 0 20)) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))',
      circle: '(gr_circle (center 20 20) (end 35 20) (stroke (width 0.05) (type solid)) (fill none) (layer "Edge.Cuts"))',
      roundrect
    };
    for (const [name, shape] of Object.entries(outlineCases)) {
      const dir = path.join(tmp, 'outline-' + name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'board.kicad_pcb'),
        `(kicad_pcb (version 20221018) (generator pcbnew)\n  (net 0 "")\n  ${shape}\n)\n`);
      const out = path.join(tmp, 'outline-out-' + name);
      run([SCRIPTS + '/convert-kicad.js', 'convert', dir, out, '--project-name', 'board']);
      const outDocs = docSegments(readRecords(path.join(out, 'pcb', 'PCB1.epcb2')));
      const outDoc = outDocs[outDocs.length - 1];
      const outlines2 = outDoc.records.filter(r => r.type === 'POLY' && r.body.polyType === 'BOARD_OUTLINE');
      assert(outlines2.length === 1, `${name} board outline converts to one BOARD_OUTLINE`, `count=${outlines2.length}`);
      const p = outlines2[0] && outlines2[0].body.path;
      if (name === 'rect') {
        assert(Array.isArray(p) && p[0] === 'R', 'rect board outline uses the R descriptor');
      } else if (name === 'circle') {
        assert(Array.isArray(p) && Array.isArray(p[0]) && p[0][0] === 'CIRCLE',
          'circle board outline uses a nested CIRCLE path');
      } else {
        const tokens = Array.isArray(p) ? p.filter(v => typeof v === 'string') : [];
        const pts = Array.isArray(p) ? (p.length - 1) / 2 : 0;
        assert(Array.isArray(p) && p[2] === 'L' && tokens.every(t => t === 'L'),
          `${name} board outline is an L-only path`);
        assert(pts >= (name === 'roundrect' ? 40 : 4), `${name} board outline has enough points`, `points=${pts}`);
        if (name === 'roundrect') {
          const pp = [];
          for (let i = 0; i < p.length; i++) {
            if (typeof p[i] === 'number' && typeof p[i + 1] === 'number') { pp.push([p[i], p[i + 1]]); i++; }
          }
          const xs = pp.map(q => q[0]), ys = pp.map(q => q[1]);
          assert(Math.abs(Math.min(...xs)) < 0.1 && Math.abs(Math.max(...xs) - kicadToEprj3(40)) < 0.1
            && Math.abs(Math.min(...ys) + kicadToEprj3(30)) < 0.1 && Math.abs(Math.max(...ys)) < 0.1,
            'roundrect board outline keeps the 40x30 mm bbox');
          assert(Math.abs(pp[0][0] - pp[pp.length - 1][0]) < 0.01 && Math.abs(pp[0][1] - pp[pp.length - 1][1]) < 0.01,
            'roundrect board outline closes on itself');
        }
      }
    }

    // ---- hierarchical sheets → block symbols (EDA links by schematic name) ----
    const rootSch = `(kicad_sch (version 20230121) (generator eeschema)
  (paper "A4")
  (sheet (at 50 50) (size 30 20)
    (stroke (width 0) (type solid)) (fill (color 0 0 0 0))
    (property "Sheetname" "childSheet" (at 50 49 0))
    (property "Sheetfile" "child.kicad_sch" (at 50 71 0))
    (pin "A" input (at 50 55 180))
    (pin "B" output (at 50 60 180))
  )
)`;
    const childSch = `(kicad_sch (version 20230121) (generator eeschema)
  (paper "A4")
  (hierarchical_label "A" (shape input) (at 30 30 180) (effects (font (size 1.27 1.27))))
)`;
    const hierDir = path.join(tmp, 'hier');
    fs.mkdirSync(hierDir, { recursive: true });
    fs.writeFileSync(path.join(hierDir, 'rootCase.kicad_sch'), rootSch);
    fs.writeFileSync(path.join(hierDir, 'child.kicad_sch'), childSch);
    const hierOut = path.join(tmp, 'hier-out');
    run([SCRIPTS + '/convert-kicad.js', 'convert', hierDir, hierOut, '--project-name', 'rootCase']);
    const hierIndex = JSON.parse(fs.readFileSync(path.join(hierOut, 'rootCase.eprj3'), 'utf8'));
    const hierSchs = Object.values(hierIndex.profile.schematics);
    const rootEntry = hierSchs.find(s => s.name === 'rootCase');
    const childEntry = hierSchs.find(s => s.name === 'child');
    assert(rootEntry && childEntry, 'KiCad root + child sheets become separate EasyEDA schematics');
    assert(rootEntry && childEntry && rootEntry.board && rootEntry.board === childEntry.board,
      'both schematics hang under the same board');
    const blockEntries = Object.values(hierIndex.profile.blockSymbols || {});
    assert(blockEntries.length === 1 && blockEntries[0].title === 'child' && blockEntries[0].docType === 17,
      'the hierarchical rectangle registers a docType-17 block symbol named after the child schematic',
      JSON.stringify(blockEntries));
    const rootEsch = readRecords(path.join(hierOut, 'sch', 'rootCase', 'rootCase.esch2'));
    const rootDocs = docSegments(rootEsch);
    const rootPage = rootDocs[rootDocs.length - 1];
    const blockDoc = rootDocs.find(d => d.head.body.docType === 'SYMBOL'
      && (d.records.find(r => r.type === 'META') || {}).body?.docType === 17);
    assert(!!blockDoc && blockDoc.head.body.uuid === blockEntries[0].uuid,
      'the root page embeds the block symbol document');
    const blockPins = blockDoc ? blockDoc.records.filter(r => r.type === 'PIN') : [];
    assert(blockPins.length === 2, 'block symbol carries one pin per KiCad sheet pin', `pins=${blockPins.length}`);
    const pinNames = blockDoc ? blockDoc.records.filter(r => r.type === 'ATTR' && r.body.key === 'Pin Name').map(r => r.body.value) : [];
    assert(pinNames.includes('A') && pinNames.includes('B'), 'block symbol pins keep the sheet pin names', pinNames.join(','));
    const blockRect = blockDoc && blockDoc.records.find(r => r.type === 'RECT');
    assert(!!blockRect && Math.abs(Math.abs(blockRect.body.dotX2 - blockRect.body.dotX1) - kicadToSchUnit(30)) < 0.01,
      'block symbol rectangle matches the KiCad sheet size');
    const blockComp = rootPage.records.find(r => r.type === 'COMPONENT' && r.body.partId === '1');
    assert(!!blockComp, 'the block symbol is placed as a COMPONENT on the parent page');
    const blockAttrs = rootPage.records.filter(r => r.type === 'ATTR' && blockComp && r.body.parentId === blockComp.head.id);
    const attrVal = k => (blockAttrs.find(a => a.body.key === k) || {}).body?.value;
    assert(attrVal('Symbol') === blockEntries[0].uuid && attrVal('Name') === 'child',
      'block symbol COMPONENT links Symbol/Name to the block document');
    assert(attrVal('Sheetname') === 'childSheet' && attrVal('Sheetfile') === 'child.kicad_sch',
      'block symbol keeps the KiCad Sheetname/Sheetfile metadata');
    const childEsch = readRecords(path.join(hierOut, 'sch', 'child', 'child.esch2'));
    const childDocs = docSegments(childEsch);
    const childPage = childDocs[childDocs.length - 1];
    const netportDoc = childDocs.find(d => d.head.body.docType === 'SYMBOL'
      && (d.records.find(r => r.type === 'META') || {}).body?.docType === 19);
    assert(!!netportDoc && netportDoc.records.find(r => r.type === 'META').body.title === 'A',
      'hierarchical_label becomes a net port document named after the net');
    const netportComp = childPage.records.find(r => r.type === 'COMPONENT' && r.body.partId === '1');
    const netportAttrs = netportComp ? childPage.records.filter(r => r.type === 'ATTR' && r.body.parentId === netportComp.head.id) : [];
    const nattr = k => (netportAttrs.find(a => a.body.key === k) || {}).body?.value;
    assert(!!netportComp && nattr('Symbol') === netportDoc.head.body.uuid && nattr('Name') === 'A',
      'net port component links Symbol/Name to the child net');
    // Multi-unit symbols must share one SYMBOL document with one PART per unit;
    // separate documents per unit made the netlist drop the device.
    const multiSch = `(kicad_sch (version 20230121) (generator eeschema) (paper "A4")
  (lib_symbols
    (symbol "mlib:U4" (property "Reference" "U")
      (symbol "U4_1_1" (pin input line (at -2 0 0) (length 1) (name "A") (number "1")))
      (symbol "U4_1_2" (pin input line (at -2 0 0) (length 1) (name "A") (number "1")))
      (symbol "U4_2_1" (pin output line (at 2 0 0) (length 1) (name "Y") (number "2")))
    )
  )
  (symbol (lib_id "mlib:U4") (at 20 20 0) (unit 1) (property "Reference" "U1") (property "Value" "74LS125"))
  (symbol (lib_id "mlib:U4") (at 40 20 0) (unit 2) (property "Reference" "U1") (property "Value" "74LS125"))
)`;
    const multiDir = path.join(tmp, 'multi');
    fs.mkdirSync(multiDir, { recursive: true });
    fs.writeFileSync(path.join(multiDir, 'multi.kicad_sch'), multiSch);
    const multiOut = path.join(tmp, 'multi-out');
    run([SCRIPTS + '/convert-kicad.js', 'convert', multiDir, multiOut, '--project-name', 'multi']);
    const multiDocs = docSegments(readRecords(path.join(multiOut, 'sch', 'multi', 'multi.esch2')));
    const symDocMeta = d => (d.records.find(r => r.type === 'META') || {}).body || {};
    const multiSymDocs = multiDocs.filter(d => d.head.body.docType === 'SYMBOL' && symDocMeta(d).docType === 2);
    const multiParts = multiSymDocs[0] ? multiSymDocs[0].records.filter(r => r.type === 'PART') : [];
    assert(multiSymDocs.length === 1 && multiParts.length === 2,
      'multi-unit symbol produces one SYMBOL doc with a PART per used unit',
      `docs=${multiSymDocs.length} parts=${multiParts.length}`);
    const multiPage = multiDocs[multiDocs.length - 1];
    const multiCompPartIds = multiPage.records.filter(r => r.type === 'COMPONENT').map(r => r.body.partId);
    assert(multiCompPartIds.includes('mlib:U4.1') && multiCompPartIds.includes('mlib:U4.2'),
      'each unit component points at its own PART id', multiCompPartIds.join(','));
    const multiDevices = multiDocs.filter(d => d.head.body.docType === 'DEVICE' && symDocMeta(d).title === 'mlib:U4');
    assert(multiDevices.length === 1, 'units share one DEVICE document', `devices=${multiDevices.length}`);
    const stylePins = multiSymDocs[0] ? multiSymDocs[0].records.filter(r => r.type === 'PIN').length : 0;
    assert(stylePins === 2, 'De Morgan style-2 pins are not duplicated into the doc', `pins=${stylePins}`);

    // KiCad 10 suffixes embedded symbols (BASE_1) while instances keep the base
    // lib_id; without a base-name fallback the symbol loses all pins.
    const suffixSch = `(kicad_sch (version 20230121) (generator eeschema) (paper "A4")
  (lib_symbols
    (symbol "DIODE_1" (property "Reference" "D") (property "Value" "DIODE")
      (symbol "DIODE_1_1_1"
        (pin passive line (at -2 0 0) (length 1) (name "K") (number "1"))
        (pin passive line (at 2 0 180) (length 1) (name "A") (number "2")))
    )
  )
  (symbol (lib_id "Sim:DIODE") (at 20 20 0) (unit 1)
    (property "Reference" "D1") (property "Value" "STPSC5H12D"))
)`;
    const suffixDir = path.join(tmp, 'suffix-sym');
    fs.mkdirSync(suffixDir, { recursive: true });
    fs.writeFileSync(path.join(suffixDir, 'suffix.kicad_sch'), suffixSch);
    const suffixOut = path.join(tmp, 'suffix-sym-out');
    run([SCRIPTS + '/convert-kicad.js', 'convert', suffixDir, suffixOut, '--project-name', 'suffix']);
    const suffixDocs = docSegments(readRecords(path.join(suffixOut, 'sch', 'suffix', 'suffix.esch2')));
    const suffixPins = suffixDocs.reduce((n, d) => n + d.records.filter(r => r.type === 'PIN').length, 0);
    assert(suffixPins === 2,
      'instances resolve embedded symbols disambiguated as BASE_<n>', `pins=${suffixPins}`);

    // Wires that share an endpoint (or meet at a KiCad junction) form ONE
    // EasyEDA WIRE group: separate groups would read as isolated nets.
    const wireSch = `(kicad_sch (version 20230121) (generator eeschema) (paper "A4")
  (wire (pts (xy 10 10) (xy 20 10)))
  (wire (pts (xy 20 10) (xy 20 20)))
  (wire (pts (xy 15 10) (xy 15 20)))
  (junction (at 15 10))
)`;
    const wireDir = path.join(tmp, 'wires');
    fs.mkdirSync(wireDir, { recursive: true });
    fs.writeFileSync(path.join(wireDir, 'wires.kicad_sch'), wireSch);
    const wireOut = path.join(tmp, 'wires-out');
    run([SCRIPTS + '/convert-kicad.js', 'convert', wireDir, wireOut, '--project-name', 'wires']);
    const wirePage = docSegments(readRecords(path.join(wireOut, 'sch', 'wires', 'wires.esch2'))).pop();
    const wireGroups = wirePage.records.filter(r => r.type === 'WIRE');
    const wireLines = wirePage.records.filter(r => r.type === 'LINE' && r.body.lineGroup);
    assert(wireGroups.length === 1,
      'connected wires are emitted as one WIRE group (shared endpoints + junction)',
      `groups=${wireGroups.length}`);
    assert(wireLines.length === 4 && wireLines.every(l => l.body.lineGroup === wireGroups[0].head.id),
      'junction splits the through wire and all segments share the WIRE group id',
      `lines=${wireLines.length}`);

    // Embedded docs must not collide across pages (CLI refuses to open then).
    const frameUuids = [rootEsch, childEsch].map(rs => {
      const ds = docSegments(rs);
      const f = ds.find(d => d.head.body.docType === 'SYMBOL'
        && (d.records.find(r => r.type === 'META') || {}).body?.docType === 20);
      return f && f.head.body.uuid;
    });
    assert(frameUuids[0] && frameUuids[1] && frameUuids[0] !== frameUuids[1],
      'each page embeds its own frame document uuid (no duplicate documents across pages)');


    // KiCad marks power symbols with a bare (power) node; the lib_id does NOT
    // have to start with "power:" (project-local symbols such as
    // custom_pads_schlib:GND). They must become EasyEDA power flags
    // (MAGIC_PART_ID, docType 18, DeviceName null), not regular devices.
    const powerSch = `(kicad_sch (version 20230121) (generator eeschema)
  (lib_symbols
    (symbol "custom_pads_schlib:GND" (power) (pin_names (offset 0))
      (property "Reference" "#PWR" (at 0 -6.35 0))
      (property "Value" "GND" (at 0 -3.81 0))
      (property "Footprint" "" (at 0 0 0))
      (symbol "GND_0_1"
        (polyline (pts (xy 0 0) (xy 0 -1.27)) (stroke (width 0) (type default)) (fill (type none)))
      )
      (symbol "GND_1_1"
        (pin power_in line (at 0 0 270) (length 0) (name "GND") (number "1"))
      )
    )
    (symbol "power:PWR_FLAG" (power) (pin_numbers hide)
      (property "Reference" "#FLG" (at 0 6.35 0))
      (property "Value" "PWR_FLAG" (at 0 3.81 0))
      (symbol "PWR_FLAG_0_1"
        (polyline (pts (xy 0 0) (xy 0 1.27)) (stroke (width 0) (type default)) (fill (type none)))
      )
      (symbol "PWR_FLAG_1_1"
        (pin power_out line (at 0 0 90) (length 0) (name "~") (number "1"))
      )
    )
  )
  (symbol (lib_id "custom_pads_schlib:GND") (at 50 60 0) (unit 1)
    (property "Reference" "#PWR01" (at 50 66 0))
    (property "Value" "GND" (at 50 63 0))
    (property "Footprint" "" (at 50 60 0))
  )
  (symbol (lib_id "power:PWR_FLAG") (at 50 60 0) (unit 1)
    (property "Reference" "#FLG01" (at 50 55 0))
    (property "Value" "PWR_FLAG" (at 50 57 0))
    (property "Footprint" "" (at 50 60 0))
  )
)`;
    const powerDir = path.join(tmp, 'power-sym');
    fs.mkdirSync(powerDir, { recursive: true });
    fs.writeFileSync(path.join(powerDir, 'power.kicad_sch'), powerSch);
    const powerOut = path.join(tmp, 'power-sym-out');
    run([SCRIPTS + '/convert-kicad.js', 'convert', powerDir, powerOut, '--project-name', 'power']);
    const { parse: parseSex, nodeSymbol } = require(path.join(SCRIPTS, 'lib', 'kicad'));
    const powerLib = parseSex(powerSch).slice(1).find(n => Array.isArray(n) && n[0].v === 'lib_symbols');
    const gndSymNode = powerLib.slice(1).find(n => Array.isArray(n) && n[0].v === 'symbol');
    assert(nodeSymbol(gndSymNode).isPower === true,
      'KiCad parser flags (power) symbols even without the power: lib_id prefix');
    const powerEsch = readRecords(path.join(powerOut, 'sch', 'power', 'power.esch2'));
    const powerDocs = docSegments(powerEsch);
    const powerPage = powerDocs[powerDocs.length - 1];
    const powerSymDoc = powerDocs.find(d => d.head.body.docType === 'SYMBOL'
      && (d.records.find(r => r.type === 'META') || {}).body?.docType === 18);
    const powerPart = powerSymDoc && powerSymDoc.records.find(r => r.type === 'PART');
    assert(!!powerSymDoc && !!powerPart && powerPart.head.id === 'pid8a0e77bacb214e',
      'project-library power symbol embeds a docType-18 SYMBOL doc with the built-in power partId',
      JSON.stringify(powerPart && powerPart.head.id));
    const powerComp = powerPage.records.find(r => r.type === 'COMPONENT' && r.body.partId === 'pid8a0e77bacb214e');
    assert(!!powerComp && powerComp.body.attrs.DeviceName === null
      && powerComp.body.attrs.FootprintName === null,
      'power symbol COMPONENT uses the power-flag attrs (DeviceName/FootprintName null)');
    const gnet = powerPage.records.find(r => r.type === 'ATTR' && r.body.key === 'Global Net Name'
      && powerComp && r.body.parentId === powerComp.head.id);
    assert(!!gnet && gnet.body.value === 'GND',
      'power symbol carries the Global Net Name ATTR',
      gnet && gnet.body.value);
    const powerComps = powerPage.records.filter(r => r.type === 'COMPONENT' && r.body.partId === 'pid8a0e77bacb214e'
      && r.body.zIndex !== null);
    assert(powerComps.length === 1,
      'PWR_FLAG ERC markers are skipped (only the GND power flag remains)',
      `comps=${powerComps.length}`);
    assert(!powerEsch.some(r => r.type === 'ATTR' && r.body && r.body.value === 'PWR_FLAG'),
      'no PWR_FLAG net identifier is emitted (would short every flagged net)');

    // Old project libraries often lost the (power) marker; a '#' reference
    // still marks a power symbol (hidden power pin = global net).
    const hashPowerSch = `(kicad_sch (version 20230121) (generator eeschema)
  (lib_symbols
    (symbol "oldlib:VPP"
      (property "Reference" "#PWR")
      (property "Value" "VPP")
      (property "Footprint" "")
      (symbol "VPP_1_1"
        (pin power_in line (at 0 0 90) (length 0) (name "VPP") (number "1"))))
  )
  (symbol (lib_id "oldlib:VPP") (at 30 30 0) (unit 1)
    (property "Reference" "#PWR05")
    (property "Value" "VPP")
    (property "Footprint" ""))
)`;
    const hashDir = path.join(tmp, 'hash-power');
    fs.mkdirSync(hashDir, { recursive: true });
    fs.writeFileSync(path.join(hashDir, 'hashpower.kicad_sch'), hashPowerSch);
    const hashOut = path.join(tmp, 'hash-power-out');
    run([SCRIPTS + '/convert-kicad.js', 'convert', hashDir, hashOut, '--project-name', 'hashpower']);
    const hashDocs = docSegments(readRecords(path.join(hashOut, 'sch', 'hashpower', 'hashpower.esch2')));
    const hashPage = hashDocs[hashDocs.length - 1];
    const hashPowerComp = hashPage.records.find(r => r.type === 'COMPONENT'
      && r.body.partId === 'pid8a0e77bacb214e' && r.body.zIndex !== null);
    const hashAttrs = hashPowerComp
      ? hashPage.records.filter(r => r.type === 'ATTR' && r.body.parentId === hashPowerComp.head.id) : [];
    assert(!!hashPowerComp && hashAttrs.some(a => a.body.key === 'Global Net Name' && a.body.value === 'VPP'),
      'a # reference without (power) still converts to a power flag (VPP)');

    // ---- pour fineness option ----
    const fineDst = path.join(tmp, 'conv-fine');
    run([SCRIPTS + '/convert-kicad.js', 'convert', tmp, fineDst, '--project-name', 'conv', '--pour-fineness', '1']);
    const fineDocs = docSegments(readRecords(path.join(fineDst, 'pcb', 'PCB1.epcb2')));
    const fineDoc = fineDocs[fineDocs.length - 1];
    const finePour = fineDoc.records.find(r => r.type === 'POUR');
    assert(finePour && finePour.body.pourType.fineness === 1, '--pour-fineness overrides the default (8)');

    // ---- parser (nested unit symbols) ----
    const { parseSymbolFile } = require(path.join(SCRIPTS, 'lib', 'kicad'));
    const syms = parseSymbolFile(path.join(tmp, 'sample.kicad_sym'));
    const myRes = syms.find(s => s.name === 'MY_RES');
    assert(!!myRes, 'kicad parser finds the top-level symbol');
    assert(myRes && myRes.pins.length === 2, 'kicad parser merges pins from nested unit symbols', `pins=${myRes && myRes.pins.length}`);
    // De Morgan body styles: "NAME_<unit>_<style>" - style 2 must not be merged
    // into style 1, otherwise every pin is duplicated (broken connectivity and
    // OVERLAPPIN DRC errors).
    const styleSym = parseSex(`(symbol "MU" (symbol "MU_1_1"
      (pin passive line (at 0 0 0) (length 1) (name "A") (number "1")))
      (symbol "MU_1_2"
      (pin passive line (at 0 0 0) (length 1) (name "A") (number "1")))
      (symbol "MU_2_1"
      (pin passive line (at 0 0 0) (length 1) (name "B") (number "2"))))`);
    const mu1 = nodeSymbol(styleSym, 1);
    const mu2 = nodeSymbol(styleSym, 2);
    assert(mu1.pins.length === 1 && mu1.pins[0].number === '1',
      'unit 1 style 1 pins only (De Morgan style 2 dropped)', `pins=${mu1.pins.length}`);
    assert(mu2.pins.length === 1 && mu2.pins[0].number === '2',
      'other units are selected by unit number', `pins=${mu2.pins.length}`);
    assert(myRes && myRes.shapes.length === 3, 'kicad parser merges shapes from nested unit symbols');
    assert(myRes && myRes.properties.Value === 'MY_RES', 'kicad parser reads properties');

    // ---- unit conversion ----
    assert(Math.abs(kicadToEprj3(1) - 39.3700787) < 1e-6, 'kicadToEprj3 converts mm to mil (39.37)');
    assert(Math.abs(kicadToSchUnit(1) - 3.937007874015748) < 1e-9, 'kicadToSchUnit converts mm to 0.254 mm sch units');
    assert(kicadToSchUnit(0.254) === 1 && Math.abs(kicadToSchUnit(297.18) - 1170) < 1e-6,
      'one sch unit = 0.254 mm exactly (A4 page = 1170 units)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main();
