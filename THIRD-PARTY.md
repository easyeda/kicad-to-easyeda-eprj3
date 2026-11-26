# 第三方组件与许可证 / Third-Party Components and Licenses

本项目以 **Apache-2.0** 发布。所有第三方**软件库**均为 **MIT** 或 **Apache-2.0**；项目**没有 npm 运行时依赖，也没有 npm 开发依赖**（`dependencies` / `devDependencies` 均为空），能自行实现的逻辑不引入第三方包。
This project is released under **Apache-2.0**. Every third-party **software library** is licensed under **MIT** or **Apache-2.0**. There are **no npm runtime or development dependencies**; whenever possible the logic is implemented in this repository.

## 随源码附带的第三方代码 / Vendored source code

| 组件 / Component | 许可证 / License | 位置 / Location |
| --- | --- | --- |
| easyeda-eprj3-skill | MIT | `scripts/lib/eprj3.js`, `scripts/lib/utils.js`（在其核心库基础上修改 / derived and modified） |

许可证全文 / Full license text:

- [`build/licenses/easyeda-eprj3-skill-LICENSE.txt`](build/licenses/easyeda-eprj3-skill-LICENSE.txt)

## 开发期外部引用（不随仓库分发）/ Development-time external reference (not vendored)

| 组件 / Component | 许可证 / License | 用途 / Purpose |
| --- | --- | --- |
| easyeda-format-skill（或旧目录名 easyeda-pro-format-skill） | MIT | 仅当本地存在该同级目录（或设置 `EASYEDA_FORMAT_SKILL`）时，`test/validate-format.js` 会加载其官方 JSON Schema 校验器；不复制、不打包、不随构建产物分发 / `test/validate-format.js` loads the official schema validator from the sibling checkout (or `EASYEDA_FORMAT_SKILL`) when present; it is not copied, bundled or shipped |

## 格式数据 / Format data

`scripts/lib/frame-a4.json`（A4 图框模板）、`scripts/lib/pcb-config.json`（PCB 编辑器默认配置）以及 `example/` 下的 EasyEDA Pro 导出示例是**格式数据**（图层表、图元默认值、示例工程），不是软件库；构建产物会内联图框与配置数据。
`scripts/lib/frame-a4.json` (A4 frame template), `scripts/lib/pcb-config.json` (PCB editor defaults) and the exported examples under `example/` are **format data** (layer tables, primitive defaults, sample projects), not software libraries. The built bundle inlines the frame/config data.

## 合规检查 / Compliance check

```bash
npm run license:check
```

`build/check-licenses.js` 会读取 `package.json` 中声明的全部依赖（含嵌套依赖），任何非 MIT / Apache-2.0 许可证都会使检查失败，并已接入 `npm test` 与构建工作流。当前项目无任何依赖，检查通过。
`build/check-licenses.js` inspects every declared dependency (including nested ones) and fails on any license other than MIT / Apache-2.0. It runs as part of `npm test` and the build workflow. The project currently has no dependencies, so the check passes.

新增第三方库前，请确认其许可证为 MIT 或 Apache-2.0，并在本文件补充说明；能避免依赖时优先自行实现。
Before adding a third-party library, make sure its license is MIT or Apache-2.0 and document it here. Prefer implementing things yourself when a dependency can be avoided.
