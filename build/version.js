#!/usr/bin/env node
'use strict';
/**
 * version.js — Bump the package version and keep every version file in sync.
 *
 *   node build/version.js patch|minor|major|none
 *
 * The last digit (patch) changes on every update; the build workflow calls
 * this with `patch` by default. Prints the resulting version.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major', 'none'].includes(mode)) {
  console.error(`Usage: node build/version.js patch|minor|major|none`);
  process.exit(1);
}

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version || '');
if (!m) {
  console.error(`Unsupported version format: ${pkg.version}`);
  process.exit(1);
}
let [major, minor, patch] = m.slice(1).map(Number);
if (mode === 'major') { major++; minor = 0; patch = 0; }
else if (mode === 'minor') { minor++; patch = 0; }
else if (mode === 'patch') patch++;

const version = `${major}.${minor}.${patch}`;
if (mode !== 'none' && version !== pkg.version) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // Keep package-lock.json in sync when present (npm's own convention).
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.version = version;
    if (lock.packages && lock.packages['']) lock.packages[''].version = version;
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  }
}

console.log(version);
