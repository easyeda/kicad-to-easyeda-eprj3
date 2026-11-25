'use strict';
// KiCad PCB → EasyEDA PCB conversion: tracks/vias/footprints, zones/pours,
// outline/dimensions/graphics, layer table and board stack configuration.
// The CLI flow lives in scripts/convert-kicad.js.
const fs = require('fs');
const path = require('path');
const {
  parse: parseSex, extractPts, extractPads, extractArc,
  findSub, findSubNode, findFlags, collectProperties,
  findAtXY, findValue, strokeWidthOf
} = require('./kicad');
const {
  buildFootprintRecords, flipY, arcSweep
} = require('./kicad-to-eprj3');
const { uuid, randId, writeRecords } = require('./eprj3');
const { findViolation } = require('./hostpath');
const { toMil, r2, docHead, metaRec, nextGge, warn } = require('./convert-util');
const PCB_CONFIG = require('./pcb-config.json');

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

// Board setup that lives in the sibling .kicad_pro (not in the .kicad_pcb):
// default net class constraints and the minimum fabrication limits. Missing
// file/fields simply leave the corresponding EDA rule at its template value.
function readProjectDesign(pcbFile) {
  const file = pcbFile.replace(/\.kicad_pcb$/i, '.kicad_pro');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cls = (j.net_settings && j.net_settings.classes && j.net_settings.classes.Default) || {};
    const rules = (j.board && j.board.design_settings && j.board.design_settings.rules) || {};
    return {
      netclass: cls,
      minTrackWidth: rules.min_track_width,
      minViaDiameter: rules.min_via_diameter,
      minHoleDiameter: rules.min_through_hole_diameter
    };
  } catch (e) {
    return { netclass: {} };
  }
}

