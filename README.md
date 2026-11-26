English | [中文](README.zh-CN.md)

# kicad-to-easyeda-eprj3

Convert KiCAD project files to the eprj3 project format of EasyEDA Pro, and KiCad libraries to the EasyEDA Pro library format `.elibz2`.

## Features

- **Project conversion**: Batch-traverses all `.kicad_sch` / `.kicad_pcb` files under a directory and generates a complete eprj3 folder project (`<name>.eprj3` index + `sch/` + `pcb/`)
- **Library conversion**: Packs all KiCad libraries under a directory (`*.kicad_sym` symbol libs + `*.pretty/*.kicad_mod` footprint libs) into a single EasyEDA Pro library file `.elibz2`
- **No-install browser version**: `kicad-to-eprj3.html` converts projects entirely in the browser (no Node.js, no upload)
- **Standalone JS**: one file usable both as a Node.js CLI and as a browser script, built by `npm run build`

## Requirements

- Node.js ≥ 18. There are **no npm dependencies** (runtime or development); the browser page needs none either.

## Browser version (no installation)

Download `kicad-to-eprj3-<version>.zip` from the GitHub **Releases** page and unzip it. Open `kicad-to-eprj3.html` in a recent Chrome/Edge:

1. Add one or more KiCad project folders. Clicking a folder scans it and lists the projects inside, so several can be ticked at once; multiple folders can also be dropped together, and the picker can be used repeatedly.
2. Click **Convert** — everything is processed locally; nothing is uploaded.
3. Download the `.eprj3.zip`, unzip it, then open `<project>/<project>.eprj3` in EasyEDA Pro.

Choosing a folder uses the browser's File System Access API, so no “upload files” confirmation appears (Chrome/Edge).

The zip also contains the standalone JS, this guide (bilingual) and the license.

### Online (GitHub Pages)

The page is also published as a single-page site: **https://easyeda.github.io/kicad-to-easyeda-eprj3/**

`.github/workflows/pages.yml` builds `dist/kicad-to-eprj3.html` and deploys it as the Pages `index.html` on every push to `main` (or manually via *Actions → Deploy browser page to GitHub Pages → Run workflow*). In a fork, enable **Settings → Pages → Build and deployment → Source: GitHub Actions** once; the workflow can also try to enable it on the first run.

## Usage

### 1) KiCad project → eprj3 project (batch)

```bash
node scripts/convert-kicad.js convert <KiCad project directory> <output directory> [--project-name <name>]
```

Example — convert the sample project shipped with this repository:

```bash
node scripts/convert-kicad.js convert example/kicad/kicad-project ./eprj3 --project-name kicad-project
```

Output:

```text
Created eprj3 project at D:/…/eprj3
  sch: kicad-project.kicad_sch -> D:/…/eprj3/sch/Schematic1/P1.esch2
  pcb: kicad-project.kicad_pcb -> D:/…/eprj3/pcb/PCB1.epcb2
```

The generated project (`<output directory>/kicad-project.eprj3`, containing `sch/` and `pcb/`) can be opened directly in EasyEDA Pro.

- The two directories are passed positionally: 1st is the KiCad project directory, 2nd is the eprj3 output directory
- Each `*.kicad_sch` under the source directory generates one schematic (`Schematic1`, `Schematic2`, …), and each `*.kicad_pcb` generates one board (`PCB1`, `PCB2`, …)

### 2) KiCad library directory → EasyEDA Pro library package (.elibz2)

```bash
node scripts/convert-kicad-lib.js convert <KiCad library directory> <output.elibz2> [--name <LibName>]
```

Example — put symbol and footprint libraries into one directory and pack them together (the scan is non-recursive; `.kicad_sym` files and `.pretty/` directories must be direct children):

```text
mylibs/
├── Device.kicad_sym
├── LED.kicad_sym
├── Resistor_SMD.pretty/
│   ├── R_0805_2012Metric.kicad_mod
│   └── …
└── LED_SMD.pretty/
    └── …
```

```bash
node scripts/convert-kicad-lib.js convert mylibs ./DeviceLED.elibz2 --name DeviceLED
```

Output:

```text
  sym lib: Device.kicad_sym (533 symbols)
  sym lib: LED.kicad_sym (63 symbols)
  footprint lib: LED_SMD.pretty (100 footprints)
  footprint lib: Resistor_SMD.pretty (67 footprints)
Wrote DeviceLED.elibz2: 596 symbols, 167 footprints (636245 bytes)
```

