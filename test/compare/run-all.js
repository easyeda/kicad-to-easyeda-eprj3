'use strict';
// Compare every converted demo with KiCad's own exports (kicad-cli 10):
//   - connectivity partitions: KiCad XML netlist vs EDA sch_Netlist
//   - BOM: kicad-cli BOM CSV vs EDA netlist components
//   - PCB coordinates/rotation: kicad-cli position CSV vs EDA PCB components
// Net names may legitimately differ; only the pin partitions are compared.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = 'C:/Program Files/lceda-pro/lceda-pro.exe';
const KCLI = 'C:/Users/easyeda/AppData/Local/Programs/KiCad/10.0/bin/kicad-cli.exe';
const DST = 'D:/Documents/KiCAD/demos/eprj3';
const OUT = path.join(ROOT, 'tmp', 'compare', 'out');
const REF = path.join(ROOT, 'tmp', 'compare', 'ref');
const STAGE = path.join(ROOT, 'tmp', 'demo-stage');
const PROBE = fs.readFileSync(path.join(__dirname, 'probe-project.js'), 'utf8');
const { buildInstanceModel, parseProtel, parseKicadPcb, parseEdaPcb, readKicadRules } = require('./hier.js');
const K = 39.37007874015748;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 128 * 1024 * 1024 });
  return (r.stdout || '') + (r.stderr || '');
}
function openProject(file) {
  const out = run(CLI, ['open', '--path', file, '--headless', 'true']);
  const m = /"sessionId":"([^"]+)"/.exec(out);
  return m ? m[1] : null;
}
function invoke(sid, code, args = {}) {
  const out = run(CLI, ['invoke', '--session', sid, '--ext-uuid', 'eda', '--code', code,
    '--args', JSON.stringify(args), '--timeout', '180000']);
  const line = out.trim().split(/\r?\n/).find(l => l.startsWith('{'));
  if (line) {
    try { return JSON.parse(line); } catch (e) { /* fall through */ }
  }
  // The CLI wraps very large payloads in a JSON string literal (the whole
  // envelope arrives quoted and escaped), so unwrap before parsing.
  try {
    let v = JSON.parse(out.trim());
    if (typeof v === 'string') v = JSON.parse(v.trim());
    if (v && typeof v === 'object') return v;
  } catch (e) { /* not double-encoded */ }
  return { ok: false, error: { message: out.slice(0, 300) } };
}
function close(sid) {
  const out = run(CLI, ['session', 'close', '--session', sid, '--destroy']);
  if (!/"ok":true/.test(out)) run(CLI, ['session', 'abort', '--session', sid]);
}

// Leaked headless sessions make later probes flaky (duplicate windows on the
// same project, empty netlists, eventually a stuck editor index). Clear every
// CLI-opened session before a run; abort whatever close leaves behind.
function closeStraySessions() {
  for (let round = 0; round < 3; round++) {
    let list = [];
    try { list = JSON.parse(run(CLI, ['session', 'list'])).value || []; } catch (e) { return; }
    const alive = list.filter(s => s.status === 'alive' && s.origin === 'cli');
    if (!alive.length) return;
    for (const s of alive) {
      const closed = run(CLI, ['session', 'close', '--session', s.sessionId, '--destroy']);
      if (!/"ok":true/.test(closed)) run(CLI, ['session', 'abort', '--session', s.sessionId]);
    }
  }
}

