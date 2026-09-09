'use strict';

// Convert KiCad library symbols / footprints into eprj3 records.
// Payload shapes follow the official example project
// (easyeda-pro-eprj3-format/example/eprj3-example) where available, else the
// official format docs (easyeda-pro-file-format/cn/...).

const { randId } = require('./eprj3');

const MM_TO_MIL = 39.3700787; // eprj3 stores positions in mil (1 mm = 39.37 mil)

function kicadToEprj3(val) {
  // KiCad positions are in mm; eprj3 uses mil.
  return val * MM_TO_MIL;
}

// KiCad sheets/boards/symbols are Y-down; eprj3 canvases are Y-up.
function flipY(val) {
  return -kicadToEprj3(val);
}

// Mirrored rotation sense caused by the Y flip.
function flipRot(deg) {
  const r = ((360 - (parseFloat(deg) || 0)) % 360 + 360) % 360;
  return r;
}

// ---- KiCad stroke/fill → eprj3 numeric enums (cn/schematic/shape.md) ----
// strokeStyle: 0 solid 1 dash 2 dot 3 dash-dot
const STROKE_STYLE_MAP = { solid: 0, default: 0, dash: 1, dot: 2, dash_dot: 3, dash_dot_dot: 3 };
// fillStyle: 0 none 1 solid (outline/background both become solid color fills)
function mapStroke(kicadStroke) {
  const w = kicadStroke && kicadStroke.width != null && isFinite(kicadStroke.width)
    ? Math.max(1, kicadToEprj3(kicadStroke.width)) : null;
  return {
    strokeWidth: w,
    strokeStyle: kicadStroke && kicadStroke.type && kicadStroke.type in STROKE_STYLE_MAP
      ? STROKE_STYLE_MAP[kicadStroke.type] : 0
  };
}
function mapFill(kicadFill) {
  // fillColor "" = no fill (docs); null = default color
  if (kicadFill && kicadFill !== 'none') return { fillColor: null, fillStyle: 1 };
  return { fillColor: '', fillStyle: 0 };
}

// Circumcenter of three points (colinear → midpoint fallback).
function circumcenter(x1, y1, x2, y2, x3, y3) {
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-9) return { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
  const a = x1 * x1 + y1 * y1, b = x2 * x2 + y2 * y2, c = x3 * x3 + y3 * y3;
  return {
    x: (a * (y2 - y3) + b * (y3 - y1) + c * (y1 - y2)) / d,
    y: (a * (x3 - x2) + b * (x1 - x3) + c * (x2 - x1)) / d
  };
}

// Signed sweep (deg, CCW positive in the given coordinate space) of an arc
// start → end passing through mid.
function arcSweep(x1, y1, mx, my, x2, y2) {
  const c = circumcenter(x1, y1, mx, my, x2, y2);
  const a1 = Math.atan2(y1 - c.y, x1 - c.x);
  const am = Math.atan2(my - c.y, mx - c.x);
  const a2 = Math.atan2(y2 - c.y, x2 - c.x);
  const norm = a => { let r = (a - a1) % (2 * Math.PI); if (r < 0) r += 2 * Math.PI; return r; };
  const toMid = norm(am), toEnd = norm(a2);
  let sweep = toEnd;
  if (toMid > toEnd) sweep = toEnd - 2 * Math.PI; // passes through mid the long way
  return { cx: c.x, cy: c.y, sweep: sweep * 180 / Math.PI };
}

// KiCad pin electrical type → eprj3 electric (0 UNKNOWN 1 INPUT 2 OUTPUT 3 BI)
const PIN_ELECTRIC_MAP = {
  input: 1, output: 2, bidirectional: 3, tri_state: 3,
  passive: 0, free: 0, unspecified: 0, power_in: 0, power_out: 0,
  open_collector: 2, open_emitter: 2, no_connect: 0
};
// KiCad pin graphic style → eprj3 pinShape bitfield (1 Clock 2 DOT)
const PIN_SHAPE_MAP = {
  line: 0, inverted: 2, clock: 1, inverted_clock: 3, input_low: 0,
  clock_low: 1, output_low: 0, edge_clock_high: 1, non_logic: 0
};

