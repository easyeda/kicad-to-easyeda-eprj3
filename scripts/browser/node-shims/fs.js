'use strict';
// 'fs' facade used by the bundled converter in every environment:
//   - browser conversion: the page installs a VirtualFs for the duration of a
//     conversion;
//   - Node (CLI/API): delegates to the real fs injected by the bundle host.
const { getActiveFs } = require('../active-fs');
const { getNodeFs } = require('../node-fs');

function impl() {
  const fs = getActiveFs() || getNodeFs();
  if (!fs) throw new Error('No filesystem available');
  return fs;
}

module.exports = {
  existsSync: (...a) => impl().existsSync(...a),
  readFileSync: (...a) => impl().readFileSync(...a),
  writeFileSync: (...a) => impl().writeFileSync(...a),
  mkdirSync: (...a) => impl().mkdirSync(...a),
  unlinkSync: (...a) => impl().unlinkSync(...a),
  readdirSync: (...a) => impl().readdirSync(...a),
  statSync: (...a) => impl().statSync(...a)
};
