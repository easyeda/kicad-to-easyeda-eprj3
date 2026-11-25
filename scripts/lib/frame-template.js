'use strict';
// A4 drawing-sheet (docType 20 "Drawing-Symbol_A4") template. The JSON is
// extracted from a real EasyEDA export; each page gets its own document copy
// because the project scanner indexes documents by uuid across .esch2 files.
const { uuid } = require('./eprj3');
const FRAME_TEMPLATE = require('./frame-a4.json');

function instantiateFrameTemplate() {
  const oldSymbol = FRAME_TEMPLATE.symbol.find(r => r.type === 'DOCHEAD').body.uuid;
  const oldDevice = FRAME_TEMPLATE.device.find(r => r.type === 'DOCHEAD').body.uuid;
  const symbolUuid = uuid(16);
  const deviceUuid = uuid(16);
  const remap = r => JSON.parse(JSON.stringify(r)
    .split(oldSymbol).join(symbolUuid).split(oldDevice).join(deviceUuid));
  return {
    symbol: FRAME_TEMPLATE.symbol.map(remap),
    device: FRAME_TEMPLATE.device.map(remap),
    pageAttrs: FRAME_TEMPLATE.pageAttrs.map(remap),
    symbolUuid, deviceUuid
  };
}

module.exports = { instantiateFrameTemplate };
