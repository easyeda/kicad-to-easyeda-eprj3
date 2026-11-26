#!/usr/bin/env node
'use strict';
/**
 * check-licenses.js — Enforce the project's dependency policy:
 * third-party software libraries must be MIT or Apache-2.0, and the project
 * itself stays dependency-free whenever possible.
 *
 *   node build/check-licenses.js
 *
 * Reads every declared dependency (including nested node_modules) and exits
 * non-zero when a package is missing or uses another license.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ALLOWED = new Set(['MIT', 'Apache-2.0']);

const deps = {
  ...(pkg.dependencies || {}),
  ...(pkg.devDependencies || {}),
  ...(pkg.optionalDependencies || {}),
  ...(pkg.peerDependencies || {})
};

const problems = [];
const seen = new Set();

function licenseOf(meta) {
  let license = meta.license;
  if (license && typeof license === 'object') license = license.type;
  if (!license && Array.isArray(meta.licenses)) {
    license = meta.licenses.map(l => (typeof l === 'string' ? l : l && l.type)).filter(Boolean).join(' OR ');
  }
  return typeof license === 'string' ? license.trim() : '';
}

function allowed(license) {
  if (!license) return false;
  // Accept "MIT", "Apache-2.0" and OR-combinations of only those two.
  return license.split(/\s+OR\s+/i).every(part => ALLOWED.has(part.replace(/^\(|\)$/g, '').trim()));
}

function checkPackage(dir, name) {
  const id = path.resolve(dir);
  if (seen.has(id)) return;
  seen.add(id);
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) {
    problems.push(`${name}: package.json not installed (run npm install or remove the dependency)`);
    return;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch (e) {
    problems.push(`${name}: unreadable package.json (${e.message})`);
    return;
  }
  const license = licenseOf(meta);
  if (!allowed(license)) problems.push(`${name}: ${license || 'UNKNOWN LICENSE'}`);

  const nested = path.join(dir, 'node_modules');
  if (!fs.existsSync(nested)) return;
  for (const entry of fs.readdirSync(nested)) {
    if (entry.startsWith('.')) continue;
    const sub = path.join(nested, entry);
    if (!fs.statSync(sub).isDirectory()) continue;
    if (entry.startsWith('@')) {
      for (const scoped of fs.readdirSync(sub)) checkPackage(path.join(sub, scoped), `${entry}/${scoped}`);
    } else {
      checkPackage(sub, entry);
    }
  }
}

for (const name of Object.keys(deps)) checkPackage(path.join(ROOT, 'node_modules', name), name);

if (problems.length) {
  console.error('License check failed — third-party libraries must be MIT or Apache-2.0:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
if (!Object.keys(deps).length) {
  console.log('license check: no third-party packages (dependency-free), OK');
} else {
  console.log(`license check: ${Object.keys(deps).length} third-party package(s), all MIT/Apache-2.0`);
}