function collectBboxMm(kicadSym) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const sh of kicadSym.shapes || []) {
    if (sh.type === 'RECT') { add(sh.x1, sh.y1); add(sh.x2, sh.y2); }
    else if (sh.type === 'POLY' || sh.type === 'BEZIER') for (const p of sh.pts || []) add(p.x, p.y);
    else if (sh.type === 'CIRCLE' && sh.r != null) { add(sh.cx - sh.r, sh.cy - sh.r); add(sh.cx + sh.r, sh.cy + sh.r); }
    else if (sh.type === 'ARC') {
      add(sh.x1, sh.y1); add(sh.x2, sh.y2);
      if (sh.mx != null) { add(sh.mx, sh.my); }
    }
  }
  for (const pin of kicadSym.pins || []) {
    add(pin.x, pin.y);
    const len = pin.length || 0;
    const rad = (pin.rotation || 0) * Math.PI / 180;
    add(pin.x + len * Math.cos(rad), pin.y + len * Math.sin(rad));
  }
  if (!isFinite(minX)) return [-50, -25, 50, 25];
  return [minX, minY, maxX, maxY];
}

function buildSymbolRecords(kicadSym, opts = {}) {
  const partId = opts.partId || ('pid' + randId());
  const records = [];
  let ticket = 1;

  const bboxMm = collectBboxMm(kicadSym);
  const BBOX = [flipY(bboxMm[2]), flipY(bboxMm[3]), flipY(bboxMm[0]), flipY(bboxMm[1])];

  records.push({
    head: { type: 'CANVAS', ticket: ++ticket, id: 'CANVAS' },
    body: { originX: 0, originY: 0 }
  });
  records.push({
    head: { type: 'PART', ticket: ++ticket, id: partId },
    body: { BBOX, title: opts.partTitle != null ? opts.partTitle : '' }
  });
  if (opts.libAttrs) {
    // Library-package flavor (elibu): symbols carry Name/Designator part attrs.
    const ref = (kicadSym.properties && kicadSym.properties.Reference) || '?';
    const libAttr = (key, value) => {
      records.push({
        head: { type: 'ATTR', ticket: ++ticket, id: 'e' + randId() },
        body: {
          partId, groupId: '', locked: false, zIndex: ticket, parentId: '',
          key, value,
          keyVisible: false, valueVisible: false,
          x: 0, y: 0, rotation: 0, color: null, fillColor: null, fontFamily: null,
          fontSize: null, strikeout: null, underline: null, italic: null, fontWeight: null, align: null
        }
      });
    };
    libAttr('Name', (kicadSym.properties && kicadSym.properties.Value) || kicadSym.name || '');
    libAttr('Designator', ref.endsWith('?') ? ref : ref + '?');
  } else {
    records.push({
      head: { type: 'ATTR', ticket: ++ticket, id: 'e' + randId() },
      body: {
        partId, groupId: '', locked: false, zIndex: ticket, parentId: '',
        key: 'Symbol', value: kicadSym.name || '',
        keyVisible: false, valueVisible: false,
        x: 0, y: 0, rotation: 0, color: null, fillColor: null, fontFamily: null,
        fontSize: null, strikeout: null, underline: null, italic: null, fontWeight: null, align: null
      }
    });
  }

  for (const sh of kicadSym.shapes) {
    ticket++;
    const stroke = mapStroke(sh.stroke);
    const fill = mapFill(sh.fill);
    const common = {
      partId, groupId: '', locked: false, zIndex: ticket,
      strokeColor: null, strokeStyle: stroke.strokeStyle, fillColor: fill.fillColor,
      strokeWidth: stroke.strokeWidth, fillStyle: fill.fillStyle
    };
    if (sh.type === 'RECT') {
      records.push({
        head: { type: 'RECT', ticket, id: 'e' + randId() },
        body: {
          ...common,
          dotX1: kicadToEprj3(sh.x1), dotY1: flipY(sh.y1),
          dotX2: kicadToEprj3(sh.x2), dotY2: flipY(sh.y2),
          radiusX: 0, radiusY: 0, rotation: 0
        }
      });
    } else if (sh.type === 'POLY' && sh.pts) {
      records.push({
        head: { type: 'POLY', ticket, id: 'e' + randId() },
        body: {
          ...common,
          points: sh.pts.map(p => ({ x: kicadToEprj3(p.x), y: flipY(p.y) })),
          closed: false
        }
      });
    } else if (sh.type === 'CIRCLE' && sh.r != null) {
      records.push({
        head: { type: 'CIRCLE', ticket, id: 'e' + randId() },
        body: { ...common, centerX: kicadToEprj3(sh.cx), centerY: flipY(sh.cy), radius: kicadToEprj3(sh.r) }
      });
    } else if (sh.type === 'ARC' && sh.mx != null) {
      // KiCad arc: start/mid/end (Y-down). eprj3 ARC: start/refer(center)/end.
      const c = circumcenter(sh.x1, sh.y1, sh.mx, sh.my, sh.x2, sh.y2);
      records.push({
        head: { type: 'ARC', ticket, id: 'e' + randId() },
        body: {
          ...common,
          startX: kicadToEprj3(sh.x1), startY: flipY(sh.y1),
          referX: kicadToEprj3(c.x), referY: flipY(c.y),
          endX: kicadToEprj3(sh.x2), endY: flipY(sh.y2)
        }
      });
    } else if (sh.type === 'BEZIER' && sh.pts && sh.pts.length >= 4) {
      records.push({
        head: { type: 'BEZIER', ticket, id: 'e' + randId() },
        body: { ...common, controls: sh.pts.flatMap(p => [kicadToEprj3(p.x), flipY(p.y)]) }
      });
    }
  }

  for (const pin of kicadSym.pins) {
    const pinId = 'e' + randId();
    ticket++;
    records.push({
      head: { type: 'PIN', ticket, id: pinId },
      body: {
        partId, groupId: '', locked: false, zIndex: ticket,
        display: true,
        electric: PIN_ELECTRIC_MAP[pin.electric] != null ? PIN_ELECTRIC_MAP[pin.electric] : 0,
        x: kicadToEprj3(pin.x), y: flipY(pin.y),
        length: kicadToEprj3(pin.length || 5),
        // rotation = direction from the connection end toward the body; the Y
        // flip mirrors the angle sense.
        rotation: flipRot(pin.rotation || 0),
        color: null, pinShape: PIN_SHAPE_MAP[pin.style] != null ? PIN_SHAPE_MAP[pin.style] : 0
      }
    });
    const pinAttr = (key, value) => {
      ticket++;
      records.push({
        head: { type: 'ATTR', ticket, id: 'e' + randId() },
        body: {
          partId, groupId: '', locked: false, zIndex: ticket, parentId: pinId,
          key, value,
          keyVisible: false, valueVisible: false,
          x: pin.x, y: flipY(pin.y), rotation: flipRot(pin.rotation || 0),
          color: null, fillColor: null, fontFamily: null, fontSize: null,
          strikeout: null, underline: null, italic: null, fontWeight: null, align: null
        }
      });
    };
    pinAttr('Pin Name', pin.name || pin.number || '');
    pinAttr('Pin Number', pin.number || '');
    pinAttr('Pin Type', 'Undefined');
  }

  return { records, partId };
}

