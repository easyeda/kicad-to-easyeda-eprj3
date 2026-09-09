#!/usr/bin/env node
'use strict';
/**
 * smoke.js — End-to-end regression test for the KiCad → eprj3 converter.
 *
 * Runs the real scripts against a throwaway directory in the OS temp dir and
 * asserts the invariants that have historically regressed:
 *   - KiCad symbol parser handles nested unit symbols (pins/shapes merged)
 *   - converter maps layer names to the right layer ids (B.Cu → 2)
 *   - converter emits one LAYER record per layer id it can emit
 *   - symbol instances keep Designator/Value ATTRs linked to the COMPONENT
 *   - mm → mil conversion factor (39.3700787)
 *   - import-kicad-lib injects a symbol into an existing project
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const { readRecords } = require(path.join(SCRIPTS, 'lib', 'eprj3'));

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
    (symbol "MY_RES_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
    )
    (symbol "MY_RES_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
    )
  )
)`;

const kicadSchSample = `(kicad_sch (version 20230121) (generator eeschema)
  (wire (pts (xy 10 10) (xy 20 10)))
  (label "NET1" (at 10 10 0) (effects (font (size 1.27 1.27))))
  (symbol (lib_id "Device:R") (at 30 30 0) (unit 1)
    (property "Reference" "R1" (at 30 28 0) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 30 32 0) (effects (font (size 1.27 1.27))))
  )
)`;

const kicadPcbSample = `(kicad_pcb (version 20221018) (generator pcbnew)
  (segment (start 0 0) (end 10 0) (width 0.25) (layer "B.Cu") (net 1))
  (footprint "R_0603" (layer "F.Cu") (at 5 5)
    (pad "1" smd rect (at -0.75 0) (size 0.8 0.8) (layers "F.Cu"))
    (fp_line (start -1.5 -0.8) (end 1.5 -0.8) (stroke (width 0.1) (type solid)))
  )
)`;

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kicad2eprj3-smoke-'));

  try {
    fs.writeFileSync(path.join(tmp, 'sample.kicad_sym'), kicadSymSample);
    fs.writeFileSync(path.join(tmp, 'sample.kicad_sch'), kicadSchSample);
    fs.writeFileSync(path.join(tmp, 'sample.kicad_pcb'), kicadPcbSample);

    // ---- project conversion (batch: walks every .kicad_sch / .kicad_pcb) ----
    const dst = path.join(tmp, 'conv');
    run([SCRIPTS + '/convert-kicad.js', 'convert', '--src', tmp, '--dst', dst, '--project-name', 'conv']);
    assert(fs.existsSync(path.join(dst, 'conv.eprj3')), 'convert-kicad creates the project index');

    const convSch = readRecords(path.join(dst, 'sch', 'Schematic1', 'P1.esch2'));
    assert(convSch.filter(r => r.type === 'COMPONENT').length === 1, 'convert-kicad maps symbol instances');
    assert(convSch.some(r => r.type === 'ATTR' && r.body.key === 'Designator' && r.body.value === 'R1')
        && convSch.some(r => r.type === 'ATTR' && r.body.key === 'Value' && r.body.value === '10k'),
      'convert-kicad emits Designator/Value ATTRs linked to the component');
    const comp = convSch.find(r => r.type === 'COMPONENT');
    assert(comp && comp.body.id && comp.head.id === comp.body.id, 'COMPONENT head id == body id');
    const compAttr = convSch.filter(r => r.type === 'ATTR');
    assert(compAttr.every(r => r.body.parentId === comp.body.id), 'every ATTR.parentId == COMPONENT id');

    const convPcb = readRecords(path.join(dst, 'pcb', 'PCB1.epcb2'));
    assert(convPcb.filter(r => r.type === 'LAYER').length === 4, 'convert-kicad defines all layer ids it can emit');
    const fill = convPcb.find(r => r.type === 'FILL');
    assert(fill && fill.body.layerId === 2, 'convert-kicad maps B.Cu segments to layerId 2', `layerId=${fill && fill.body.layerId}`);
    assert(convPcb.some(r => r.type === 'PAD' && r.body.num === '1'), 'convert-kicad converts footprint pads');

    // ---- library import into an existing project ----
    run([SCRIPTS + '/import-kicad-lib.js', 'import', '--dir', dst, '--library', path.join(tmp, 'sample.kicad_sym'), '--component', 'MY_RES']);
    const symFile = path.join(dst, 'sch', '__symbols__', 'MY_RES.esch2');
    const symRecs = fs.existsSync(symFile) ? readRecords(symFile) : [];
    const docHead = symRecs.find(r => r.type === 'DOCHEAD');
    assert(!!docHead, 'import-kicad-lib writes a SYMBOL doc into __symbols__');
    assert(symRecs.some(r => r.type === 'PIN'), 'imported symbol contains PIN records');
    const rMiss = run([SCRIPTS + '/import-kicad-lib.js', 'import', '--dir', dst, '--library', path.join(tmp, 'sample.kicad_sym'), '--component', 'NOPE'], null);
    assert(rMiss.status !== 0, 'import-kicad-lib fails on unknown component instead of creating a doc', `exit ${rMiss.status}`);

    // ---- parser (nested unit symbols) ----
    const { parseSymbolFile } = require(path.join(SCRIPTS, 'lib', 'kicad'));
    const syms = parseSymbolFile(path.join(tmp, 'sample.kicad_sym'));
    const myRes = syms.find(s => s.name === 'MY_RES');
    assert(!!myRes, 'kicad parser finds the top-level symbol');
    assert(myRes && myRes.pins.length === 2, 'kicad parser merges pins from nested unit symbols', `pins=${myRes && myRes.pins.length}`);
    assert(myRes && myRes.shapes.length === 1, 'kicad parser merges shapes from nested unit symbols');
    assert(myRes && myRes.properties.Value === 'MY_RES', 'kicad parser reads properties');

    // ---- unit conversion ----
    const { kicadToEprj3 } = require(path.join(SCRIPTS, 'lib', 'kicad-to-eprj3'));
    assert(Math.abs(kicadToEprj3(1) - 39.3700787) < 1e-6, 'kicadToEprj3 converts mm to mil (39.37)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main();