The resulting `DeviceLED.elibz2` can be installed into your local libraries through EasyEDA Pro's library import.

- Scans the directory for all `*.kicad_sym` (symbol libraries) and `*.pretty/` (footprint libraries, reading their `*.kicad_mod` files) and merges everything into **one** `.elibz2`
- `--name` (optional): overrides the package name (defaults to the output file name minus the `.elibz2` suffix)
- A `.elibz2` is a zip archive containing:
  - `device2.json` — device/symbol/footprint index (uuid → metadata); symbols carry `docType:2`, footprints `docType:4`, and every symbol gets an auto-generated device entry
  - `<LibName>.elibu` — a record stream (same format as `.esch2`/`.epcb2`); each symbol/footprint is written as two segments: `DOCHEAD+META` and `DOCHEAD+records`
- When a symbol's `Footprint` property (e.g. `Resistor_SMD:R_0805`) matches a converted footprint name, the device's `Footprint` attribute is automatically linked to that footprint's uuid
- Power symbols (`symbol_type "power"`) get META `docType:18`; footprint docs include the 19-layer table + `ACTIVE_LAYER` + a full `CANVAS` and carry no `PART` record
- Example: `example/easyeda/easyeda-pro-libs.elibz2` is a reference library package exported from EasyEDA Pro

### 3) Standalone bundle (Node CLI + browser page)

Build the distributable artifacts with:

```bash
npm run build
```

This writes to `dist/`:

| File | Purpose |
| --- | --- |
| `kicad-to-eprj3-<version>.js` | Single-file UMD bundle: Node CLI **and** browser API |
| `kicad-to-eprj3.html` | Self-contained conversion page (bundle inlined) |
| `README.md` | Bilingual end-user guide shipped in the zip |
| `kicad-to-eprj3-<version>.zip` | The three files above + `LICENSE` |

The standalone JS works exactly like the multi-file CLI:

```bash
node dist/kicad-to-eprj3-<version>.js convert <KiCad project directory> <output directory>
node dist/kicad-to-eprj3-<version>.js convert-lib <KiCad library directory> <output.elibz2>
```

In a browser it exposes `window.KicadToEpj3` (`convertProjectFiles`, `zipProject`, `zipStore`, …).

**Versioning / release**: the build workflow (`.github/workflows/build-release.yml`, manual `workflow_dispatch`) bumps the version (default: **patch / last digit**), runs the tests, builds the artifacts, commits the bump to `main`, tags `v<version>` and attaches the zip to the GitHub release. Every update must bump the last digit (`node build/version.js patch`, or `npm run version:bump`). The workflow needs permission to push to `main` (allow GitHub Actions in the branch protection rules if the push is rejected).

## Conversion Coverage (best-effort)

