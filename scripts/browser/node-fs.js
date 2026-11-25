'use strict';
// Node's real fs, injected by the bundle host. The 'fs' shim prefers an active
// VirtualFs (browser conversion) and falls back to this delegate in Node.
let nodeFs = null;

function setNodeFs(fs) { nodeFs = fs; }
function getNodeFs() { return nodeFs; }

module.exports = { setNodeFs, getNodeFs };
