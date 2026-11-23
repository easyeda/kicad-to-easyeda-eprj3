'use strict';
// hostpath.test.js — host path grammar guard unit tests (no subprocess).
// Covers: valid instruction streams, tokenless/bare-close rejection, outline
// decoder rules (no C), R/CIRCLE sub-paths, POURED.pourFill coverage, and the
// repository's official export as a no-false-positive fixture.
const fs = require('fs');
const path = require('path');
const { simBuild8, validatePath, findViolation } = require('../scripts/lib/hostpath');

let checks = 0, failures = 0;
function assert(cond, name, detail = '') {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}

assert(simBuild8([0, 0, 'L', 10, 0, 'L', 10, 10, 'L', 0, 0]) === null, 'L-chained polygon is valid');
assert(simBuild8([0, 0, 'ARC', 90, 10, 10]) === null, 'ARC block (sweep-first) is valid');
assert(simBuild8([0, 0, 'CARC', 90, 10, 10]) === null, 'CARC block is valid for outline paths');
assert(simBuild8([0, 0, 'C', 1, 1, 2, 2, 3, 3]) === null, 'C block is valid for generic paths');
assert(simBuild8([0, 0, 'C', 1, 1, 2, 2, 3, 3], { outline: true }) !== null, 'C block is rejected for outline paths');
assert(simBuild8([0, 0, 10, 0]) !== null, 'tokenless path is rejected');
assert(simBuild8([0, 0, 'ARC', 90, 10, 10, 0, 0]) !== null, 'bare close-back pair after ARC is rejected');
assert(simBuild8([0, 0, 'X', 1, 2]) !== null, 'unknown token is rejected');

assert(validatePath(['R', 0, 100, 100, 100, 0, 0]) === null, 'R descriptor accepted');
assert(validatePath([['CIRCLE', 5, 5, 10, 1]]) === null, '5-element CIRCLE subpath accepted');
assert(validatePath([['CIRCLE', -31.5, -15.75, 2.361]]) === null, '4-element CIRCLE (official export) accepted');
assert(validatePath([['CIRCLE', 1, 2, 3, 4, 5]]) !== null, 'malformed CIRCLE subpath rejected');

const badPaths = [
  { head: { type: 'POLY', id: 'p1' }, body: { path: [0, 0, 10, 10] } },
  { head: { type: 'POLY', id: 'p2' }, body: { path: [0, 0, 'C', 1, 1, 2, 2, 3, 3] } }
];
assert(findViolation([badPaths[0]]) !== null, 'findViolation catches a tokenless POLY');
assert(findViolation([badPaths[1]]) !== null, 'findViolation rejects a C-token POLY (silently dropped by the client)');
assert(findViolation([{ head: { type: 'POLY', id: 'ok' }, body: { path: [0, 0, 'L', 10, 0, 10, 10] } }]) === null,
  'findViolation accepts a valid POLY');

const pouredOk = { head: { type: 'POURED', id: 'poured' }, body: { pourFill: [{ path: [[0, 0, 'L', 10, 0, 10, 10]] }] } };
const pouredBad = { head: { type: 'POURED', id: 'poured-bad' }, body: { pourFill: [{ path: [[0, 0, 10, 10]] }] } };
assert(findViolation([pouredOk]) === null, 'findViolation accepts valid POURED.pourFill paths');
assert(findViolation([pouredBad]) !== null, 'findViolation covers POURED.pourFill (not just body.path)');

// No false positives on the repository's official export.
const official = path.resolve(__dirname, '..', 'example', 'easyeda', 'easyeda-eprj3-project', 'pcb', 'PCB1.epcb2');
if (fs.existsSync(official)) {
  const records = [];
  for (const line of fs.readFileSync(official, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const sp = line.indexOf('||');
    if (sp < 0) continue;
    let head, body = null;
    try { head = JSON.parse(line.slice(0, sp)); } catch (e) { continue; }
    const rest = line.slice(sp + 2);
    try { body = rest.endsWith('|') ? JSON.parse(rest.slice(0, -1)) : JSON.parse(rest); } catch (e) { continue; }
    records.push({ head, body });
  }
  assert(records.length > 0, 'official export fixture parses');
  assert(findViolation(records) === null, 'official export passes the grammar guard',
    JSON.stringify(findViolation(records)));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