const PAD_SHAPE_MAP = { circle: 'ELLIPSE', oval: 'OVAL', roundrect: 'ROUNDRECT', rect: 'RECT', custom: 'RECT', trapezoid: 'POLY' };

function footprintPadLayerId(pad) {
  const layers = pad.layers || [];
  const isBack = layers.some(l => /^B\./.test(l));
  const thru = (pad.type || '').includes('thru_hole');
  if (thru) return 12; // MULTI
  return isBack ? 2 : 1;
}

function footprintPadHole(pad) {
  if (!(pad.type || '').includes('thru_hole')) return null;
  const d = parseFloat(pad.drill);
  if (!isFinite(d) || d <= 0) return null;
  // oval drills store their second diameter in drillOval
  const w = pad.drillOval ? Math.max(d, parseFloat(pad.drillOval) || d) : d;
  const h = pad.drillOval ? Math.min(d, parseFloat(pad.drillOval) || d) : d;
  return { holeType: 'ROUND', width: kicadToEprj3(w), height: kicadToEprj3(h), cornerRadius: 0 };
}

function footprintPadRecord(pad, opts = {}) {
  const [x, y] = pad.at && pad.at.length >= 2 ? pad.at : [0, 0];
  const [w, h] = pad.size && pad.size.length >= 2 ? pad.size : [1, 1];
  const shape = PAD_SHAPE_MAP[pad.shape] || 'RECT';
  return {
    head: { type: 'PAD', ticket: opts.ticket, id: opts.id },
    body: {
      groupId: 0, netName: pad.netName || '', layerId: footprintPadLayerId(pad), num: pad.number || '',
      centerX: kicadToEprj3(parseFloat(x)), centerY: flipY(parseFloat(y)),
      padAngle: flipRot(pad.angle), hole: footprintPadHole(pad),
      defaultPad: { padType: shape, width: kicadToEprj3(parseFloat(w)), height: kicadToEprj3(parseFloat(h)), radius: 0 },
      specialPad: [],
      padOffsetX: 0, padOffsetY: 0,
      relativeAngle: 0,
      plated: (pad.type || 'smd') !== 'np_thru_hole',
      padType: 'NORMAL',
      topSolderExpansion: 2, bottomSolderExpansion: 2,
      topPasteExpansion: 0, bottomPasteExpansion: 0,
      locked: false, zIndex: opts.zIndex
    }
  };
}

