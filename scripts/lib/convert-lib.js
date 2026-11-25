'use strict';
/**
 * convert-lib.js — KiCad library directory → EasyEDA Pro .elibz2 package.
 *
 * Extracted from convert-kicad-lib.js so the browser/standalone build can reuse
 * it. The caller supplies `log`/`warn` callbacks; this module never parses
 * process.argv.
 */

const fs = require('fs');
const path = require('path');
const { parse, nodeSymbol, extractFootprintNode } = require('./kicad');
const { buildElibz2 } = require('./elibz2');

// KiCad 7+ marks power symbols with (symbol_type "power"); they use a
// dedicated device class in EasyEDA (META docType 18).
function isPowerSymbolNode(node) {
  for (const it of node.slice(1)) {
    if (Array.isArray(it) && it[0].v === 'symbol_type' && it[1] && it[1].v === 'power') return true;
    if (Array.isArray(it) && it[0].v === 'power') return true;
  }
  return false;
}

function convertLibrary(srcArg, dstArg, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const warn = typeof opts.warn === 'function' ? opts.warn : msg => console.warn(`  warn: ${msg}`);
  const src = path.resolve(srcArg);
  const dst = path.resolve(dstArg);
  if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`);
  const name = opts.name || path.basename(dstArg).replace(/\.elibz2$/i, '') || path.basename(src);

  const symbols = [];
  for (const f of fs.readdirSync(src).filter(f => f.endsWith('.kicad_sym'))) {
    const root = parse(fs.readFileSync(path.join(src, f), 'utf8'));
    let count = 0;
    for (const node of root.slice(1)) {
      if (!Array.isArray(node) || node[0].v !== 'symbol') continue;
      const sym = nodeSymbol(node);
      if (!sym.name) continue;
      sym.power = isPowerSymbolNode(node);
      symbols.push(sym);
      count++;
    }
    log(`  sym lib: ${f} (${count} symbols)`);
  }

  const footprints = [];
  for (const d of fs.readdirSync(src).filter(d => d.endsWith('.pretty'))) {
    const files = fs.readdirSync(path.join(src, d)).filter(f => f.endsWith('.kicad_mod'));
    for (const f of files) {
      try {
        const root = parse(fs.readFileSync(path.join(src, d, f), 'utf8'));
        if (!Array.isArray(root) || root[0].v !== 'footprint') continue;
        footprints.push(extractFootprintNode(root));
      } catch (e) {
        warn(`skip ${d}/${f}: ${e.message}`);
      }
    }
    log(`  footprint lib: ${d} (${files.length} footprints)`);
  }

  if (!symbols.length && !footprints.length) {
    throw new Error(`No .kicad_sym or .pretty libraries found in ${src}`);
  }

  const zip = buildElibz2({ name, symbols, footprints });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, zip);
  log(`Wrote ${dst}: ${symbols.length} symbols, ${footprints.length} footprints (${zip.length} bytes)`);
  return { src, dst, name, symbols: symbols.length, footprints: footprints.length, bytes: zip.length };
}

module.exports = { convertLibrary };
