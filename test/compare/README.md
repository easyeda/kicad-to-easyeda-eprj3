# Conversion comparison harness

Compares converted `.eprj3` projects against the original KiCad projects.
Requires the KiCad 10 CLI (`kicad-cli`) and the EasyEDA Pro desktop CLI
(`lceda-pro`); both paths are defined at the top of `run-all.js`.

```bash
# 1. Re-convert every demo project (wipes D:/Documents/KiCAD/demos/eprj3)
node test/compare/convert-demos.js

# 2. Compare (optionally pass project names to check a subset)
node test/compare/run-all.js
node test/compare/run-all.js carte_test video
```

Reports and the summary are written to `tmp/compare/out/`.

## Checks

- **Netlist / BOM / PCB coordinates** — hierarchy-expanded netlist partitions,
  BOM values and footprint positions/rotations, with CBB instance refs
  translated to the `REF$CBBn` form.
- **PCB primitive counts** — tracks (segments + arcs), vias, placed pads,
  footprints, copper zones (+ keepouts) and the used net-name set.
- **Placed pads** — every KiCad pad is matched to an EDA pad by position and
  compared for pad number, net and copper side. Catches pads mirrored onto the
  wrong side or permuted inside a bottom-side footprint, which otherwise only
  surface as airwires.
- **Layer count** — copper layers enabled in the EDA layer table vs KiCad's
  `(layers …)` stack.
- **Stackup** — `LAYER_PHYS` copper coverage and the board thickness reported
  by `pcb_Layer.getStackup()` vs the KiCad `(general (thickness …))`.
- **Design rules** — default track width / via diameter / drill from the KiCad
  project net class, and the fabrication minimum track/via/hole sizes.
- **Ratlines** — renders only the EDA ratline layer and counts blue pixels;
  flags airwires when KiCad DRC reports zero unconnected items (and the
  reverse when KiCad has unconnected items but EDA shows none).
