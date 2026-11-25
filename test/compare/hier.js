'use strict';
// Hierarchy model for comparing EasyEDA's CBB-instantiated netlist with the
// KiCad reference:
//  - one EasyEDA schematic per unique sheet file; a file placed N times is one
//    CBB schematic whose instances expand as `<ref>$CBB<n>`
//  - the child page stores the FIRST instance's designators, so KiCad's
//    per-instance refs must be translated (R2 -> R1$CBB2, ...)
//  - EDA's page netlist (Protel2) on a non-CBB root page already contains the
//    expanded instances and their global connectivity.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const {
  parse, findSub, findChildValue, collectProperties
} = require(path.join(ROOT, 'scripts', 'lib', 'kicad.js'));

function parseSheetFile(abs) {
  const out = { uuid: '', sheets: [], symbols: [], legacy: {} };
  let root;
  try { root = parse(fs.readFileSync(abs, 'utf8')); } catch (e) { return out; }
  out.uuid = findChildValue(root, 'uuid') || '';
  for (const n of root.slice(1)) {
    if (!Array.isArray(n) || !n[0]) continue;
    const kind = n[0].v;
    if (kind === 'sheet') {
      const props = collectProperties(n);
      out.sheets.push({
        uuid: findChildValue(n, 'uuid') || '',
        name: props.Sheetname || '',
        file: props.Sheetfile || ''
      });
    } else if (kind === 'symbol') {
      const props = collectProperties(n);
      const refs = {};
      for (const it of n.slice(1)) {
        if (!Array.isArray(it) || it[0].v !== 'instances') continue;
        for (const proj of it.slice(1)) {
          if (!Array.isArray(proj) || proj[0].v !== 'project') continue;
          for (const p of proj.slice(2)) {
            if (!Array.isArray(p) || p[0].v !== 'path') continue;
            const pp = p[1]?.v || '';
            let ref = '';
            for (const x of p.slice(2)) {
              if (Array.isArray(x) && x[0].v === 'reference') ref = x[1]?.v || '';
            }
            if (pp && ref) refs[pp] = ref;
          }
        }
      }
      out.symbols.push({
        uuid: findChildValue(n, 'uuid') || '',
        propRef: props.Reference || '',
        refs
      });
    } else if (kind === 'symbol_instances') {
      for (const p of n.slice(1)) {
        if (!Array.isArray(p) || p[0].v !== 'path') continue;
        const pp = p[1]?.v || '';
        let ref = '';
        for (const x of p.slice(2)) {
          if (Array.isArray(x) && x[0].v === 'reference') ref = x[1]?.v || '';
        }
        if (pp && ref) out.legacy[pp] = ref;
      }
    }
  }
  return out;
}

