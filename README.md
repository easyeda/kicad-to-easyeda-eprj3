# kicad-to-easyeda-eprj3

将 KiCAD 工程文件转换为嘉立创EDA（EasyEDA Pro）的 eprj3 工程格式，支持批量操作。Convert KiCAD project files to the eprj3 project format of EasyEDA Pro, supporting batch operations.

## 功能

- **工程转换**：批量遍历目录下所有 `.kicad_sch` / `.kicad_pcb`，生成完整的 eprj3 文件夹工程（`<name>.eprj3` 索引 + `sch/` + `pcb/`）
- **库导入**：把 `.kicad_sym` 符号库中的符号注入已有 eprj3 工程的 `sch/__symbols__/`

## 环境要求

- Node.js ≥ 18，无任何 npm 依赖。

## 用法

### 1) KiCad 工程 → eprj3 工程（批量）

```bash
node scripts/convert-kicad.js convert \
  --src <KiCad工程目录> \
  --dst <输出目录> \
  [--project-name <名称>] \
  [--lib-dir <.kicad_sym库目录>]
```

- `--src` 下每个 `*.kicad_sch` 生成一张原理图（`Schematic1`、`Schematic2` …），每个 `*.kicad_pcb` 生成一块板（`PCB1`、`PCB2` …）
- `--lib-dir` 可选：把目录内所有 `.kicad_sym` 的符号一并写入 `<dst>/sch/__symbols__/`

### 2) KiCad 符号库 → 已有 eprj3 工程

```bash
node scripts/import-kicad-lib.js import \
  --dir <eprj3工程目录> \
  --library <单个.kicad_sym文件或包含它的目录> \
  --component <符号名>
```

## 转换覆盖范围（best-effort）

| KiCad | eprj3 |
| --- | --- |
| `wire` | `WIRE` + 多条共享 `lineGroup` 的 `LINE` |
| `label` | `NETLABEL` |
| `symbol`（含 `property`） | `COMPONENT` + `Designator`/`Value` `ATTR` |
| `segment`（PCB 走线） | 对应层上的 `FILL` |
| `footprint`（含 `pad`） | `PART`/`PAD`/丝印 `RECT` 记录 |
| 层映射 | `F.Cu=1`、`B.Cu=2`、`F.SilkS=3`、`B.SilkS=4` |

- 单位换算：KiCad mm → eprj3 mil（×39.3700787）
- **不迁移**：3D 模型、敷铜、网络类、SPICE 模型、自定义规则；无法翻译的元素会跳过并告警

## 目录结构

```
kicad-to-easyeda-eprj3/
├── scripts/
│   ├── convert-kicad.js      ← 工程批量转换入口
│   ├── import-kicad-lib.js   ← 符号库导入
│   └── lib/
│       ├── kicad.js          ← KiCad S-expression 解析器
│       ├── kicad-to-eprj3.js ← 符号/封装 → eprj3 记录
│       ├── eprj3.js          ← eprj3 读写核心（vendored 自 easyeda-eprj3-skill）
│       └── utils.js
└── test/smoke.js
```

## 测试

```bash
npm test
```

## 相关项目

- [easyeda-eprj3-skill](https://github.com/easyeda/easyeda-eprj3-skill) — 教 AI 编码助手从零生成 `.eprj3` 工程的技能包；本仓库的 `scripts/lib/eprj3.js` 与 `utils.js` 即来自该项目的核心库
- eprj3 格式权威参考：https://github.com/easyeda/easyeda-pro-eprj3-format

## License

[Apache-2.0](LICENSE)