function decode(s) {
  return (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
function csvRows(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Root schematic: the .kicad_sch no other sheet points at (prefer the project
// name), matching the converter's rule.
function rootSchematic(dir, projectName) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.kicad_sch')) : [];
  const referenced = new Set();
  for (const f of files) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /\(property\s+"Sheetfile"\s+"([^"]+)"/g;
    let m;
    while ((m = re.exec(txt))) referenced.add(path.basename(m[1]));
  }
  const byName = files.find(f => f === projectName + '.kicad_sch');
  if (byName) return path.join(dir, byName);
  const root = files.find(f => !referenced.has(f));
  return root ? path.join(dir, root) : null;
}

function kicadRefs(name, stageDir) {
  const dir = path.join(REF, name);
  fs.mkdirSync(dir, { recursive: true });
  const root = rootSchematic(stageDir, name);
  const pcbs = fs.existsSync(stageDir) ? fs.readdirSync(stageDir).filter(f => f.endsWith('.kicad_pcb')) : [];
  const pcb = pcbs.length ? path.join(stageDir, pcbs[0]) : null;
  const ref = { root, pcb };
  if (pcb) {
    ref.pcbMeta = parseKicadPcb(pcb);
    ref.rules = readKicadRules(stageDir, name);
    const drcJson = path.join(dir, 'drc.json');
    run(KCLI, ['pcb', 'drc', '--format', 'json', '--severity-all', '-o', drcJson, pcb]);
    try {
      const j = JSON.parse(fs.readFileSync(drcJson, 'utf8'));
      ref.pcbMeta.unconnected = (j.unconnected_items || []).length;
    } catch (e) { /* DRC unavailable */ }
  }
  if (root) {
    const netXml = path.join(dir, 'net.xml');
    const bomCsv = path.join(dir, 'bom.csv');
    run(KCLI, ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', netXml, root]);
    run(KCLI, ['sch', 'export', 'bom', '--fields', 'Reference,Value,Footprint',
      '--labels', 'Ref,Value,Footprint', '--field-delimiter', ',', '--ref-delimiter', ' ',
      '-o', bomCsv, root]);
    if (fs.existsSync(netXml)) {
      const xml = fs.readFileSync(netXml, 'utf8');
      ref.components = [];
      const compRe = /<comp ref="([^"]+)">([\s\S]*?)<\/comp>/g;
      let m;
      while ((m = compRe.exec(xml))) {
        const body = m[2];
        const value = /<value>([\s\S]*?)<\/value>/.exec(body);
        const fp = /<footprint>([\s\S]*?)<\/footprint>/.exec(body);
        const sheet = /<property name="Sheetfile" value="([^"]*)"/.exec(body);
        const base = sheet ? path.basename(sheet[1]).replace(/\.kicad_sch$/i, '') : '';
        // Reused sheets appear as several <sheetpath> instances; the path (not
        // the file) identifies which page instance a component belongs to.
        const sp = /<sheetpath names="([^"]*)"/.exec(body);
        ref.components.push({ ref: decode(m[1]), value: value ? decode(value[1]) : '', footprint: fp ? decode(fp[1]) : '',
          sheet: base.replace(/[^\w.-]+/g, '_'), sheetPath: sp ? decode(sp[1]) : '', sim: /<field name="Sim\./.test(body) });
      }
      ref.nets = [];
      const netRe = /<net code="\d+" name="([^"]*)"[^>]*>([\s\S]*?)<\/net>/g;
      while ((m = netRe.exec(xml))) {
        const nodes = [];
        const nodeRe = /<node ref="([^"]+)" pin="([^"]+)"/g;
        let n;
        while ((n = nodeRe.exec(m[2]))) nodes.push({ ref: decode(n[1]), pin: decode(n[2]) });
        ref.nets.push({ name: decode(m[1]), nodes });
      }
    }
  }
  if (pcb) {
    const posCsv = path.join(dir, 'pos.csv');
    run(KCLI, ['pcb', 'export', 'pos', '--format', 'csv', '--units', 'mm', '--side', 'both', '-o', posCsv, pcb]);
    if (fs.existsSync(posCsv)) {
      const rows = csvRows(fs.readFileSync(posCsv, 'utf8'));
      ref.pos = [];
      for (const r of rows.slice(1)) {
        if (!r[0]) continue;
        ref.pos.push({ ref: r[0], value: r[1], footprint: r[2], x: +r[3] * K, y: +r[4] * K, rot: +r[5] });
      }
    }
  }
  return ref;
}