// Build the KiCad-ref -> EasyEDA-ref translation table.
function buildInstanceModel(stageDir, projectName) {
  const files = fs.existsSync(stageDir)
    ? fs.readdirSync(stageDir).filter(f => f.endsWith('.kicad_sch')).map(f => path.resolve(stageDir, f))
    : [];
  const metas = new Map(files.map(f => [f, parseSheetFile(f)]));
  const referenced = new Set();
  for (const [f, m] of metas) {
    for (const s of m.sheets) {
      const t = s.file ? path.resolve(path.dirname(f), s.file) : null;
      if (t && metas.has(t)) referenced.add(t);
    }
  }
  let roots = files.filter(f => !referenced.has(f));
  const preferred = files.find(f => path.basename(f, '.kicad_sch') === projectName);
  if (preferred && roots.includes(preferred)) roots = [preferred, ...roots.filter(r => r !== preferred)];
  if (!roots.length) roots = files.slice();

  // Page discovery order + per-sheet CBB numbering (mirrors the converter).
  const pageSeen = new Set();
  const firstPath = new Map();
  const firstLegacy = new Map();
  const pageCbb = new Map(); // file -> {nodeIndex: cbbNo}
  const queue = roots.map(f => ({ file: f, uuidPath: '/' + (metas.get(f).uuid || ''), legacyPath: '/' }));
  let cbbNo = 0;
  const pageOrder = [];
  while (queue.length) {
    const item = queue.shift();
    if (pageSeen.has(item.file)) continue;
    pageSeen.add(item.file);
    firstPath.set(item.file, item.uuidPath);
    firstLegacy.set(item.file, item.legacyPath || '/');
    pageOrder.push(item.file);
    const m = metas.get(item.file);
    const nums = {};
    m.sheets.forEach((s, idx) => {
      const t = s.file ? path.resolve(path.dirname(item.file), s.file) : null;
      if (!t || !metas.has(t)) return;
      nums[idx] = ++cbbNo;
      queue.push({
        file: t,
        uuidPath: item.uuidPath + '/' + (s.uuid || ''),
        legacyPath: (item.legacyPath || '/') + (s.uuid || '') + '/'
      });
    });
    pageCbb.set(item.file, nums);
  }
  // Standalone files not reachable through any root.
  for (const f of files) {
    if (pageSeen.has(f)) continue;
    pageSeen.add(f);
    firstPath.set(f, '/' + (metas.get(f).uuid || ''));
    firstLegacy.set(f, '/');
    pageOrder.push(f);
    pageCbb.set(f, {});
  }

  // Enumerate every sheet-instance occurrence (chain = CBB numbers on the way).
  const instances = [];
  const visit = (file, uuidPath, legacyPath, chain, depth) => {
    if (depth > 32) return;
    instances.push({ file, uuidPath, legacyPath, chain });
    const m = metas.get(file);
    if (!m) return;
    const nums = pageCbb.get(file) || {};
    m.sheets.forEach((s, idx) => {
      if (nums[idx] == null) return;
      const t = path.resolve(path.dirname(file), s.file);
      if (!metas.has(t)) return;
      visit(t, uuidPath + '/' + (s.uuid || ''), legacyPath + (s.uuid || '') + '/',
        [...chain, { no: nums[idx], file: t }], depth + 1);
    });
  };
  for (const f of roots) {
    visit(f, '/' + (metas.get(f).uuid || ''), '/', [], 0);
  }
  for (const f of files) {
    if (!pageSeen.has(f)) continue;
    if (instances.some(i => i.file === f)) continue;
    visit(f, '/' + (metas.get(f).uuid || ''), '/', [], 0);
  }

  // EasyEDA only adds the $CBB<n> suffix for modules placed more than once
  // (a single instance is inlined under its plain designator).
  const placeCount = new Map();
  for (const inst of instances) placeCount.set(inst.file, (placeCount.get(inst.file) || 0) + 1);

  // KiCad ref (per instance) -> EasyEDA ref (base + needed $CBB suffixes).
  const mapRef = {};
  for (const inst of instances) {
    const m = metas.get(inst.file);
    if (!m) continue;
    const basePath = firstPath.get(inst.file) || inst.uuidPath;
    const suffix = inst.chain
      .filter(x => (placeCount.get(x.file) || 0) > 1)
      .map(x => '$CBB' + x.no).join('');
    for (const sym of m.symbols) {
      const legacyBase = m.legacy[(firstLegacy.get(inst.file) || '/') + sym.uuid];
      const baseRef = sym.refs[basePath] || legacyBase || sym.refs[inst.uuidPath] || sym.propRef;
      const kicadRef = sym.refs[inst.uuidPath] || m.legacy[inst.legacyPath + sym.uuid] || baseRef;
      if (!baseRef || !kicadRef) continue;
      mapRef[kicadRef] = baseRef + suffix;
    }
  }
  return { mapRef, files, firstPath, pageOrder };
}

// Protel-2 netlist parse (components + net grouping).
function parseProtel(text) {
  const lines = String(text || '').split(/\r?\n/);
  const comps = new Map();
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === '[') {
      const fields = {};
      let j = i + 1;
      let key = '';
      for (; j < lines.length && lines[j] !== ']'; j++) {
        if (key) { fields[key] = lines[j]; key = ''; continue; }
        key = lines[j];
      }
      const desig = fields.DESIGNATOR || fields.Designator || '';
      if (desig) {
        comps.set(desig, {
          value: fields.Name || fields.VALUE || '',
          footprint: fields.FOOTPRINT || ''
        });
      }
      i = j;
    }
    i++;
  }
  // Net groups: `<ref>-<pin> <part>-<pin> <type>`. Designators may contain '-'
  // (e.g. TA-101), so split at the longest prefix that is a known designator.
  const pins = {};
  i = 0;
  while (i < lines.length) {
    if (lines[i] === '(') {
      const name = lines[i + 1] || '';
      let j = i + 2;
      for (; j < lines.length && lines[j] !== ')'; j++) {
        const line = lines[j];
        const sp = line.indexOf(' ');
        const head = sp < 0 ? line : line.slice(0, sp);
        let split = -1;
        for (let k = head.length - 1; k > 0; k--) {
          if (head[k] === '-' && comps.has(head.slice(0, k))) { split = k; break; }
        }
        if (split > 0) pins[head.slice(0, split) + ':' + head.slice(split + 1)] = name;
      }
      i = j;
    }
    i++;
  }
  return { comps, pins };
}

// ---- PCB structural metadata (KiCad reference vs converted .epcb2) ----
const MIL_PER_MM = 39.37007874015748;

