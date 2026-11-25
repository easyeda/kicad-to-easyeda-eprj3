'use strict';
// Shared constants and tiny helpers for the KiCad→eprj3 converters. Keeping
// these here lets schematic-convert.js / pcb-convert.js / convert-kicad.js
// stay focused on their own transformation logic.
const { uuid } = require('./eprj3');
const { kicadToEprj3, kicadToSchUnit } = require('./kicad-to-eprj3');

// PCB positions are mil; schematic positions are 0.254 mm units.
function toMil(x) { return kicadToEprj3(parseFloat(x)); }
function toSch(x) { return kicadToSchUnit(parseFloat(x)); }
function r2(v) { return Math.round(v * 100) / 100; }

// eprj3 page height in sch units per KiCad paper size. A4 (1170×825) is
// verified against official exports; the rest follow the same √2 A-series
// proportions the EasyEDA template uses.
const PAGE_HEIGHT_UNITS = { A4: 825, A3: 1167, A2: 1651, A1: 2334, A0: 3301, A: 550, B: 848, C: 1100, D: 1550, E: 2200 };
// KiCad paper sizes in mm (page_info.cpp / standardPageSizes)
const PAPER_SIZE_MM = {
  A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6]
};

// Built-in power flags, net ports and sheet frame share this part id.
const MAGIC_PART_ID = 'pid8a0e77bacb214e';

function docHead(docType, docUuid) {
  return {
    head: { type: 'DOCHEAD' },
    body: {
      docType, client: uuid(16), uuid: docUuid,
      updateTime: Date.now(), version: String(Date.now()), editVersion: '4.1.36', user: {}
    }
  };
}

function metaRec(title, extra = {}) {
  return { head: { type: 'META', ticket: 1, id: 'META' }, body: { title, description: '', tags: [], source: '', ...extra } };
}

// Component "Unique ID" fallback, shared by schematic and PCB documents so the
// sequence matches the single-counter behavior of the old monolith.
let ggeCounter = 0;
function nextGge() { return ++ggeCounter; }

let warnCounter = 0;
function warn(msg) {
  if (++warnCounter <= 30) console.warn(`  warn: ${msg}`);
}
function getWarnCount() { return warnCounter; }

module.exports = {
  toMil, toSch, r2, PAGE_HEIGHT_UNITS, PAPER_SIZE_MM, MAGIC_PART_ID,
  docHead, metaRec, nextGge, warn, getWarnCount
};
