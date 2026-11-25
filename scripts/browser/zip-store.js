'use strict';
// Dependency-free ZIP writer (STORE only) for the browser page. Project files
// are small text records; storing them uncompressed keeps this code tiny.
const { toBytes } = require('./vfs');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// files: [{ name, data: Uint8Array|string }] → Uint8Array (ZIP, STORE)
function zipStore(files) {
  const encoder = new TextEncoder();
  const items = files.map(f => ({
    name: encoder.encode(String(f.name)),
    data: toBytes(f.data == null ? '' : f.data)
  }));
  const { time, date } = dosDateTime();
  let localSize = 0, centralSize = 0;
  for (const it of items) {
    localSize += 30 + it.name.length + it.data.length;
    centralSize += 46 + it.name.length;
  }
  const out = new Uint8Array(localSize + centralSize + 22);
  const dv = new DataView(out.buffer);
  let offset = 0, localOffset = 0;
  const write16 = (v) => { dv.setUint16(offset, v, true); offset += 2; };
  const write32 = (v) => { dv.setUint32(offset, v >>> 0, true); offset += 4; };
  const writeBytes = (b) => { out.set(b, offset); offset += b.length; };

  for (const it of items) {
    const crc = crc32(it.data);
    write32(0x04034b50);
    write16(20);            // version needed
    write16(0x0800);        // UTF-8 file names
    write16(0);             // method: store
    write16(time); write16(date);
    write32(crc);
    write32(it.data.length); write32(it.data.length);
    write16(it.name.length); write16(0);
    writeBytes(it.name);
    writeBytes(it.data);
    it.crc = crc;
    it.offset = localOffset;
    localOffset = offset;
  }

  const centralStart = offset;
  for (const it of items) {
    write32(0x02014b50);
    write16(20); write16(20);   // version made by / needed
    write16(0x0800);            // flags
    write16(0);                 // method
    write16(time); write16(date);
    write32(it.crc);
    write32(it.data.length); write32(it.data.length);
    write16(it.name.length); write16(0); write16(0);
    write16(0); write16(0);
    write32(0);                 // external attrs
    write32(it.offset);
    writeBytes(it.name);
  }
  const centralEnd = offset;
  write32(0x06054b50);
  write16(0); write16(0);
  write16(items.length); write16(items.length);
  write32(centralEnd - centralStart);
  write32(centralStart);
  write16(0);
  return out;
}

module.exports = { zipStore, crc32 };
