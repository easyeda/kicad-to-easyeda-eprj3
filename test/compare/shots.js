'use strict';
// Export KiCad per-layer renders (kicad-cli SVG -> Chrome PNG) for a project,
// and (optionally) the matching EDA layer screenshots, then write an HTML
// side-by-side contact sheet.
// Usage: node tmp/compare/shots.js <project> [--eda]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const KCLI = 'C:/Users/easyeda/AppData/Local/Programs/KiCad/10.0/bin/kicad-cli.exe';
const CLI = 'C:/Program Files/lceda-pro/lceda-pro.exe';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const STAGE = path.join(ROOT, 'tmp', 'demo-stage');
const DST = 'D:/Documents/KiCAD/demos/eprj3';
const OUT = path.join(ROOT, 'tmp', 'compare', 'shots');
const LAYERS = [
  { id: 1, kicad: 'F.Cu', name: 'top-copper' },
  { id: 2, kicad: 'B.Cu', name: 'bottom-copper' },
  { id: 3, kicad: 'F.SilkS', name: 'top-silk' },
  { id: 4, kicad: 'B.SilkS', name: 'bottom-silk' },
  { id: 11, kicad: 'Edge.Cuts', name: 'outline' }
];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024, ...opts
  });
}
function renderSvg(svg, png) {
  const profile = path.join(OUT, '.chrome-' + process.pid);
  run(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--user-data-dir=' + profile, '--window-size=1400,1000',
    '--screenshot=' + png, 'file:///' + svg.replace(/\\/g, '/')]);
  // Chrome may flush the screenshot right after its process exits.
  for (let i = 0; i < 25; i++) {
    if (fs.existsSync(png)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return fs.existsSync(png);
}

function kicadShots(name) {
  const dir = path.join(STAGE, name);
  if (!fs.existsSync(dir)) return [];
  const pcb = fs.readdirSync(dir).find(f => f.endsWith('.kicad_pcb'));
  if (!pcb) return [];
  const kdir = path.join(OUT, name, 'kicad');
  fs.mkdirSync(kdir, { recursive: true });
  const made = [];
  for (const l of LAYERS) {
    const svg = path.join(kdir, l.name + '.svg');
    const png = path.join(kdir, l.name + '.png');
    run(KCLI, ['pcb', 'export', 'svg', '--layers', l.kicad, '--page-size-mode', '2',
      '--exclude-drawing-sheet', '--mode-single', '-o', svg, path.join(dir, pcb)]);
    if (fs.existsSync(svg) && renderSvg(svg, png)) made.push(l);
  }
  return made;
}

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

function kicadSchShots(name) {
  const dir = path.join(STAGE, name);
  const root = rootSchematic(dir, name);
  if (!root) return [];
  const outdir = path.join(OUT, name, 'kicad-sch');
  fs.mkdirSync(outdir, { recursive: true });
  run(KCLI, ['sch', 'export', 'svg', '-o', outdir, root]);
  const made = [];
  for (const f of fs.readdirSync(outdir).filter(f => f.endsWith('.svg'))) {
    const png = f.replace(/\.svg$/, '.png');
    if (renderSvg(path.join(outdir, f), path.join(outdir, png))) made.push(f.replace(/\.svg$/, ''));
  }
  return made;
}

// ---- EasyEDA captures (layout screenshots + schematic pages) ----
// Schematic zoom region = the KiCad drawing frame, so off-page symbols do not
// shrink the render (zoomToAllPrimitives would include them).
const PAGE_HEIGHT_UNITS = { A4: 825, A3: 1167, A2: 1651, A1: 2334, A0: 3301 };
const PAPER_SIZE_MM = {
  A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841]
};
function pageRegion(name) {
  const dir = path.join(STAGE, name);
  const file = path.join(dir, name.replace(/_\d+$/, '') + '.kicad_sch');
  if (!fs.existsSync(file)) return null;
  const m = /\(paper\s+"([^"]+)"/.exec(fs.readFileSync(file, 'utf8'));
  const paper = m ? m[1] : 'A4';
  const H = PAGE_HEIGHT_UNITS[paper] || 825;
  const [Wmm, Hmm] = PAPER_SIZE_MM[paper] || [297, 210];
  const toSch = mm => mm / 0.254;
  return [0, toSch(Wmm), -H, -H + toSch(Hmm)];
}

