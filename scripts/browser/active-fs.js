'use strict';
// The browser build swaps the active filesystem for the duration of one
// conversion; the 'fs' shim delegates to it. Node builds never use this module
// (the bundle passes the real fs to the modules instead).
let active = null;

function setActiveFs(fs) { active = fs; }
function getActiveFs() { return active; }

module.exports = { setActiveFs, getActiveFs };
