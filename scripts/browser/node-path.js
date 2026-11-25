'use strict';
// Node's real path module, injected by the bundle host. The builtin 'path'
// facade prefers POSIX behaviour while a VirtualFs is active.
let nodePath = null;

function setNodePath(p) { nodePath = p; }
function getNodePath() { return nodePath; }

module.exports = { setNodePath, getNodePath };