function invoke(sid, code, args = {}) {
  const out = run(CLI, ['invoke', '--session', sid, '--ext-uuid', 'eda', '--code', code,
    '--args', JSON.stringify(args), '--timeout', '600000']);
  const text = out.stdout || '';
  const line = text.trim().split(/\r?\n/).find(l => l.startsWith('{'));
  if (line) {
    try { return JSON.parse(line); } catch (e) { /* fall through */ }
  }
  // Very large payloads arrive as a quoted/escaped JSON string literal.
  try {
    let v = JSON.parse(text.trim());
    if (typeof v === 'string') v = JSON.parse(v.trim());
    if (v && typeof v === 'object') return v;
  } catch (e) { /* not double-encoded */ }
  return { ok: false, error: { message: text.slice(0, 300) } };
}

function writeB64(file, b64) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
}

function edaShots(name) {
  const dir = path.join(DST, name);
  if (!fs.existsSync(dir)) return { layers: [], schematics: [] };
  const index = fs.readdirSync(dir).find(f => f.endsWith('.eprj3'));
  if (!index) return { layers: [], schematics: [] };
  const open = run(CLI, ['open', '--path', path.join(dir, index), '--headless', 'true']);
  const m = /"sessionId":"([^"]+)"/.exec(open.stdout);
  if (!m) { console.error('EDA open failed: ' + open.stdout.slice(0, 300)); return { layers: [], schematics: [] }; }
  const sid = m[1];
  const code = fs.readFileSync(path.join(__dirname, 'capture-eda.js'), 'utf8');
  const regions = {};
  const schDir = path.join(DST, name, 'sch');
  if (fs.existsSync(schDir)) {
    for (const d of fs.readdirSync(schDir)) {
      const r = pageRegion(d);
      if (r) regions[d] = r;
    }
  }
  const res = invoke(sid, code, { layers: LAYERS.map(l => l.id), regions });
  run(CLI, ['session', 'close', '--session', sid, '--destroy']);
  if (!res.ok || !res.value) {
    console.error('EDA capture failed: ' + JSON.stringify(res.error || {}).slice(0, 300));
    return { layers: [], schematics: [] };
  }
  const v = res.value;
  const layers = [];
  for (const l of LAYERS) {
    const b64 = v.pcb && v.pcb[l.id];
    if (b64 && !b64.startsWith('ERR:')) {
      writeB64(path.join(OUT, name, 'eda', l.name + '.png'), b64);
      layers.push(l);
    }
  }
  const schematics = [];
  for (const p of v.sch || []) {
    if (!p.b64) { console.error(`EDA sch shot failed: ${p.title} ${p.error || ''}`); continue; }
    const key = String(p.title || 'page').replace(/[^\w.-]+/g, '_');
    writeB64(path.join(OUT, name, 'eda-sch', key + '.png'), p.b64);
    schematics.push(key);
  }
  return { layers, schematics };
}

// Designator sets per EasyEDA page (the last doc of each .esch2 is the page doc).
function edaPageDesignators(name) {
  const dir = path.join(DST, name, 'sch');
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, d + '.esch2');
    if (!fs.existsSync(f)) continue;
    const pages = [];
    let cur = null;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('||');
      if (i < 0) continue;
      let head;
      try { head = JSON.parse(line.slice(0, i)); } catch (e) { continue; }
      if (head.type === 'DOCHEAD') { if (cur) pages.push(cur); cur = { recs: [] }; continue; }
      if (!cur) continue;
      try {
        cur.recs.push({ type: head.type, body: JSON.parse(line.slice(i + 2).replace(/\|\s*$/, '')) });
      } catch (e) { /* skip malformed record */ }
    }
    if (cur) pages.push(cur);
    const page = pages[pages.length - 1];
    if (!page) continue;
    out[d] = page.recs.filter(r => r.type === 'ATTR' && r.body.key === 'Designator' && r.body.value)
      .map(r => r.body.value);
  }
  return out;
}

