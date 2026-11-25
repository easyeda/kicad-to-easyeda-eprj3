'use strict';
// 'path' facade for the bundled converter: POSIX while a VirtualFs is active
// (browser conversions, and the in-memory API under Node), the host's real
// path module otherwise.
const posix = require('./path');
const { getActiveFs } = require('../active-fs');
const { getNodePath } = require('../node-path');

function impl() {
  if (getActiveFs()) return posix;
  return getNodePath() || posix;
}

module.exports = {
  normalize: (...a) => impl().normalize(...a),
  join: (...a) => impl().join(...a),
  resolve: (...a) => impl().resolve(...a),
  basename: (...a) => impl().basename(...a),
  dirname: (...a) => impl().dirname(...a),
  extname: (...a) => impl().extname(...a),
  get sep() { return impl().sep; },
  get posix() { return posix; }
};
