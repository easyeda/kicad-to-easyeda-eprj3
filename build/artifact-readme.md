# KiCad → EasyEDA Pro 转换器 / KiCad → EasyEDA Pro Converter

版本 / Version: **__K2E_VERSION__**

把 KiCad 工程（`.kicad_sch` / `.kicad_pcb`）转换成嘉立创EDA专业版（EasyEDA Pro）的 `.eprj3` 工程，也可以把 KiCad 符号库/封装库打包成 `.elibz2` 库文件。
Convert KiCad projects (`.kicad_sch` / `.kicad_pcb`) into EasyEDA Pro `.eprj3` projects, and KiCad symbol/footprint libraries into `.elibz2` packages.

---

## 压缩包内容 / What's inside

| 文件 / File | 用途 / Purpose |
| --- | --- |
| `kicad-to-eprj3.html` | 浏览器页面，双击打开即可使用（推荐） / Browser page, just double-click (recommended) |
| `kicad-to-eprj3-__K2E_VERSION__.js` | 独立脚本：可在 Node.js 命令行使用，也可被其他网页引用 / Standalone script for the Node.js CLI or for embedding in a web page |
| `README.md` | 本说明 / This guide |
| `LICENSE` | Apache-2.0 许可证 / Apache-2.0 license |
| `THIRD-PARTY.md` | 第三方组件与许可证说明 / Third-party components and licenses |
| `LICENSES/` | 随包分发的 MIT 许可证全文 / MIT license texts for bundled code |

---

## 方式一：浏览器页面（推荐，无需安装）

1. 用 **Chrome 或 Edge**（最新版）打开 `kicad-to-eprj3.html`。
2. 点击选择文件夹，页面会自动识别其中的多个工程文件夹，勾选后一次添加；也可以把多个文件夹直接拖进页面。
3. 点击「开始转换」，等待完成。
4. 点击「下载 .eprj3.zip」，解压得到 `<工程名>/` 文件夹。
5. 打开嘉立创EDA专业版，选择「文件 → 打开工程」，选中 `<工程名>/<工程名>.eprj3` 即可。

所有转换都在你的电脑浏览器里完成，**文件不会上传**到任何服务器；选择文件夹时也不会出现“上传文件”确认框。

**English**

1. Open `kicad-to-eprj3.html` in a recent **Chrome or Edge**.
2. Click to choose a folder — projects inside it are detected so you can tick several at once; you can also drop multiple folders onto the page.
3. Click **Convert** and wait for it to finish.
4. Click **Download .eprj3.zip** and unzip it — you get a `<project>/` folder.
5. In EasyEDA Pro choose **File → Open Project** and select `<project>/<project>.eprj3`.

Everything runs locally in your browser; **no files are uploaded** and no “upload files” confirmation appears.

---

## 方式二：Node.js 命令行（适合批量处理）

需要安装 Node.js 18 或更高版本。打开终端，在压缩包解压目录执行：

```bash
# KiCad 工程 → .eprj3（第 1 个参数是工程目录，第 2 个是输出目录）
node kicad-to-eprj3-__K2E_VERSION__.js convert <KiCad工程目录> <输出目录>

# 指定工程名 / 覆铜精度（1-8，默认 8）
node kicad-to-eprj3-__K2E_VERSION__.js convert <KiCad工程目录> <输出目录> --project-name myboard --pour-fineness 6

# KiCad 库目录 → .elibz2（.kicad_sym 与 .pretty 需在库目录下一层）
node kicad-to-eprj3-__K2E_VERSION__.js convert-lib <KiCad库目录> <输出.elibz2>
```

输出目录中会生成 `<工程名>.eprj3` 索引文件以及 `sch/`、`pcb/` 文件夹；用嘉立创EDA专业版打开该 `.eprj3` 文件即可。

**English**

Requires Node.js 18+. In the unzipped folder:

```bash
# KiCad project → .eprj3 (1st arg = project folder, 2nd = output folder)
node kicad-to-eprj3-__K2E_VERSION__.js convert <KiCadProjectDir> <OutputDir>

# Optional: project name / copper-pour fineness (1-8, default 8)
node kicad-to-eprj3-__K2E_VERSION__.js convert <KiCadProjectDir> <OutputDir> --project-name myboard --pour-fineness 6

# KiCad library folder → .elibz2 (.kicad_sym and .pretty directories one level down)
node kicad-to-eprj3-__K2E_VERSION__.js convert-lib <KiCadLibDir> <Output.elibz2>
```

The output folder contains the `<name>.eprj3` index plus `sch/` and `pcb/`; open that `.eprj3` file in EasyEDA Pro.

---

## 常见问题 / FAQ

**转换后打开工程，元件/走线正常吗？**
转换尽量保留原理图、PCB 图元、层次图（CBB）、覆铜、层栈与设计规则。3D 模型、网络类、SPICE 模型与自定义规则不会迁移；无法识别的元素会跳过并在页面日志中提示。

**Do the schematic and PCB survive conversion?**
Schematics, PCB primitives, hierarchy (CBB), copper pours, stack-up and design rules are preserved as far as possible. 3D models, net classes, SPICE models and custom rules are not migrated; unsupported items are skipped and reported in the page log.

**为什么有“部分完成”？ / Why "Partly done"?**
个别 PCB 文件转换失败时，其余内容仍会保留。展开日志可以看到具体文件与原因。

If one PCB file fails, the rest of the project is still written; expand the log for the failing file and reason.

**支持哪些浏览器？ / Which browsers?**
建议使用最新版 Chrome 或 Edge（需要文件夹选择与本地文件读取能力）。

A recent Chrome or Edge is recommended (folder picking and local file access are required).

---

## 许可证 / License

Apache-2.0。转换规则与格式参考 [easyeda-format-skill](https://github.com/easyeda/easyeda-format-skill) 与 [easyeda-eprj3-format](https://github.com/easyeda/easyeda-eprj3-format)。

Apache-2.0. Conversion rules and file formats follow [easyeda-format-skill](https://github.com/easyeda/easyeda-format-skill) and [easyeda-eprj3-format](https://github.com/easyeda/easyeda-eprj3-format).
