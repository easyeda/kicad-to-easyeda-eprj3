'use strict';
// Browser 'zlib' shim. Library-package (.elibz2) conversion needs deflate and
// is not enabled in the browser page; project conversion never calls zlib.
function unavailable() { throw new Error('zlib is not available in the browser build'); }
module.exports = {
  deflateRawSync: unavailable,
  inflateRawSync: unavailable,
  deflateSync: unavailable,
  inflateSync: unavailable
};