function parseKicadPcb(file) {
  const meta = {
    copperLayers: [], tracks: 0, vias: 0, pads: 0, footprints: 0,
    zones: 0, keepouts: 0, nets: 0, netNames: [], stackupCopper: 0,
    stackupDielectric: 0, stackupThickness: 0, boardThickness: 0
  };
  let root;
  try { root = parse(fs.readFileSync(file, 'utf8')); } catch (e) { return meta; }
  const netTable = {};
  for (const n of root.slice(1)) {
    if (!Array.isArray(n) || n[0].v !== 'net' || !n[1]) continue;
    const name = (n[2] && n[2].v || '').replace(/\{slash\}/g, '/');
    if (name) netTable[n[1].v] = name;
  }
  const usedNets = new Set();
  const addNet = name => {
    if (name && !/^unconnected-\(/.test(name)) usedNets.add(name);
  };
  const netNameOf = node => {
    const a = findSub(node, 'net');
    if (!a) return '';
    return (a[1] || netTable[a[0]] || '').replace(/\{slash\}/g, '/');
  };
  for (const n of root.slice(1)) {
    if (!Array.isArray(n) || !n[0]) continue;
    const h = n[0].v;
    if (h === 'layers') {
      for (const it of n.slice(1)) {
        if (!Array.isArray(it)) continue;
        const name = it[1] && it[1].v || '';
        if (/\.Cu$/.test(name)) meta.copperLayers.push(name);
      }
    } else if (h === 'segment') {
      meta.tracks++;
      const nn = netNameOf(n); addNet(nn);
    } else if (h === 'arc') {
      const layer = findSub(n, 'layer');
      if (layer && /\.Cu$/.test(layer[0]) && findSub(n, 'net')) {
        meta.tracks++;
        const nn = netNameOf(n); addNet(nn);
      }
    } else if (h === 'via') {
      meta.vias++;
      const nn = netNameOf(n); addNet(nn);
    } else if (h === 'zone') {
      const keep = n.slice(1).some(x => Array.isArray(x) && x[0].v === 'keepout');
      const rawLayers = [];
      const la = findSub(n, 'layer');
      const las = findSub(n, 'layers');
      if (la) rawLayers.push(la[0]);
      if (las) for (const l of las) rawLayers.push(l);
      if (!rawLayers.length) rawLayers.push('F.Cu');
      let count = 0;
      for (const name of rawLayers) {
        if (name === 'F&B.Cu') count += 2;
        else if (name === '*.Cu') count += meta.copperLayers.length || 2;
        else count += 1;
      }
      if (keep) meta.keepouts += count; else meta.zones += count;
      const nn = netNameOf(n); addNet(nn);
    } else if (h === 'net') {
      // counted through usedNets below
    } else if (h === 'footprint' || h === 'module') {
      meta.footprints++;
      for (const it of n.slice(1)) {
        if (!Array.isArray(it) || it[0].v !== 'pad') continue;
        meta.pads++;
        const nn = netNameOf(it); addNet(nn);
      }
    } else if (h === 'general') {
      const th = findSub(n, 'thickness');
      if (th && Number.isFinite(parseFloat(th[0]))) meta.boardThickness = parseFloat(th[0]);
    } else if (h === 'setup') {
      const stack = n.slice(1).find(x => Array.isArray(x) && x[0].v === 'stackup');
      if (!stack) continue;
      for (const l of stack.slice(1)) {
        if (!Array.isArray(l) || l[0].v !== 'layer') continue;
        const type = findSub(l, 'type');
        const th = findSub(l, 'thickness');
        if (th && Number.isFinite(parseFloat(th[0]))) meta.stackupThickness += parseFloat(th[0]);
        if (!type) continue;
        const t = String(type[0]);
        if (/copper/i.test(t)) meta.stackupCopper++;
        else if (/core|prepreg|dielectric/i.test(t)) meta.stackupDielectric++;
      }
    }
  }
  meta.netNames = [...usedNets].sort();
  meta.nets = meta.netNames.length;
  return meta;
}

function readEdaDocs(file) {
  const docs = [];
  let cur = null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return docs; }
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('||');
    if (i < 0) continue;
    let head, body;
    try {
      head = JSON.parse(line.slice(0, i));
      body = JSON.parse(line.slice(i + 2).replace(/\|\s*$/, ''));
    } catch (e) { continue; }
    if (head.type === 'DOCHEAD') { cur = { head: body, recs: [] }; docs.push(cur); continue; }
    if (!cur) continue;
    cur.recs.push({ type: head.type, head, body });
  }
  return docs;
}

