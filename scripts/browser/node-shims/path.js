'use strict';
// POSIX path helpers for the browser build. The virtual filesystem uses
// forward slashes with a leading '/', so only the POSIX subset is needed.
function normalize(p) {
  p = String(p == null ? '' : p);
  const abs = p.charAt(0) === '/';
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(seg);
  }
  const s = out.join('/');
  return abs ? '/' + s : (s || '.');
}

function join(...parts) {
  return normalize(parts.filter(p => p != null && p !== '').join('/'));
}

function resolve(...parts) {
  let p = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const a = parts[i];
    if (a == null || a === '') continue;
    p = a + '/' + p;
    if (String(a).charAt(0) === '/') break;
  }
  if (p.charAt(0) !== '/') p = '/' + p;
  return normalize(p);
}

function basename(p, ext) {
  const s = String(p == null ? '' : p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  let b = i >= 0 ? s.slice(i + 1) : s;
  if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
  return b;
}

function dirname(p) {
  const s = String(p == null ? '' : p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  return s.slice(0, i);
}

function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}

module.exports = { normalize, join, resolve, basename, dirname, extname, sep: '/', posix: null };
module.exports.posix = module.exports;
