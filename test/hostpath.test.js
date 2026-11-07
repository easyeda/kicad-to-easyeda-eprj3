'use strict';
// hostpath.test.js — 宿主路径语法安全层单测（零子进程，纯断言）。
// 覆盖：合法形态放行、无 token/ARC 裸收尾对拒绝（P0 实锤的两类事故签名）、
// R 描述符/嵌套 CIRCLE 放行、findViolation 反向注入（喂坏路径必须被抓）。
const { simBuild8, validatePath, findViolation } = require('../scripts/lib/hostpath');

let checks = 0, failures = 0;
function assert(cond, name) {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}`); }
}

assert(simBuild8([0, 0, 'L', 10, 0, 'L', 10, 10, 'L', 0, 0]) === null, 'L-chained polygon is valid');
assert(simBuild8([0, 0, 'ARC', 90, 10, 10]) === null, 'ARC block (sweep-first) is valid');
assert(simBuild8([0, 0, 'C', 1, 1, 2, 2, 3, 3]) === null, 'C block (6 numbers) is valid');
assert(simBuild8([0, 0, 10, 0]) !== null, 'tokenless path is rejected');
assert(simBuild8([0, 0, 'ARC', 90, 10, 10, 0, 0]) !== null, 'bare close-back pair after ARC is rejected');
assert(simBuild8([0, 0, 'X', 1, 2]) !== null, 'unknown token is rejected');
assert(validatePath(['R', 0, 100, 100, 100, 0, 0]) === null, 'R descriptor accepted');
assert(validatePath([['CIRCLE', 5, 5, 10, 1]]) === null, 'nested CIRCLE subpath accepted');
assert(findViolation([{ type: 'POLY', head: { id: 't' }, body: { path: [0, 0, 10, 10] } }]) !== null,
  'findViolation catches a tokenless POLY (reverse-injection check)');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
