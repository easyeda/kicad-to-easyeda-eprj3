'use strict';
/**
 * hostpath.js — EasyEDA Pro path-grammar guard.
 *
 * Client path parser semantics (build8), reverse-engineered from V4.1.x:
 *   [x0, y0] start; 'L',x,y; 'ARC',sweep,endX,endY; 'CARC',sweep,endX,endY;
 *   'C',c1x,c1y,c2x,c2y,x,y. A bare number reuses the previous token; a bare
 *   number before any token throws "invalid rawData".
 *
 * Outline decoders (POLY/POUR/REGION/FILL and POURED.pourFill) accept only
 * L / ARC / CARC; a 'C' block throws and the record is silently dropped.
 * These records also accept the nested forms [['R',...]] (rect descriptor,
 * 7 elements) and [['CIRCLE',cx,cy,r] or [...,1]] sub-paths.
 *
 * findViolation() checks every path-bearing record before it is written so the
 * converter fails loudly instead of shipping a file the client chokes on.
 */

const OUTLINE_TYPES = new Set(['POLY', 'POUR', 'REGION', 'FILL']);

// Simulate build8. Returns null when valid, otherwise a reason string.
function simBuild8(e, opts = {}) {
  if (!Array.isArray(e) || e.length < 4) return 'path too short';
  if (typeof e[0] !== 'number' || typeof e[1] !== 'number') return 'first point not numeric';
  let o = 2, i;
  for (; o < e.length;) {
    if (typeof e[o] === 'string') i = e[o];
    else {
      if (i === undefined) return 'bare number before any token at #' + o;
      o -= 1;
    }
    if (i === 'L') {
      const s = e.slice(o + 1, o + 3);
      if (s.length !== 2 || !s.every(v => typeof v === 'number')) return 'bad L block at #' + o;
      o += 3;
    } else if (i === 'ARC' || i === 'CARC') {
      const s = e.slice(o + 1, o + 4);
      if (s.length !== 3 || !s.every(v => typeof v === 'number')) return 'bad ' + i + ' block at #' + o;
      o += 4;
    } else if (i === 'C') {
      if (opts.outline) return 'C block is not supported by the outline decoder at #' + o;
      const s = e.slice(o + 1, o + 7);
      if (s.length !== 6 || !s.every(v => typeof v === 'number')) return 'bad C block at #' + o;
      o += 7;
    } else {
      return 'unknown token ' + JSON.stringify(i);
    }
  }
  return null;
}

// Validate one path. Accepts the three proven shapes: R descriptor, nested
// R/CIRCLE sub-paths, and the flat build8 instruction stream.
function validatePath(path, opts = {}) {
  if (!Array.isArray(path) || !path.length) return 'path is empty';
  if (path[0] === 'R') {
    if (path.length !== 7) return 'R descriptor needs 7 elements, got ' + path.length;
    if (!path.slice(1).every(v => typeof v === 'number')) return 'R descriptor has non-numeric fields';
    return null;
  }
  if (Array.isArray(path[0])) {
    for (const sub of path) {
      if (!Array.isArray(sub)) return 'nested path element not an array';
      let r;
      if (sub[0] === 'R') {
        r = sub.length === 7 ? null : 'R descriptor needs 7 elements, got ' + sub.length;
      } else if (sub[0] === 'CIRCLE') {
        // Official exports use 4 elements; this converter writes 5 (trailing 1).
        r = (sub.length === 4 || sub.length === 5) ? null : 'CIRCLE subpath needs 4 or 5 elements, got ' + sub.length;
      } else {
        r = simBuild8(sub, opts);
      }
      if (r) return r;
    }
    return null;
  }
  return simBuild8(path, opts);
}

// Walk the records and return the first violation as { type, id, reason },
// or null when every path is valid.
function findViolation(records) {
  for (const r of records) {
    const type = (r.head && r.head.type) || r.type;
    const id = JSON.stringify(r.head && r.head.id);
    if (OUTLINE_TYPES.has(type)) {
      const p = r.body && r.body.path;
      if (Array.isArray(p)) {
        const reason = validatePath(p, { outline: true });
        if (reason) return { type, id, reason };
      }
    } else if (type === 'POURED') {
      const pf = r.body && r.body.pourFill;
      if (!Array.isArray(pf)) continue;
      for (const item of pf) {
        if (!item || !Array.isArray(item.path)) continue;
        const subs = Array.isArray(item.path[0]) ? item.path : [item.path];
        for (const sub of subs) {
          const reason = validatePath(sub, { outline: true });
          if (reason) return { type, id, reason };
        }
      }
    }
  }
  return null;
}

module.exports = { simBuild8, validatePath, findViolation };