function buildFootprintRecords(kicadFp, opts = {}) {
  const partId = 'pid' + randId();
  const records = [];
  const padIds = [];
  let ticket = 1;

  // BBOX from pads and silk shapes (mil, Y-up)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const pad of kicadFp.pads) {
    const [px, py] = pad.at && pad.at.length >= 2 ? pad.at : [0, 0];
    const [w, h] = pad.size && pad.size.length >= 2 ? pad.size : [1, 1];
    add(kicadToEprj3(parseFloat(px)) - kicadToEprj3(parseFloat(w)), flipY(parseFloat(py)) - kicadToEprj3(parseFloat(h)));
    add(kicadToEprj3(parseFloat(px)) + kicadToEprj3(parseFloat(w)), flipY(parseFloat(py)) + kicadToEprj3(parseFloat(h)));
  }
  for (const sh of kicadFp.shapes) {
    if (sh.kind === 'fp_circle' && sh.r != null) {
      add(kicadToEprj3(sh.cx) - kicadToEprj3(sh.r), flipY(sh.cy) - kicadToEprj3(sh.r));
      add(kicadToEprj3(sh.cx) + kicadToEprj3(sh.r), flipY(sh.cy) + kicadToEprj3(sh.r));
    } else if (sh.kind === 'fp_arc' && sh.mx != null) {
      add(kicadToEprj3(sh.x1), flipY(sh.y1)); add(kicadToEprj3(sh.x2), flipY(sh.y2)); add(kicadToEprj3(sh.mx), flipY(sh.my));
    } else if (sh.pts) {
      for (const p of sh.pts) add(kicadToEprj3(p.x), flipY(p.y));
    } else {
      add(kicadToEprj3(sh.x1), flipY(sh.y1));
      add(kicadToEprj3(sh.x2), flipY(sh.y2));
    }
  }
  if (!isFinite(minX)) { minX = -100; minY = -100; maxX = 100; maxY = 100; }

  records.push({
    head: { type: 'CANVAS', ticket: ++ticket, id: 'CANVAS' },
    body: opts.canvasBody || { originX: 0, originY: 0 }
  });
  if (opts.includePart !== false) {
    records.push({
      head: { type: 'PART', ticket: ++ticket, id: partId },
      body: { BBOX: [minX, minY, maxX, maxY], title: '' }
    });
  }

  for (const sh of kicadFp.shapes) {
    ticket++;
    const lname = sh.layer || 'F.SilkS';
    // Fab/Courtyard/annotation graphics land on the Document layer (13)
    const layerId = /SilkS$/.test(lname) ? (/^B\./.test(lname) ? 4 : 3) : 13;
    const width = Math.max(1, Math.round(kicadToEprj3(parseFloat(sh.width) || 0.15)));
    if (sh.kind === 'fp_line') {
      records.push({
        head: { type: 'POLY', ticket, id: 'e' + randId() },
        body: {
          groupId: 0, netName: '', layerId, width,
          path: [kicadToEprj3(sh.x1), flipY(sh.y1), 'L', kicadToEprj3(sh.x2), flipY(sh.y2)],
          locked: false, zIndex: ticket, polyType: 'NORMAL'
        }
      });
    } else if (sh.kind === 'fp_rect') {
      const x1 = kicadToEprj3(sh.x1), y1 = flipY(sh.y1), x2 = kicadToEprj3(sh.x2), y2 = flipY(sh.y2);
      records.push({
        head: { type: 'POLY', ticket, id: 'e' + randId() },
        body: {
          groupId: 0, netName: '', layerId, width,
          path: [x1, y1, 'L', x2, y1, x2, y2, x1, y2, x1, y1],
          locked: false, zIndex: ticket, polyType: 'NORMAL'
        }
      });
    } else if (sh.kind === 'fp_poly' && sh.pts && sh.pts.length > 2) {
      const flat = [];
      for (const p of sh.pts) flat.push(kicadToEprj3(p.x), flipY(p.y));
      records.push({
        head: { type: 'POLY', ticket, id: 'e' + randId() },
        body: {
          groupId: 0, netName: '', layerId, width,
          path: [...flat, flat[0], flat[1]],
          locked: false, zIndex: ticket, polyType: 'NORMAL'
        }
      });
    } else if (sh.kind === 'fp_circle' && sh.r != null) {
      records.push({
        head: { type: 'POLY', ticket, id: 'e' + randId() },
        body: {
          groupId: 0, netName: '', layerId, width,
          path: [['CIRCLE', kicadToEprj3(sh.cx), flipY(sh.cy), kicadToEprj3(sh.r), 1]],
          locked: false, zIndex: ticket, polyType: 'NORMAL'
        }
      });
    } else if (sh.kind === 'fp_arc' && sh.mx != null) {
      // PCB ARC record: start/end + CCW-positive angle in eprj3 (Y-up) space.
      const x1 = kicadToEprj3(sh.x1), y1 = flipY(sh.y1);
      const mx = kicadToEprj3(sh.mx), my = flipY(sh.my);
      const x2 = kicadToEprj3(sh.x2), y2 = flipY(sh.y2);
      const { sweep } = arcSweep(x1, y1, mx, my, x2, y2);
      records.push({
        head: { type: 'ARC', ticket, id: 'e' + randId() },
        body: {
          groupId: 0, netName: '', layerId,
          startX: x1, startY: y1, endX: x2, endY: y2,
          angle: Math.round(sweep * 100) / 100, width,
          locked: false, zIndex: ticket
        }
      });
    }
  }

  for (const pad of kicadFp.pads) {
    ticket++;
    const padId = 'e' + randId();
    padIds.push({ num: pad.number || '', id: padId });
    records.push(footprintPadRecord(pad, { ticket, id: padId }));
  }

  // Library-style ATTRs (official footprint docs carry Footprint/Designator placeholders)
  const fpAttr = (key, value) => {
    ticket++;
    records.push({
      head: { type: 'ATTR', ticket, id: 'e' + randId() },
      body: {
        groupId: 0, parentId: '', layerId: 3, x: null, y: null,
        key, value, keyVisible: false, valueVisible: false,
        fontFamily: 'default', fontSize: 67.5, strokeWidth: 6,
        bold: false, italic: false, origin: 'LEFT_BOTTOM',
        angle: 0, reverse: false, expansion: 0, mirror: false,
        locked: false, zIndex: ticket
      }
    });
  };
  fpAttr('Footprint', kicadFp.name || '');
  fpAttr('Designator', 'U?');
  if (kicadFp.value) fpAttr('Value', kicadFp.value);

  return { records, partId, pads: padIds };
}

module.exports = {
  buildSymbolRecords, buildFootprintRecords, footprintPadRecord,
  kicadToEprj3, flipY, flipRot, circumcenter, arcSweep,
  mapStroke, mapFill, PIN_ELECTRIC_MAP, PIN_SHAPE_MAP
};