// Compare converted-PCB structure with the KiCad source: primitive counts,
// copper layer count, stackup, design-rule defaults and visible ratlines.
function comparePcbMeta(probeValue, ref, edaMeta, report) {
  const km = ref.pcbMeta;
  if (!km || !edaMeta) return;
  const issues = report.issues;
  const checks = [
    ['tracks', km.tracks, edaMeta.tracks],
    ['vias', km.vias, edaMeta.vias],
    ['pads', km.pads, edaMeta.pads],
    ['footprints', km.footprints, edaMeta.components],
    ['copper-zones', km.zones, edaMeta.pours],
    ['keepouts', km.keepouts, edaMeta.regions]
  ];
  for (const [label, k, e] of checks) {
    if (k !== e) issues.push({ type: 'pcb-count', label, kicad: k, eda: e });
  }
  const kNetNames = new Set(km.netNames || []);
  const eNetNames = new Set(edaMeta.netNames || []);
  const missingNets = [...kNetNames].filter(n => !eNetNames.has(n));
  const extraNets = [...eNetNames].filter(n => !kNetNames.has(n));
  if (missingNets.length || extraNets.length) {
    issues.push({ type: 'pcb-net-names', missing: missingNets.slice(0, 8), extra: extraNets.slice(0, 8) });
  }
  // Pad-level check: every KiCad placed pad must exist in EDA at the same
  // position, with the same number, net and copper side. This catches the
  // bottom-footprint bugs that only show up as airwires (pads mirrored to the
  // wrong side, or pad positions permuted inside an asymmetric footprint).
  const kPads = Array.isArray(km.padList) ? km.padList : [];
  const ePads = Array.isArray(probeValue.pcbPads) ? probeValue.pcbPads.filter(p => Number.isFinite(p.x)) : [];
  let padCheck = null;
  if (kPads.length && ePads.length) {
    const norm = n => (!n || /^unconnected-\(/.test(n)) ? '' : n;
    const used = new Set();
    const bad = [];
    for (const kp of kPads) {
      let bi = -1, bd = Infinity;
      for (let i = 0; i < ePads.length; i++) {
        if (used.has(i)) continue;
        const d = Math.hypot(ePads[i].x - kp.x, ePads[i].y - kp.y);
        if (d < bd) { bd = d; bi = i; }
      }
      if (bi < 0 || bd > 6) {
        bad.push({ num: kp.num, net: kp.net, x: +kp.x.toFixed(1), y: +kp.y.toFixed(1), d: +bd.toFixed(1) });
        continue;
      }
      used.add(bi);
      const ep = ePads[bi];
      if (String(ep.num) !== String(kp.num) || ep.layer !== kp.side || norm(ep.net) !== norm(kp.net)) {
        bad.push({
          num: kp.num, net: kp.net, kicadSide: kp.side,
          edaSide: ep.layer, edaNum: ep.num, edaNet: ep.net, d: +bd.toFixed(1)
        });
      }
    }
    if (bad.length) issues.push({ type: 'pcb-pads', count: bad.length, samples: bad.slice(0, 6) });
    padCheck = { kicad: kPads.length, eda: ePads.length, mismatches: bad.length };
  }
  if (km.copperLayers.length !== edaMeta.copperLayers.length) {
    issues.push({ type: 'pcb-layers', kicad: km.copperLayers.length, eda: edaMeta.copperLayers.length });
  }
  if (km.stackupCopper && km.stackupCopper !== edaMeta.stackupCopper) {
    issues.push({ type: 'pcb-stackup', kicad: km.stackupCopper, eda: edaMeta.stackupCopper });
  }
  const st = probeValue.stackup;
  if (st && Number.isFinite(st.totalThickness) && km.stackupThickness > 0) {
    const unit = String(st.unit || '').toLowerCase();
    const edaMm = unit.includes('mil') ? st.totalThickness / 39.37007874015748 : st.totalThickness;
    const refMm = km.boardThickness > 0 ? km.boardThickness : km.stackupThickness;
    if (Math.abs(edaMm - refMm) > 0.02) {
      issues.push({ type: 'pcb-stackup-thickness', kicad: +refMm.toFixed(3), eda: +edaMm.toFixed(3) });
    }
  }
  const nc = ref.rules && ref.rules.netclass;
  if (nc) {
    const er = edaMeta.rules || {};
    if (nc.track_width != null && er.trackWidth != null && Math.abs(nc.track_width - er.trackWidth) > 0.011) {
      issues.push({ type: 'rule-track-width', kicad: nc.track_width, eda: er.trackWidth });
    }
    if (nc.via_diameter != null && er.viaDiameter != null && Math.abs(nc.via_diameter - er.viaDiameter) > 0.011) {
      issues.push({ type: 'rule-via-diameter', kicad: nc.via_diameter, eda: er.viaDiameter });
    }
    if (nc.via_drill != null && er.viaDrill != null && Math.abs(nc.via_drill - er.viaDrill) > 0.011) {
      issues.push({ type: 'rule-via-drill', kicad: nc.via_drill, eda: er.viaDrill });
    }
  }
  // Fabrication minimums live in every KiCad project; compare the rule values
  // the converter mapped from them.
  const mins = ref.rules && ref.rules.minimums || {};
  const er = edaMeta.rules || {};
  if (mins.min_track_width != null && er.trackMinWidth != null
    && Math.abs(mins.min_track_width - er.trackMinWidth) > 0.011) {
    issues.push({ type: 'rule-min-track-width', kicad: mins.min_track_width, eda: er.trackMinWidth });
  }
  if (mins.min_via_diameter != null && er.viaMinDiameter != null
    && Math.abs(mins.min_via_diameter - er.viaMinDiameter) > 0.011) {
    issues.push({ type: 'rule-min-via-diameter', kicad: mins.min_via_diameter, eda: er.viaMinDiameter });
  }
  if (mins.min_through_hole_diameter != null && er.viaMinDrill != null
    && Math.abs(mins.min_through_hole_diameter - er.viaMinDrill) > 0.011) {
    issues.push({ type: 'rule-min-hole-diameter', kicad: mins.min_through_hole_diameter, eda: er.viaMinDrill });
  }
  const px = probeValue.ratlinePixels;
  const ku = km.unconnected;
  report.ratlines = { kicadUnconnected: ku, edaPixels: px };
  if (Number.isFinite(px)) {
    if (ku === 0 && px > 30) issues.push({ type: 'ratlines', edaPixels: px });
    else if (ku > 0 && px === 0) issues.push({ type: 'ratlines-missing', kicad: ku });
  }
  report.pcbMeta = {
    kicad: {
      tracks: km.tracks, vias: km.vias, pads: km.pads, footprints: km.footprints,
      zones: km.zones, keepouts: km.keepouts, copper: km.copperLayers.length,
      stackupCopper: km.stackupCopper, nets: km.nets
    },
    eda: {
      tracks: edaMeta.tracks, vias: edaMeta.vias, pads: edaMeta.pads,
      components: edaMeta.components, pours: edaMeta.pours, regions: edaMeta.regions,
      copper: edaMeta.copperLayers.length, stackupCopper: edaMeta.stackupCopper, nets: edaMeta.nets
    },
    rules: { kicad: nc || null, eda: edaMeta.rules, minimums: ref.rules && ref.rules.minimums },
    padCheck,
    stackup: {
      kicadCopper: km.stackupCopper, edaCopper: edaMeta.stackupCopper,
      kicadThicknessMm: +km.stackupThickness.toFixed(3), eda: st || null
    }
  };
}

function compareProject(name, probeValue, ref, edaMeta) {
  const report = { name, issues: [] };
  const pages = (probeValue && probeValue.pages) || [];
  // PCB-only demos have no KiCad schematic: skip the netlist/BOM sections and
  // compare the PCB alone instead of reporting "no page netlists".
  const hasSch = !!ref.root;
  if (hasSch && !pages.length) { report.issues.push({ type: 'netlist', msg: 'no page netlists' }); return report; }
  const isPower = r => /^#/.test(r);

  // Reused sheets: the CBB schematic stores the first instance's designators;
  // EasyEDA suffixes instances as REF$CBB<n>, so translate before comparing.
  const model = hasSch ? buildInstanceModel(path.join(STAGE, name), name) : { mapRef: {} };
  const mapRef = model.mapRef || {};
  const tr = r => mapRef[r] || r;

  // EasyEDA global connectivity: a non-CBB page's netlist already contains the
  // expanded CBB instances (REF$CBBn) and the nets they connect to. Protel2 is
  // used because the JLCEDA JSON export omits CBB-expanded components.
  const rootPages = pages.filter(p => p.itemType !== 'CBB Schematic' && p.netlistProtel);
  const edaComps = new Map();
  const edaPins = {};
  for (const p of rootPages) {
    const parsed = parseProtel(p.netlistProtel);
    for (const [r, info] of parsed.comps) if (!isPower(r)) edaComps.set(r, info);
    for (const [key, net] of Object.entries(parsed.pins)) {
      if (isPower(key.split(':')[0])) continue;
      // Auto names ($...) are page-local; named nets come from labels/flags.
      edaPins[key] = /^\$/.test(net) ? p.schematic + '|' + net : net;
    }
  }

  // ---- connectivity partitions (global, hierarchy expanded) ----
  const byK = new Map(); // KiCad net -> nodes translated to EasyEDA refs
  for (const n of ref.nets || []) {
    for (const node of n.nodes) {
      if (isPower(node.ref)) continue;
      const key = tr(node.ref) + ':' + node.pin;
      const present = Object.prototype.hasOwnProperty.call(edaPins, key);
      if (!byK.has(n.name)) byK.set(n.name, []);
      byK.get(n.name).push({ key, present, edaNet: present ? edaPins[key] : null });
    }
  }
  for (const [kn, nodes] of byK) {
    if (nodes.length < 2) continue;
    const present = nodes.filter(x => x.present);
    const ens = new Set(present.map(x => x.edaNet));
    const missing = nodes.filter(x => !x.present).map(x => x.key);
    if (missing.length || ens.size !== 1 || ens.has('')) {
      report.issues.push({
        type: 'connectivity', kicad: kn, pins: nodes.slice(0, 10).map(x => x.key),
        eda: [...ens].slice(0, 5), missing: missing.slice(0, 10)
      });
    }
  }
  const byEdaNet = new Map();
  for (const [kn, nodes] of byK) {
    for (const x of nodes) {
      if (!x.present || !x.edaNet) continue;
      if (!byEdaNet.has(x.edaNet)) byEdaNet.set(x.edaNet, new Set());
      byEdaNet.get(x.edaNet).add(kn);
    }
  }
  for (const [en, kns] of byEdaNet) {
    if (kns.size > 1) report.issues.push({ type: 'connectivity-merge', eda: en, kicad: [...kns].slice(0, 5) });
  }

  // ---- BOM (global, refs translated for reused instances) ----
  if (ref.components) {
    const kbom = new Map(ref.components.filter(c => c.ref && !isPower(c.ref)).map(c => [c.ref, c]));
    const translated = new Set();
    for (const [refName, k] of kbom) {
      const target = tr(refName);
      translated.add(target);
      const e = edaComps.get(target);
      if (!e) { report.issues.push({ type: 'bom-missing', ref: target, kicad: { value: k.value, footprint: k.footprint } }); continue; }
      if (!k.sim && k.value && e.value && k.value !== e.value) report.issues.push({ type: 'bom-value', ref: target, kicad: k.value, eda: e.value });
    }
    for (const r of edaComps.keys()) if (!translated.has(r)) report.issues.push({ type: 'bom-extra', ref: r });
  }

  // ---- PCB coordinates ----
  if (ref.pos && probeValue.pcbComps) {
    // Several footprints may share one designator (e.g. KiCad's unannotated
    // "POLY"), so match within each designator group by nearest position
    // instead of collapsing them to a single map entry.
    const eGroups = new Map();
    for (const c of probeValue.pcbComps) {
      if (!c.designator) continue;
      if (!eGroups.has(c.designator)) eGroups.set(c.designator, []);
      eGroups.get(c.designator).push(c);
    }
    let checked = 0;
    for (const k of ref.pos) {
      const cands = eGroups.get(k.ref);
      if (!cands || !cands.length) continue;
      let bi = 0, bd = Infinity;
      for (let i = 0; i < cands.length; i++) {
        const d = Math.hypot(cands[i].x - k.x, cands[i].y - k.y);
        if (d < bd) { bd = d; bi = i; }
      }
      const e = cands.splice(bi, 1)[0];
      checked++;
      const d = Math.hypot(e.x - k.x, e.y - k.y);
      if (d > 2) report.issues.push({ type: 'pcb-pos', ref: k.ref, kicad: [+k.x.toFixed(1), +k.y.toFixed(1)], eda: [+e.x.toFixed(1), +e.y.toFixed(1)], dist: +d.toFixed(1) });
      const da = ((e.rotation - k.rot) % 360 + 540) % 360 - 180;
      if (Math.abs(da) > 0.01) report.issues.push({ type: 'pcb-rot', ref: k.ref, kicad: k.rot, eda: e.rotation });
    }
    report.pcbChecked = checked;
  }
  comparePcbMeta(probeValue, ref, edaMeta, report);
  return report;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  closeStraySessions();
  const projects = fs.existsSync(DST) ? fs.readdirSync(DST).filter(d => {
    try { return fs.statSync(path.join(DST, d)).isDirectory(); } catch (e) { return false; }
  }) : [];
  const only = new Set(process.argv.slice(2));
  const summary = [];
  for (const name of projects) {
    if (only.size && !only.has(name)) continue;
    const dir = path.join(DST, name);
    const index = fs.readdirSync(dir).find(f => f.endsWith('.eprj3'));
    if (!index) continue;
    const t0 = Date.now();
    const ref = kicadRefs(name, path.join(STAGE, name));
    let edaMeta = null;
    try {
      const pcbDir = path.join(dir, 'pcb');
      const epcb = fs.readdirSync(pcbDir).find(f => f.endsWith('.epcb2'));
      if (epcb) edaMeta = parseEdaPcb(path.join(pcbDir, epcb));
    } catch (e) { /* PCB-less project */ }
    const sid = openProject(path.join(dir, index));
    let probe = { ok: false, error: { message: 'open failed' } };
    if (sid) {
      probe = invoke(sid, PROBE, { root: name });
      close(sid);
    }
    const report = probe.ok
      ? compareProject(name, probe.value, ref, edaMeta)
      : { name, issues: [{ type: 'open', msg: JSON.stringify(probe.error && probe.error.message || probe).slice(0, 300) }] };
    report.ms = Date.now() - t0;
    fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(report, null, 1));
    const counts = {};
    for (const i of report.issues) counts[i.type] = (counts[i.type] || 0) + 1;
    summary.push({ name, issues: report.issues.length, counts, pcbChecked: report.pcbChecked || 0, ms: report.ms });
    console.log(`${report.issues.length ? 'ISSUES' : 'OK    '} ${name} ${JSON.stringify(counts)}`);
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log('\n=== summary ===');
  console.log(JSON.stringify(summary, null, 1));
}
module.exports = { kicadRefs, compareProject };
if (require.main === module) main();
