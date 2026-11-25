'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = 'D:/Documents/KiCAD/demos';
const DST = 'D:/Documents/KiCAD/demos/eprj3';
const STAGE = path.join(ROOT, 'tmp', 'demo-stage');
const CONVERT = path.join(ROOT, 'scripts', 'convert-kicad.js');
// Every run starts from a clean output tree (user requirement).
fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
fs.mkdirSync(STAGE, { recursive: true });

function walk(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith('.kicad_pro')) out.push(p);
  }
}
const projects = [];
walk(SRC, 3, projects);
const candidates = projects
  .filter(p => !/unroute/i.test(path.basename(p)))
  .map(pro => {
    const dir = path.dirname(pro);
    const base = path.basename(pro, '.kicad_pro');
    return { pro, dir, base, mainSch: path.join(dir, base + '.kicad_sch'), mainPcb: path.join(dir, base + '.kicad_pcb') };
  });
// direct schematics without .kicad_pro (e.g. simulation/subsheets)
for (const dir of [path.join(SRC, 'simulation', 'subsheets')]) {
  if (fs.existsSync(path.join(dir, 'subsheets.kicad_sch'))) {
    candidates.push({ dir, base: 'subsheets', mainSch: path.join(dir, 'subsheets.kicad_sch'), mainPcb: path.join(dir, 'subsheets.kicad_pcb') });
  }
}

function safeName(s) { return s.replace(/[^A-Za-z0-9._-]+/g, '_'); }
function collectSheets(sch, baseDir, seen, out) {
  if (!sch || !fs.existsSync(sch)) return;
  const real = path.resolve(sch);
  if (seen.has(real)) return;
  seen.add(real); out.push(real);
  let txt = '';
  try { txt = fs.readFileSync(real, 'utf8'); } catch (e) { return; }
  const re = /\(property\s+"Sheetfile"\s+"([^"]+)"|\(sheetfile\s+"([^"]+)"/g;
  let m;
  while ((m = re.exec(txt))) {
    const f = m[1] || m[2];
    const p = path.resolve(baseDir, f);
    if (fs.existsSync(p)) collectSheets(p, path.dirname(p), seen, out);
  }
}

const only = new Set(process.argv.slice(2));
const results = [];
for (const c of candidates) {
  if (only.size && !only.has(safeName(c.base))) continue;
  const hasSch = !!c.mainSch && fs.existsSync(c.mainSch);
  const hasPcb = !!c.mainPcb && fs.existsSync(c.mainPcb);
  if (!hasSch && !hasPcb) { results.push({ name: c.base, status: 'skip', note: 'no main sch/pcb' }); continue; }
  const name = safeName(c.base);
  const stage = path.join(STAGE, name);
  const out = path.join(DST, name);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const sheets = [];
  if (hasSch) collectSheets(c.mainSch, c.dir, new Set(), sheets);
  for (const s of sheets) {
    let target = path.join(stage, path.basename(s));
    if (fs.existsSync(target)) target = path.join(stage, 'sub_' + path.basename(s));
    fs.copyFileSync(s, target);
  }
  if (hasPcb) fs.copyFileSync(c.mainPcb, path.join(stage, path.basename(c.mainPcb)));
  if (c.pro && fs.existsSync(c.pro)) fs.copyFileSync(c.pro, path.join(stage, path.basename(c.pro)));
  const r = spawnSync(process.execPath, [CONVERT, 'convert', stage, out, '--project-name', name], { encoding: 'utf8', timeout: 600000 });
  const log = ((r.stdout || '') + (r.stderr || '')).trim();
  fs.writeFileSync(path.join(STAGE, name + '.log'), log + '\n');
  results.push({ name, status: r.status === 0 ? 'ok' : 'FAIL', exit: r.status, sheets: sheets.length, pcb: hasPcb, note: log.split(/\r?\n/).slice(-2).join(' | ') });
  console.log(`${r.status === 0 ? 'OK  ' : 'FAIL'} ${name} (sheets=${sheets.length} pcb=${hasPcb})`);
}
console.log('\n=== summary ===');
for (const r of results) console.log(JSON.stringify(r));