function parseEdaPcb(file) {
  const meta = {
    copperLayers: [], tracks: 0, vias: 0, pads: 0, components: 0,
    pours: 0, regions: 0, nets: 0, netNames: [], stackupCopper: 0, rules: {}
  };
  const docs = readEdaDocs(file);
  const pcb = docs.filter(d => d.head && d.head.docType === 'PCB').pop() || docs[docs.length - 1];
  if (!pcb) return meta;
  for (const r of pcb.recs) {
    const b = r.body || {};
    if (r.type === 'LAYER' && b.use && ['TOP', 'BOTTOM', 'SIGNAL'].includes(b.layerType)) {
      meta.copperLayers.push(b.layerId);
    }
  }
  const copper = new Set(meta.copperLayers);
  for (const r of pcb.recs) {
    const b = r.body || {};
    if (r.type === 'LINE' || r.type === 'ARC') {
      if (copper.has(b.layerId)) meta.tracks++;
    } else if (r.type === 'VIA') {
      meta.vias++;
    } else if (r.type === 'COMPONENT') {
      meta.components++;
    } else if (r.type === 'POUR') {
      meta.pours++;
    } else if (r.type === 'REGION') {
      if (b.regionType === 'PROHIBIT') meta.regions++;
    } else if (r.type === 'NET') {
      let id = null;
      try { id = JSON.parse(r.head.id); } catch (e) { /* malformed id */ }
      if (Array.isArray(id) && id[1]) meta.netNames.push(id[1]);
    } else if (r.type === 'LAYER_PHYS') {
      let id = null;
      try { id = JSON.parse(r.head.id)[1]; } catch (e) { /* malformed id */ }
      if (copper.has(id)) meta.stackupCopper++;
    } else if (r.type === 'RULE') {
      if (r.head.id === '["RULE","TRACK","copperThickness1oz"]' && b.ruleState === 'DEFAULT') {
        const c = (b.ruleContext && b.ruleContext.track && b.ruleContext.track.content || [])[0];
        if (c && Number.isFinite(c.stroDef)) meta.rules.trackWidth = +(c.stroDef / MIL_PER_MM).toFixed(4);
        if (c && Number.isFinite(c.stroMin)) meta.rules.trackMinWidth = +(c.stroMin / MIL_PER_MM).toFixed(4);
      }
      if (r.head.id === '["RULE","RADIUS","viaSize"]' && b.ruleState === 'DEFAULT') {
        const c = b.ruleContext || {};
        if (Number.isFinite(c.defRadius)) meta.rules.viaDiameter = +(c.defRadius * 2 / MIL_PER_MM).toFixed(4);
        if (Number.isFinite(c.defInner)) meta.rules.viaDrill = +(c.defInner * 2 / MIL_PER_MM).toFixed(4);
        if (Number.isFinite(c.minRadius)) meta.rules.viaMinDiameter = +(c.minRadius * 2 / MIL_PER_MM).toFixed(4);
        if (Number.isFinite(c.minInner)) meta.rules.viaMinDrill = +(c.minInner * 2 / MIL_PER_MM).toFixed(4);
      }
    }
  }
  // Footprint documents are shared by components, so count pads per placed
  // component (resolve its Footprint ATTR) instead of once per library doc.
  const padCounts = new Map();
  for (const d of docs) {
    if (!d.head || d.head.docType !== 'FOOTPRINT') continue;
    padCounts.set(d.head.uuid, d.recs.filter(x => x.type === 'PAD').length);
  }
  const fpByComp = new Map();
  for (const r of pcb.recs) {
    if (r.type === 'ATTR' && r.body && r.body.key === 'Footprint') fpByComp.set(r.body.parentId, r.body.value);
  }
  for (const r of pcb.recs) {
    if (r.type !== 'COMPONENT') continue;
    const uuid = fpByComp.get(r.head.id);
    if (uuid != null && padCounts.has(uuid)) meta.pads += padCounts.get(uuid);
  }
  meta.netNames = [...new Set(meta.netNames)].sort();
  meta.nets = meta.netNames.length;
  return meta;
}

// Default net class + fabrication minimums from the KiCad project file.
function readKicadRules(stageDir, name) {
  const file = path.join(stageDir, name + '.kicad_pro');
  const round = v => Number.isFinite(v) ? +v.toFixed(4) : undefined;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = j.net_settings && j.net_settings.classes && j.net_settings.classes.Default;
    const r = (j.board && j.board.design_settings && j.board.design_settings.rules) || {};
    return {
      netclass: c ? {
        clearance: round(c.clearance),
        track_width: round(c.track_width),
        via_diameter: round(c.via_diameter),
        via_drill: round(c.via_drill)
      } : null,
      minimums: {
        min_track_width: round(r.min_track_width),
        min_via_diameter: round(r.min_via_diameter),
        min_through_hole_diameter: round(r.min_through_hole_diameter),
        min_clearance: round(r.min_clearance)
      }
    };
  } catch (e) {
    return { netclass: null, minimums: {} };
  }
}

module.exports = {
  buildInstanceModel, parseProtel,
  parseKicadPcb, parseEdaPcb, readEdaDocs, readKicadRules
};
