'use strict';
// Browser 'crypto' shim — only randomBytes(n).toString('hex') is used.
function randomBytes(n) {
  const size = Number(n) || 0;
  const buf = new Uint8Array(size);
  const webCrypto = typeof crypto !== 'undefined' ? crypto : null;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < size; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return {
    length: size,
    toString(enc) {
      if (enc === 'hex') {
        let s = '';
        for (const b of buf) s += b.toString(16).padStart(2, '0');
        return s;
      }
      return String(buf);
    },
    [Symbol.iterator]: function* () { yield* buf; }
  };
}

module.exports = { randomBytes };