Output strictly follows the official format documentation from [easyeda-format-skill](https://github.com/easyeda/easyeda-format-skill) (types / field definitions / JSON Schemas), calibrated against real exported data where the schemas diverge from actual app output; see also the [official eprj3 format example project](https://github.com/easyeda/easyeda-eprj3-format):

| KiCad | eprj3 |
| --- | --- |
| `lib_symbols` (schematic-embedded symbol libs) | Embedded `SYMBOL` doc segments (`PART`/graphics/pins) + `DEVICE` doc segments in `.esch2` |
| `symbol` instances (with `property`, `mirror`) | `COMPONENT` (`partId` → embedded `PART`, `DeviceName` → `DEVICE`, mirror/rotation converted) + `Designator`/`Value` `ATTR` |
| `wire` | `WIRE` + multiple `LINE` records sharing a `lineGroup` |
| `bus` / `bus_entry` | `BUS` + `LINE` / `BUSENTRY` |
| `junction` | Wire split/grouping point only (same `lineGroup`); no dot is drawn |
| `no_connect` | Two `LINE` records (X marker) |
| `label` / `global_label` / `hierarchical_label` | `NET` attr on the wire group / net flag / net port |
| `text` / `text_box` | `TEXT` (+ `RECT` border) |
| `polyline` / `rectangle` / `circle` / `arc` / `bezier` | `POLY` / `RECT` / `CIRCLE` / `ARC` (center from three points) / `BEZIER`, with stroke/fill styles mapped |
| `image` | `OBJ` (base64-embedded) |
| `sheet` (hierarchy) | Reuse block symbol (`SYMBOL` docType 17) + `COMPONENT`, linked to its own child schematic (CBB instances) |
| `power` symbol / `PWR_FLAG` | Net flag (docType 18) / non-electrical symbol (docType 21, no `PIN`, keeps the KiCad glyph) |
| Pin electrical/graphic types | Numeric `PIN.electric` / `PIN.pinShape` mapping |
| `footprint` (with `pad`) | Embedded `FOOTPRINT` doc segments (`PART`/`PAD`/silkscreen graphics) + `DEVICE` doc segments + `COMPONENT` placements + `Designator`/`Footprint`/`Device` `ATTR` in `.epcb2` |
| pad nets / oval drills | `PAD_NET` (component-pad binding) + `NET` index records / `holeType ROUND` width×height |
| `segment` / `arc` (PCB traces) | `FILL` on the corresponding layer (straight tracks as closed thin polygons; track arcs as closed polygons with `ARC` segments) |
| `via` | `VIA` (net, hole and pad diameters) |
| `zone` | `POUR` (`pourType`/`keepIsland`) + one `POURED` per zone/layer (`pourFill`, head id linked to the `POUR`); keepouts → `REGION` (`regionType PROHIBIT` + `prohibitType`) |
| `dimension` (aligned/orthogonal/radial/leader) | `DIMENSION` (`dimensionType LENGTH-CONSTRAINT` + `controlDot`) |
| `gr_line` / `gr_arc` / `gr_rect` / `gr_poly` / `gr_circle` / `bezier` | `LINE` / `ARC` / closed `POLY` (circles as `["CIRCLE",…]` paths, beziers as `"C"`-segment paths) |
| `gr_text` | `STRING` (alignment origin, mirroring, knockout→reverse) |
| `gr_rect`/`gr_line`/`gr_arc`/`gr_poly` on `Edge.Cuts` | Stitched into `POLY` `BOARD_OUTLINE` (`layerId=11`) |
| Layer mapping | `F.Cu=1`, `B.Cu=2`, `F.SilkS=3`, `B.SilkS=4`, `F.Mask=5`, `Edge.Cuts=11`, `In{n}.Cu=14+n`…; the PCB doc carries the official 60-layer table and enables the inner layers the KiCad stack actually uses (`use/show`), so their tracks and pours are not dropped |

- Unit conversion: KiCad mm → eprj3 mil (×39.3700787); axis flip: KiCad Y-down → eprj3 Y-up; rotation (360−deg)%360
- FOOTPRINT documents for bottom-side components are stored top-canonical (F/B copper/silk layers swapped, footprint-local Y mirrored); the client mirrors the document when placing the COMPONENT, so pads land on the correct side and asymmetric pad coordinates are not permuted
- uuid linkage (official convention): the `DOCHEAD.uuid` of the `.esch2` page / `.epcb2` / `.ecfg` equals the `sheets` / `pcbs` / `schematics` uuid in the index respectively
- Also generates `sch/<name>/<name>.ecfg` (design-rules skeleton) and `.evar` (assembly variants, empty)
- **Not migrated**: 3D models, net classes, SPICE models, custom rules; elements that cannot be translated are skipped with a warning

### Library Conversion Coverage (.elibz2)

| KiCad library | .elibz2 |
| --- | --- |
| Every `(symbol …)` in a `*.kicad_sym` | `SYMBOL` doc segment (`PART`/`PIN`/`POLY`/`RECT`/`CIRCLE`/`ARC`/`BEZIER`) + a `device2.json` symbol index entry + a device entry |
| `symbol_type "power"` | META `docType:18` (power class) |
| Symbol `property` entries (other than Reference/Value) | Passed through into device `attributes` |
| Symbol `Footprint` property | Auto-written to the device's `attributes.Footprint` (uuid) when it matches a footprint name |
| Every `(footprint …)` in `*.pretty/*.kicad_mod` | `FOOTPRINT` doc segment (19-layer table + `PAD`/`POLY`/`ARC` + `ACTIVE_LAYER`) + a `device2.json` footprint index entry |
| pad `thru_hole`/`oval` drills | `PAD` `holeDiameter`/`holeWidth`/`holeType ROUND` |
| `F.SilkS`/`B.SilkS` graphics | layerId 3/4; Fab/CrtYd/Dwgs and the rest → Document layer 13 |

## Directory Structure

```
kicad-to-easyeda-eprj3/
├── scripts/
│   ├── convert-kicad.js      ← Project CLI wrapper
│   ├── convert-kicad-lib.js  ← Library CLI wrapper
│   ├── browser/
│   │   ├── entry.js          ← Standalone bundle entry (Node CLI + browser API)
│   │   ├── vfs.js            ← In-memory filesystem used by the browser page
│   │   ├── active-fs.js      ← Active filesystem switch for one conversion
│   │   ├── node-fs.js / node-path.js ← Host Node fs/path injected by the bundle
│   │   ├── node-shims/       ← fs/path/crypto/zlib facades for browsers + Node
│   │   └── zip-store.js      ← Dependency-free STORE-mode ZIP writer for downloads
│   └── lib/
│       ├── convert-project.js ← Project conversion flow (shared by CLI + bundle)
│       ├── convert-lib.js    ← Library conversion flow (shared by CLI + bundle)
│       ├── kicad.js          ← KiCad S-expression parser
│       ├── kicad-to-eprj3.js ← Symbols/footprints → eprj3 records
│       ├── schematic-convert.js ← Schematic page conversion (symbols/net flags/net ports/hierarchy/frame)
│       ├── pcb-convert.js    ← PCB conversion (tracks/vias/footprints/pours/stackup/design rules)
│       ├── convert-util.js   ← Shared conversion constants and helpers
│       ├── frame-template.js ← A4 drawing-sheet template instantiation
│       ├── eprj3.js          ← eprj3 read/write core (from easyeda-eprj3-skill, corrected against the official example)
│       ├── elibz2.js         ← .elibz2 package assembly (device2.json + .elibu)
│       ├── zip.js            ← Dependency-free zip read/write (zlib deflate/store)
│       └── utils.js
├── build/
│   ├── bundle.js             ← Builds the standalone JS, HTML page and zip
│   ├── version.js            ← Version bump (patch/minor/major/none)
│   ├── check-licenses.js     ← Enforces MIT/Apache-2.0 for every dependency
│   ├── licenses/             ← MIT license texts shipped in the zip
│   ├── app.html              ← Browser page template
│   └── artifact-readme.md    ← Bilingual end-user guide shipped in the zip
├── .github/workflows/
│   ├── build-release.yml     ← Manual build → version bump → tag → release asset
│   └── pages.yml             ← Push to main → build the single-page site for GitHub Pages
├── example/
│   ├── easyeda/              ← Reference EasyEDA Pro library package easyeda-pro-libs.elibz2
│   └── kicad/                ← Sample KiCad project
└── test/
    ├── smoke.js              ← End-to-end smoke suite (165 assertions)
    ├── bundle.test.js        ← Standalone bundle / browser API / HTML tests (23 assertions)
    ├── ui.test.js            ← Browser page folder-scan / multi-select / modal tests (11 assertions)
    ├── compare/              ← KiCad ↔ eprj3 comparison (netlist/BOM/PCB primitives/stackup/ratlines)
    └── validate-format.js    ← Format validator checking generated records against the official JSON Schemas
```

## Testing

```bash
npm test          # license check + smoke + hostpath + standalone bundle + UI tests
npm run build     # dist/kicad-to-eprj3-<version>.{js,zip} + kicad-to-eprj3.html
```

Generated records can additionally be validated one by one against the official Schemas (`sch`/`pcb`/`lib` contexts; `lib` routes each doc's records by its docType):

```bash
node test/validate-format.js <generated .esch2|.epcb2|.elibu> <sch|pcb|lib>
```

> The validator uses `validate.js` from [easyeda-format-skill](https://github.com/easyeda/easyeda-format-skill), located in the sibling directory (or via the `EASYEDA_FORMAT_SKILL` environment variable) when present; it is not vendored. Note: the official Schemas slightly diverge from real app exports (e.g. `POUR.pourType`, PCB `ATTR.groupID`, the `DIMENSION` structure); the validator is calibrated to the real exported data.

## Related Projects

- [easyeda-format-skill](https://github.com/easyeda/easyeda-format-skill) — The EasyEDA Pro file format skill pack (type index, per-primitive field definitions, JSON Schemas, validate.js); the authoritative format reference for this repository
- [easyeda-eprj3-skill](https://github.com/easyeda/easyeda-eprj3-skill) — A skill pack that teaches AI coding assistants to generate `.eprj3` projects from scratch; `scripts/lib/eprj3.js` and `utils.js` in this repository come from that project's core library
- [easyeda-eprj3-format](https://github.com/easyeda/easyeda-eprj3-format) — Official eprj3 format example project

## License

[Apache-2.0](LICENSE)

Third-party components are all MIT-licensed (the vendored `eprj3.js` / `utils.js` core; full text under `build/licenses/`). The project deliberately avoids npm dependencies — `npm run license:check` (part of `npm test`) enforces that any dependency is MIT or Apache-2.0.
