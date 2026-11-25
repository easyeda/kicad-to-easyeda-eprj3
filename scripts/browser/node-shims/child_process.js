'use strict';
// Browser 'child_process' shim — the CLI helpers are never used by the page.
function unavailable() { throw new Error('child_process is not available in the browser build'); }
module.exports = { execFileSync: unavailable, spawn: unavailable };