// KiCad component refs grouped by hierarchical sheetpath (reference netlist
// exported by kicad-cli during the comparison run).
function kicadSheetRefs(name) {
  const f = path.join(ROOT, 'tmp', 'compare', 'ref', name, 'net.xml');
  const out = new Map();
  if (!fs.existsSync(f)) return out;
  const xml = fs.readFileSync(f, 'utf8');
  const re = /<comp ref="([^"]+)">([\s\S]*?)<\/comp>/g;
  let m;
  while ((m = re.exec(xml))) {
    const sp = /<sheetpath names="([^"]*)"/.exec(m[2]);
    const key = sp ? sp[1] : '/';
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(m[1]);
  }
  return out;
}

function sheetSvgBase(name, sheetPath) {
  if (!sheetPath || sheetPath === '/') return name;
  return name + '-' + sheetPath.split('/').filter(Boolean).join('-');
}

// Pair EasyEDA pages (file-based names, reused sheets get _2) with the KiCad
// instance SVGs (sheet-path-based names) by designator overlap.
function mapPages(name, pages) {
  const pd = edaPageDesignators(name);
  const ks = kicadSheetRefs(name);
  const used = new Set();
  return (pages || []).map(p => {
    const refs = new Set(pd[p] || []);
    let best = null, score = 0;
    for (const [sp, set] of ks) {
      if (used.has(sp)) continue;
      let inter = 0;
      for (const r of set) if (refs.has(r)) inter++;
      const sc = inter / Math.max(1, Math.min(set.size, refs.size));
      if (sc > score) { score = sc; best = sp; }
    }
    if (best && score >= 0.6) {
      used.add(best);
      return { label: p, kicad: sheetSvgBase(name, best), eda: p };
    }
    return { label: p, kicad: p, eda: p };
  });
}

function writeIndex(name, layers, pairs) {
  const rows = layers.map(l => `<tr><th>${l.name}</th>
    <td><img src="kicad/${l.name}.png"></td>
    <td><img src="eda/${l.name}.png" onerror="this.style.display='none'"></td></tr>`).join('\n');
  const schRows = (pairs || []).map(s => `<tr><th>${s.label}</th>
    <td><img src="kicad-sch/${s.kicad}.png" onerror="this.style.display='none'"></td>
    <td>${s.eda ? `<img src="eda-sch/${s.eda}.png" onerror="this.style.display='none'">` : '—'}</td></tr>`).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><title>${name}</title>
<style>body{font:13px sans-serif;margin:16px}table{border-collapse:collapse;margin-bottom:24px}th,td{border:1px solid #ccc;padding:4px;vertical-align:top}img{max-width:640px;display:block}th{writing-mode:vertical-rl;text-align:center}</style>
<h1>${name}</h1><p>左：KiCad 导出；右：EasyEDA 截图</p>
<h2>PCB 分层</h2>
<table><tr><th>层</th><th>KiCad</th><th>EasyEDA</th></tr>${rows}</table>
<h2>原理图</h2>
<table><tr><th>页</th><th>KiCad</th><th>EasyEDA</th></tr>${schRows}</table>`;
  fs.writeFileSync(path.join(OUT, name, 'index.html'), html);
}

function main() {
  const args = process.argv.slice(2);
  const name = args.find(a => !a.startsWith('--'));
  const withEda = args.includes('--eda');
  if (!name) {
    console.error('usage: node tmp/compare/shots.js <project> [--eda]');
    process.exit(1);
  }
  let layers = kicadShots(name);
  const schematics = kicadSchShots(name);
  let pairs = schematics.map(p => ({ label: p, kicad: p, eda: p }));
  if (withEda) {
    const eda = edaShots(name);
    const names = union(layers.map(l => l.name), eda.layers.map(l => l.name));
    layers = names.map(n => LAYERS.find(l => l.name === n) || { name: n });
    pairs = mapPages(name, eda.schematics);
    const usedK = new Set(pairs.map(p => p.kicad));
    for (const k of schematics) if (!usedK.has(k)) pairs.push({ label: k, kicad: k, eda: '' });
  }
  console.log(`KiCad PCB: ${layers.map(l => l.name).join(', ') || 'none'}`);
  console.log(`KiCad sch: ${pairs.map(p => p.label + '<-' + p.kicad).join(', ') || 'none'}`);
  writeIndex(name, layers.length ? layers : LAYERS, pairs);
}

function union(a, b) {
  return [...new Set([...(a || []), ...(b || [])])];
}

main();
