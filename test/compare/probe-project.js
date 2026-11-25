const a = __CLI__.args || {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
await eda.dmt_Project.waitForReady(undefined, 120000);
const out = { pages: [] };
let schs = [];
for (let i = 0; i < 30; i++) {
  try { schs = (await eda.dmt_Schematic.getAllSchematicsInfo()) || []; } catch (e) { schs = []; }
  if (schs.length) break;
  await sleep(1000);
}
let allPages = [];
for (let i = 0; i < 20; i++) {
  try { allPages = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) || []; } catch (e) { allPages = []; }
  if (allPages.length) break;
  await sleep(1000);
}
out.schematics = schs.map(s => ({ name: s.name, itemType: s.itemType }));
const itemTypeOf = name => (schs.find(s => s.name === name) || {}).itemType || '';
for (const sch of schs) {
  const pages = allPages.filter(p => p.parentSchematicUuid === sch.uuid).sort((x, y) => x.zIndex - y.zIndex);
  for (const p of pages) {
    const tab = await eda.dmt_EditorControl.openDocument(p.uuid);
    await eda.dmt_EditorControl.activateDocument(tab);
    await eda.dmt_EditorControl.waitForDocumentReady(tab, 120000);
    await sleep(2000);
    let best = '', protel = '';
    for (let i = 0; i < 3; i++) {
      try { const r = await eda.sch_Netlist.getNetlist('JLCEDA'); if (r && r.length > best.length) best = r; } catch (e) { /* retry */ }
      try { const r = await eda.sch_Netlist.getNetlist('Protel2'); if (r && r.length > protel.length) protel = r; } catch (e) { /* retry */ }
      await sleep(800);
    }
    out.pages.push({ schematic: sch.name, page: p.name, itemType: itemTypeOf(sch.name), netlist: best, netlistProtel: protel });
  }
}
let pcbs = [];
for (let i = 0; i < 20; i++) {
  try { pcbs = (await eda.dmt_Pcb.getAllPcbsInfo()) || []; } catch (e) { pcbs = []; }
  if (pcbs.length) break;
  await sleep(1000);
}
if (pcbs[0]) {
  const tab = await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
  await eda.dmt_EditorControl.activateDocument(tab);
  await eda.dmt_EditorControl.waitForDocumentReady(tab, 120000);
  await sleep(2000);
  const comps = (await eda.pcb_PrimitiveComponent.getAll()) || [];
  out.pcbComps = comps.map(c => {
    try {
      return {
        designator: c.getState_Designator && c.getState_Designator(),
        x: c.getState_X && c.getState_X(),
        y: c.getState_Y && c.getState_Y(),
        rotation: c.getState_Rotation && c.getState_Rotation(),
        layer: c.getState_Layer && c.getState_Layer()
      };
    } catch (e) { return { err: String(e) }; }
  });
  // Placed pad centres/sides/nets — catches wrong pad layers and permuted pad
  // positions inside bottom-side footprints (both produce airwires).
  try {
    const pads = (await eda.pcb_PrimitivePad.getAll()) || [];
    out.pcbPads = pads.map(p => {
      try {
        return {
          x: p.getState_X(), y: p.getState_Y(), layer: p.getState_Layer(),
          net: p.getState_Net() || '', num: p.getState_PadNumber()
        };
      } catch (e) { return { err: String(e) }; }
    });
  } catch (e) { out.pcbPadsError = String(e && e.message || e); }

  // Layer/stackup state + a ratline-only render. Ratlines are drawn on layer
  // 57 with a blue-dominant color; counting those pixels gives a cheap
  // "does the board show airwires" check (KiCad reference: DRC unconnected).
  try {
    const layers = (await eda.pcb_Layer.getAllLayers()) || [];
    out.edaLayers = layers.map(l => ({ id: l.id, name: l.name, type: l.type, status: l.layerStatus }));
    try { out.stackup = await eda.pcb_Layer.getStackup(); } catch (e) { out.stackupError = String(e && e.message || e); }
    await eda.pcb_Layer.setLayerVisible(57, true);
    await sleep(900);
    await eda.dmt_EditorControl.zoomToAllPrimitives(tab);
    await sleep(1500);
    const blob = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(tab);
    if (blob) {
      let bmp;
      if (typeof createImageBitmap === 'function') {
        bmp = await createImageBitmap(blob);
      } else {
        const url = URL.createObjectURL(blob);
        try {
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
          bmp = img;
        } finally { URL.revokeObjectURL(url); }
      }
      let canvas;
      try {
        canvas = new OffscreenCanvas(bmp.width, bmp.height);
      } catch (e) {
        canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      let px = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a > 0 && b > 120 && b - Math.max(r, g) > 40) px++;
      }
      out.ratlinePixels = px;
    }
    await eda.pcb_Layer.setLayerVisible();
  } catch (e) {
    out.ratlineError = String(e && e.message || e);
  }
}
return out;
