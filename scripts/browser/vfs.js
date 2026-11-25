'use strict';
// In-memory filesystem used by the browser page. It implements the small
// subset of Node's fs API the converter relies on.
const path = require('./node-shims/path');

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

function encode(str) {
  if (encoder) return encoder.encode(str);
  const out = new Uint8Array(str.length * 2);
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) out[n++] = c;
    else { out[n++] = 0xc0 | (c >> 6); out[n++] = 0x80 | (c & 0x3f); }
  }
  return out.slice(0, n);
}

function decode(bytes) {
  if (bytes == null) return '';
  if (typeof bytes === 'string') return bytes;
  if (decoder) return decoder.decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return decodeURIComponent(escape(s));
}

function toBytes(data) {
  if (typeof data === 'string') return encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encode(String(data));
}

class VirtualFs {
  constructor() {
    this.files = new Map();   // abs path -> Uint8Array
    this.dirs = new Set(['/']);
  }

  _abs(p) { return path.resolve(String(p)); }

  _addDir(p) {
    p = this._abs(p);
    while (p && p !== '/' && !this.dirs.has(p)) {
      this.dirs.add(p);
      p = path.dirname(p);
    }
    this.dirs.add('/');
  }

  // Seed files from the page. `files` entries are { path (relative to the
  // selected folder), data }. They are mounted under '/<rootName>/'.
  seed(rootName, files) {
    const root = '/' + String(rootName || 'project').replace(/^\/+|\/+$/g, '');
    this._addDir(root);
    for (const f of files || []) {
      const rel = String(f.path || f.name || '').replace(/^\/+/, '');
      if (!rel) continue;
      this.writeFileSync(root + '/' + rel, f.data != null ? f.data : '');
    }
    return root;
  }

  existsSync(p) {
    p = this._abs(p);
    return this.files.has(p) || this.dirs.has(p);
  }

  readFileSync(p, enc) {
    p = this._abs(p);
    const data = this.files.get(p);
    if (data === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
      err.code = 'ENOENT';
      throw err;
    }
    const e = String(enc || '').toLowerCase();
    if (e === 'utf8' || e === 'utf-8' || e === '') return decode(data);
    if (e === 'binary' || e === 'latin1') return decode(data);
    return data;
  }

  writeFileSync(p, data) {
    p = this._abs(p);
    this._addDir(path.dirname(p));
    this.files.set(p, toBytes(data));
  }

  mkdirSync(p) {
    this._addDir(p);
  }

  unlinkSync(p) {
    p = this._abs(p);
    if (!this.files.delete(p)) {
      const err = new Error(`ENOENT: no such file or directory, unlink '${p}'`);
      err.code = 'ENOENT';
      throw err;
    }
  }

  readdirSync(p, opts) {
    p = this._abs(p);
    if (!this.dirs.has(p)) {
      const err = new Error(`ENOENT: no such file or directory, scandir '${p}'`);
      err.code = 'ENOENT';
      throw err;
    }
    const prefix = p === '/' ? '/' : p + '/';
    const names = new Map(); // name -> isDirectory
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      names.set(rest, false);
    }
    for (const d of this.dirs) {
      if (d === p || !d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      names.set(rest, true);
    }
    const list = [...names.keys()].sort();
    if (opts && opts.withFileTypes) {
      return list.map(name => ({
        name,
        isDirectory: () => names.get(name),
        isFile: () => !names.get(name)
      }));
    }
    return list;
  }

  statSync(p) {
    p = this._abs(p);
    if (this.dirs.has(p)) return { isDirectory: () => true, isFile: () => false, size: 0 };
    const data = this.files.get(p);
    if (data === undefined) {
      const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
      err.code = 'ENOENT';
      throw err;
    }
    return { isDirectory: () => false, isFile: () => true, size: data.length };
  }

  // Files written under `root` as [{ path (relative), data (Uint8Array) }].
  collect(root) {
    root = this._abs(root);
    const prefix = root === '/' ? '/' : root + '/';
    const out = [];
    for (const [p, data] of this.files) {
      if (!p.startsWith(prefix)) continue;
      out.push({ path: p.slice(prefix.length), data });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }
}

module.exports = { VirtualFs, toBytes, encode, decode };