const MIL_PER_MM = 39.37007874015748;

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

  // Inner copper layers are disabled (`use:false`) in the static layer table;
  // a multi-layer KiCad board must enable every inner layer it declares, or
  // the client drops their tracks/pours and the pads look unrouted (ratlines).
  const usedInner = new Set();
  const copperLayerNames = [];
  const layersNode = root.slice(1).find(n => Array.isArray(n) && n[0].v === 'layers');
  for (const it of layersNode ? layersNode.slice(1) : []) {
    if (!Array.isArray(it) || !it[1]) continue;
    const name = it[1].v || '';
    if (!/\.Cu$/.test(name)) continue;
    copperLayerNames.push(name);
    const m = /^In(\d+)\.Cu$/.exec(name);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 32) usedInner.add(14 + n);
  }

  // DOCHEAD + META + the static editor config block the client requires.
  // The KiCad net class / fabrication limits (sibling .kicad_pro) override the
  // track and via defaults where available; the rest of the JLCPCB template
  // (clearance matrices, mask expansions, …) is kept.
  const innerIds = [...usedInner].sort((a, b) => a - b);
  const copperIds = [1, 2, ...innerIds];
  const design = readProjectDesign(srcFile);
  const generalNode = root.slice(1).find(n => Array.isArray(n) && n[0].v === 'general');
  const thickArr = generalNode ? findSub(generalNode, 'thickness') : null;
  const boardThicknessMm = thickArr && Number.isFinite(parseFloat(thickArr[0])) ? parseFloat(thickArr[0]) : null;
  const nc = design.netclass || {};
  const mil4 = v => Math.round(v * MIL_PER_MM * 10000) / 10000;
  const trackDefault = Number.isFinite(nc.track_width) ? mil4(nc.track_width) : null;
  const trackMin = Number.isFinite(design.minTrackWidth) ? mil4(design.minTrackWidth) : null;
  const viaDia = Number.isFinite(nc.via_diameter) ? mil4(nc.via_diameter) : null;
  const viaDrill = Number.isFinite(nc.via_drill) ? mil4(nc.via_drill) : null;
  const minViaDia = Number.isFinite(design.minViaDiameter) ? mil4(design.minViaDiameter) : null;
  const minHole = Number.isFinite(design.minHoleDiameter) ? mil4(design.minHoleDiameter) : null;

  const configRecords = PCB_CONFIG.map((r, i) => {
    const rec = { head: { type: r.type, ticket: 2 + i, id: r.id }, body: r.body };
    if (r.type === 'LAYER' && r.body.layerType === 'SIGNAL') {
      const use = usedInner.has(r.body.layerId);
      rec.body = { ...r.body, use, show: use };
    }
    // Track width/minimum: the template only lists the top layer, so rebuild
    // the per-layer content for every copper layer with the net class default
    // and/or the fabrication minimum.
    if (r.type === 'RULE' && r.id === '["RULE","TRACK","copperThickness1oz"]'
      && r.body.ruleState === 'DEFAULT' && (trackDefault != null || trackMin != null)) {
      const ctx = JSON.parse(JSON.stringify(r.body.ruleContext || {}));
      const old = (ctx.track && ctx.track.content && ctx.track.content[0]) || {};
      ctx.track = {
        isOpen: true,
        content: copperIds.map(layerId => ({
          layerId,
          stroMin: trackMin != null ? trackMin : old.stroMin,
          stroDef: trackDefault != null ? trackDefault : old.stroDef,
          stroMax: old.stroMax != null ? old.stroMax : 100
        }))
      };
      rec.body = { ...r.body, ruleContext: ctx };
    }
    // Via defaults: EDA stores radii in mil; KiCad gives diameters in mm.
    if (r.type === 'RULE' && r.id === '["RULE","RADIUS","viaSize"]'
      && r.body.ruleState === 'DEFAULT'
      && (viaDia != null || viaDrill != null || minViaDia != null || minHole != null)) {
      const ctx = { ...(r.body.ruleContext || {}) };
      if (viaDia != null) ctx.defRadius = Math.round((viaDia / 2) * 10000) / 10000;
      if (viaDrill != null) ctx.defInner = Math.round((viaDrill / 2) * 10000) / 10000;
      if (minViaDia != null) ctx.minRadius = Math.round((minViaDia / 2) * 10000) / 10000;
      if (minHole != null) ctx.minInner = Math.round((minHole / 2) * 10000) / 10000;
      rec.body = { ...r.body, ruleContext: ctx };
    }
    return rec;
  });

  // Inner copper layers need a physical stack entry: enabling the LAYER alone
  // leaves the layer out of the stackup/impedance/gerber layer list.
  const innerPhys = innerIds.map((layerId, i, arr) => ({
    head: {
      type: 'LAYER_PHYS',
      ticket: 2 + PCB_CONFIG.length + i,
      id: JSON.stringify(['LAYER_PHYS', layerId])
    },
    body: {
      material: null,
      thickness: 1.379,
      permittivity: null,
      lossTangent: null,
      isKeepIsland: true,
      zIndex: Math.round(1000 + ((9000 - 1000) * (i + 1)) / (arr.length + 1))
    }
  }));

  // Match the KiCad board thickness: the static stack sums to 1.6 mm, so put
  // the delta (and the inner-copper thickness added above) into the core.
  if (boardThicknessMm != null) {
    const phys = [...configRecords, ...innerPhys].filter(r => r.head.type === 'LAYER_PHYS');
    const totalMil = phys.reduce((sum, r) => sum + (Number.isFinite(r.body.thickness) ? r.body.thickness : 0), 0);
    const core = phys.find(r => r.head.id === '["LAYER_PHYS",361]');
    if (core) {
      const delta = boardThicknessMm * MIL_PER_MM - totalMil;
      core.body = { ...core.body, thickness: Math.round((core.body.thickness + delta) * 1000) / 1000 };
    }
  }

  const docRecords = [
    docHead('PCB', pcb.uuid),
    { head: { type: 'META', ticket: 1, id: 'META' }, body: { title: pcb.title, parent: '', source: '', board: pcb.board, zIndex: null } },
    ...configRecords,
    ...innerPhys
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
      convertZone(node, { netNames, usedNets, push, pourFineness, copperLayerNames });
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

function netOf(node, netNames) {
  const netArr = findSub(node, 'net');
  return netArr ? (netNames[netArr[0]] || '') : '';
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
function convertZone(node, { netNames, usedNets, push, pourFineness, copperLayerNames = [] }) {
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

  // KiCad zones can span several copper layers: (layers "In1.Cu" "In2.Cu"),
  // the outer-layer shorthand "F&B.Cu", or all copper "*.Cu". Expand them so
  // each layer gets its own POUR + POURED (a single POUR cannot cover two
  // layers, and the filled_polygon layer filter needs the real layer names).
  const rawLayers = [];
  const layerArr = findSub(node, 'layer');
  const layersArr = findSub(node, 'layerS') || findSub(node, 'layers');
  if (layerArr) rawLayers.push(layerArr[0]);
  if (layersArr) for (const l of layersArr) rawLayers.push(l);
  if (!rawLayers.length) rawLayers.push('F.Cu');
  const layers = [];
  for (const name of rawLayers) {
    if (name === 'F&B.Cu') layers.push('F.Cu', 'B.Cu');
    else if (name === '*.Cu') layers.push(...(copperLayerNames.length ? copperLayerNames : ['F.Cu', 'B.Cu']));
    else layers.push(name);
  }
  const uniqueLayers = [...new Set(layers)];

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
    for (const lname of uniqueLayers) {
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

  for (const lname of uniqueLayers) {
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
      'Unique ID': texts.Reference || 'gge' + nextGge(),
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
      const a = require('./kicad').extractArc(it);
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

module.exports = { convertPcb };
