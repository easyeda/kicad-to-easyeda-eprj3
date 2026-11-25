// Runnable body for `lceda-pro invoke`: capture EDA PCB layer screenshots and
// every schematic page screenshot, returning base64 PNGs.
const a = __CLI__.args || {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toB64 = img => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = reject;
  r.readAsDataURL(img);
});
await eda.dmt_Project.waitForReady(undefined, 120000);

const out = { pcb: {}, pcbLayers: [], sch: [] };

// ---- PCB per-layer ----
let pcbs = [];
for (let i = 0; i < 30 && !pcbs.length; i++) {
  try { pcbs = (await eda.dmt_Pcb.getAllPcbsInfo()) || []; } catch (e) { pcbs = []; }
  if (!pcbs.length) await sleep(1000);
}
if (pcbs[0]) {
  try {
    const tab = await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
    await eda.dmt_EditorControl.activateDocument(tab);
    await eda.dmt_EditorControl.waitForDocumentReady(tab, 120000);
    await sleep(2500);
    const layers = (await eda.pcb_Layer.getAllLayers()) || [];
    out.pcbLayers = layers.map(l => ({ id: l.id, name: l.name }));
    const wanted = (a.layers || [1, 2, 3, 4, 11]).filter(id => layers.some(l => l.id === id));
    for (const id of wanted) {
      try {
        await eda.pcb_Layer.setLayerVisible(id, true);
        await sleep(700);
        await eda.dmt_EditorControl.zoomToAllPrimitives(tab);
        await sleep(700);
        out.pcb[id] = await toB64(await eda.dmt_EditorControl.getCurrentRenderedAreaImage(tab));
      } catch (e) {
        out.pcb[id] = 'ERR:' + String(e && e.message || e);
      }
    }
    try { await eda.pcb_Layer.setLayerVisible(); } catch (e) { /* ignore */ }
  } catch (e) {
    out.pcbError = String(e && e.message || e);
  }
}

// ---- schematic pages ----
try {
  let schs = [];
  for (let i = 0; i < 30 && !schs.length; i++) {
    try { schs = (await eda.dmt_Schematic.getAllSchematicsInfo()) || []; } catch (e) { schs = []; }
    if (!schs.length) await sleep(1000);
  }
  const allPages = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [];
  for (const sch of schs) {
    const pages = allPages.filter(p => p.parentSchematicUuid === sch.uuid);
    for (const p of pages) {
      try {
        const tab = await eda.dmt_EditorControl.openDocument(p.uuid);
        await eda.dmt_EditorControl.activateDocument(tab);
        await eda.dmt_EditorControl.waitForDocumentReady(tab, 120000);
        await sleep(2000);
        const r = a.regions && a.regions[p.name];
        if (r) await eda.dmt_EditorControl.zoomToRegion(r[0], r[1], r[2], r[3], tab);
        else await eda.dmt_EditorControl.zoomToAllPrimitives(tab);
        await sleep(1000);
        const b64 = await toB64(await eda.dmt_EditorControl.getCurrentRenderedAreaImage(tab));
        out.sch.push({ title: p.name, b64 });
      } catch (e) {
        out.sch.push({ title: p.name, error: String(e && e.message || e) });
      }
    }
  }
} catch (e) {
  out.schError = String(e && e.message || e);
}

return out;
