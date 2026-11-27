# Taomni taoffice：DOCX 库调研（挑战 craft 路线）

调研时间：2026-11-15（北京时间）。方法：browser.search + GitHub API（`github_api.py get /repos/<owner>/<repo>`）+ 各项目官方文档页。
未核实项明确标注“未核实”，不编数字。

## 对比表

| 库 | 语言 | 许可证 | 成熟度（版本/发布日期/下载量或 stars） | 读 | 写 / 保真度 | 体积 / 集成 | 备注 |
|---|---|---|---|---|---|---|---|
| **craft-docx + WordCraft**（当前首选，需被挑战） | Rust | Apache-2.0（GitHub 字段；另有来源称 MIT/Apache 双许可） | craft-libs：创建 2026-10-09，424 stars，859 forks，最后 push 2026-11-15；wordcraft：创建 2026-10-07，18,021 stars，最新 release v0.18.1（2026-11-12）。无 crates.io 发布（git-rev 依赖） | 读 .docx，另有 .doc/.odt/.rtf/.md/.tex 导入 | 写 .docx；自称 passthrough（模型未覆盖标记原样写回），但**未在真实文件上验证过往返**；自评约 60% 可用，alpha | git-rev 供应链；WordCraft `[patch.crates-io]` 用 storytold 的 egui/winit fork，**可能与 Tauri 2 的 tao/winit 冲突**；体积未核实 | 唯一“为完整字处理而生”的 Rust 路线，但最年轻、未经真实文件检验。来源：[wordcraft](https://github.com/storytold/wordcraft)、[craft-libs](https://github.com/storytold/craft-libs)、[评测](https://www.nanoflow.blog/guides/free-microsoft-office-clone-tested) |
| **docx-rs**（bokuweb） | Rust | MIT | v0.4.22（lib.rs 数据），~270K crates.io 下载（lib.rs）；GitHub 562 stars，125 forks，创建 2019-09-11，最后 push 2026-11-15；Ubuntu 已打包 0.4.20。最新发布日期未核实 | 能读（`read_docx`），但读是次要能力 | 以**生成**为主；读入后重建 XML 写出，**无 passthrough 承诺，未建模部件会丢失**；无公开的任意文本替换 API（第三方兼容性矩阵：find-replace 0/2） | 纯 Rust，源码包仅 ~241 KB，编译进应用无 sidecar；有 WASM 构建（docx-wasm） | 最老牌的 Rust docx 库，但方向是“写新文档”不是“编辑已有文档”，不满足手术式补丁。来源：[GitHub](https://github.com/bokuweb/docx-rs)、[lib.rs](https://lib.rs/parser-implementations?sort=popular)、[Tritium 评述](https://tritium.legal/blog/word) |
| **docx-rust**（cstkingkey，docx-rs 的 fork） | Rust | MIT | v0.1.11（2026-01-22，docs.rs），35 stars，30 forks，创建 2022-05-02，最后 push 2026-08-27 | 读 + 写（footnotes/endnotes/comments/numbering 有扩展） | 全量重建式写出，无 passthrough 承诺 | 纯 Rust，编译进应用 | 小众 fork，社区远小于上游，无额外优势。来源：[GitHub](https://github.com/cstkingkey/docx-rs)、[docs.rs](https://docs.rs/crate/docx-rust/latest) |
| **Office Oxide**（yfedoseev/office_oxide） | Rust（另有 Python/Go/JS/C# 绑定） | MIT OR Apache-2.0 | v0.1.17（crates.io）；GitHub 168 stars，创建 2026-03-01，最后 push 2026-11-11；lib.rs 引用数据约 192K 下载；自称 10,386 文件测试集 97.3% 打开率 | 读 DOCX/XLSX/PPTX **及 legacy DOC/XLS/PPT**（无 JVM、无外部二进制，Rust 内唯一做到三者全读的库之一） | **`EditableDocument`：明确承诺“保存时所有未修改的 OPC 部件原样保留”**（图片、图表、样式、主题、关系）；但编辑 API 目前只有 `replace_text` / `set_cell` 级别，是**模板填充级编辑，不是完整字处理模型** | 纯 Rust，零原生依赖；有 WASM 构建（office-oxide-wasm）；体积未核实（应很小） | **手术式补丁要求上唯一明确达标的成熟候选**；与 docx-rs 无任何关系，是 2026 年的独立新实现。短板：编辑能力窄、项目仅 8 个月、stars 少。来源：[GitHub](https://github.com/yfedoseev/office_oxide)、[官网](https://office.oxide.fyi/)、[编辑文档](https://office.oxide.fyi/rust/docs/editing/overview) |
| **BetterOffice**（openooxml/betteroffice） | Rust 引擎 + TS/React 前端 | Apache-2.0 | Rust `betteroffice-docx` v0.5，npm `@betteroffice/docx` 0.5；GitHub 357 stars，创建 2026-07-11，最后 push 2026-11-15；0.5 迁移文档齐全 | 读 DOCX（段落/表格/节、结构化导出、Markdown 导出、诊断列表） | 真编辑：yrs CRDT 编辑核心、版本校验的原子编辑批次、tracked changes、compareDocx；**保存保留模型未表示的包内容**；含分页/布局（`betteroffice-docx-layout`）和 tiny-skia 光栅化；提供 `@betteroffice/docx-react` 编辑器组件（React 18/19 peer 依赖） | 纯 Rust + WASM，无 egui/winit fork，**与 Tauri 无已知冲突**；字体包 latin 4.7 MB、intl 2.2 MB、CJK 26.7 MB（可选），100 MB 插件包内容纳无压力 | **本次调研发现的最强挑战者**：唯一同时满足“真编辑 + 手术式保存 + React 19 组件 + 纯 Rust 编译进应用”的现成方案。短板：同样年轻（4 个月，0.5 版）、社区小（357 stars），DOCX 编辑覆盖面待 spike 验证（Python 绑定目前只改单 run 段落，JS 核心能力更全）。来源：[GitHub](https://github.com/openooxml/betteroffice)、[Rust 文档](https://docs.betteroffice.dev/docs/rust)、[JS 文档](https://docs.betteroffice.dev/docs/javascript) |
| **docx**（dolanmiu，npm `docx`） | TS/JS | MIT | v9.15.3（npm.io，2026-11-06 前后发布）；GitHub 6,000 stars，623 forks，创建 2016-03-26，最后 push 2026-11-14；约 200 万月下载（第三方博客说法，npm 官方数字未核实） | 不读任意文档（只有从模板 patch 的读取） | 生成新文档能力最强；`patchDocument`（Patcher）可替换模板中 `{{占位符}}`，保留模板其余格式/样式，支持段落级与文档级补丁、图片替换；**但只能改占位符，不能任意编辑已有文档** | 纯 JS，打包进 WebView，无 sidecar；包体积未核实（通常数百 KB） | 适合“从模板生成”，不适合“打开任意 .docx 真编辑”。可作 Patcher 思路参考。来源：[GitHub](https://github.com/dolanmiu/docx)、[npm](https://npm.io/package/docx) |
| **docx-preview**（VolodymyrBaydalka/docxjs） | JS | Apache-2.0 | v0.4.1（npm.io，约 2026-10 发布）；GitHub 2,149 stars，创建 2016-10-24，最后 push 2026-09-21 | 读并渲染为语义 HTML（页眉/页脚/脚注/表格/公式/图片/分页） | **只读渲染，无写回** | 纯 JS（需 jszip peer 依赖），浏览器内运行，无 sidecar | 适合只读预览层；真编辑需另配写回路径。来源：[GitHub](https://github.com/VolodymyrBaydalka/docxjs)、[npm](https://npm.io/package/docx-preview) |
| **mammoth**（mwilliamson/mammoth.js） | JS（另有 Python/Java 版） | BSD-2-Clause | npm mammoth 1.13.0（2026-11-03 第三方清单）；GitHub 6,342 stars，669 forks，创建 2013-03-29，最后 push 2026-10-16 | 读 .docx 转语义 HTML / 纯文本（style map 驱动） | **只读；有意丢弃视觉格式**，无写回 | 纯 JS，浏览器 bundle 约 200 KB（第三方说法），无 sidecar | 适合导入/文本抽取，不适合编辑。来源：[GitHub](https://github.com/mwilliamson/mammoth.js) |
| **docx4js**（lalalic） | JS | ⚠️ **许可证存疑**：npm 3.3.0 标 MIT，旧版 README 写 GPL，GitHub 未检测到 license 文件 | v3.3.0（jsDelivr）；GitHub 403 stars，创建 2014-12-31，最后 push 2026-03-31 | 读 .docx（3.1.30+ 也读 .pptx），visitor 遍历式解析，内存占用低 | **只读解析器，无写回** | 纯 JS，浏览器/Node，无 sidecar | 许可证不清 + 只读，排除；如需用必须先让作者澄清许可证。来源：[GitHub](https://github.com/lalalic/docx4js)、[jsDelivr](https://www.jsdelivr.com/package/npm/docx4js?tab=stats) |
| **docxtemplater**（open-xml-templating） | JS | MIT（npm 字段）；项目文档称 MIT 或 GPL-3.0 双许可；图片/HTML/图表等模块付费（约 €500/模块/年） | v3.71.1（约 2026-10）；GitHub 3,650 stars，创建 2013-05-16，最后 push 2026-10-15 | 读模板 | 模板填充：替换占位符/循环/条件，模板其余内容保留；**不是通用编辑器**，高级能力在付费模块后 | 纯 JS（PizZip），无 sidecar | 只适合模板生成场景。来源：[GitHub](https://github.com/open-xml-templating/docxtemplater)、[npm registry](https://registry.npmjs.org/docxtemplater/3.66.4) |
| **python-docx**（仅参考） | Python | MIT | v1.2.0（2025-06-16）；GitHub 5,769 stars，1,337 forks，创建 2013-10-15，最后 push 2026-08-01 | 读/写 .docx（段落/表格/图片/样式），API 成熟 | 写是全量重建：**会重写它不理解的部分**（第三方对照实测），不满足手术式补丁；无渲染/排版 | **不能用**：需要 Python 解释器 + lxml 原生依赖，要么嵌解释器（PyO3 嵌入约增数十 MB 且分发复杂），要么 sidecar 进程，**两条路都违反硬约束**；且无布局引擎 | 排除。来源：[GitHub](https://github.com/python-openxml/python-docx) |
| **docxcraft**（AlgForce） | Rust | ⚠️ **AGPL-3.0-only** | 0.1，API 演进中；Rust 1.89+ | **不读已有文档** | 仅生成新 .docx（段落/表格/图片/SVG/图表） | 纯 Rust | AGPL + 不能读，排除。来源：[docs.rs](http://docs.rs/docxcraft/latest/docxcraft/) |
| **officework**（PyPI，Rust 引擎） | Rust 引擎 + Python 绑定 | ⚠️ **AGPL-3.0-or-later** | 0.5.0b4（2026-08-30），beta；自称 51 个真实文档中 46 个打开保存后完全不变 | 读 .docx/.xlsx | 手术式保存（只写改动）+ 同引擎排版出 PDF，功能上最接近理想 | 引擎仅几 MB，无 sidecar | 功能上是标杆，但 **AGPL 禁止进 MIT 项目分发**，排除；可作“保真度测试方法”参考。来源：[PyPI](https://pypi.org/project/officework/0.5.0b4/) |

## 补充：老格式与周边

- **.doc（二进制 Word 97–2003）**：antiword 是 C 命令行工具，GPLv2+，上游 2005 年后死亡，FreeBSD 已于 2026-10 标记废弃且有未修复 CVE（CVE-2026-111677/111678），且是独立二进制——**既是 sidecar 又有许可证与安全问题，排除**。可用 Rust 路线：Office Oxide 原生读 .doc（只读）；WordCraft 的 `wordcraft-docbin`（PR #145，基于公开 MS-DOC/MS-CFB 规范 + MIT 的 `cfb` crate，导入专用，保存仍走 .docx）。来源：[FreshPorts](https://www.freshports.org/textproc/antiword)、[wordcraft PR #145](https://github.com/storytold/wordcraft/pull/145)。
- **RTF**：纯文本标记格式，无需 sidecar；本次未找到成熟的 Rust RTF 编辑库（未深入核实）。craft 路线自称支持 RTF 导入/导出；或自研轻量解析。建议列为后续 spike，不阻塞 DOCX 选型。
- **ODF（.odt 等）**：WebODF 是 AGPLv3 的 JS 库，只做 ODF、不原生支持 DOCX，且**约 6 年无实质维护**——许可证与维护双重排除。ODF 读写如需支持，优先用 Rust 自研 ZIP+XML 解析（ODF 与 OOXML 同构）或复用 craft 的 ODT 支持。来源：[Nutrient 对比](https://www.nutrient.io/blog/top-doc-viewers/)、[WebODF FAQ](https://WebOdf.org/faq.html)。
- **LibreOffice headless / OnlyOffice / Collabora**：均为独立进程或服务器，不符合“无 sidecar”硬约束，排除（不展开）。
- 其他发现（未深入核实，仅记录）：`safe-docx`（Rust，第三方兼容性矩阵中有出现）、SuperDoc SDK（商业，矩阵中 find-replace 2/2）。

## 关系澄清

- Office Oxide 与 docx-rs **无任何关系**：docx-rs 是 bokuweb 自 2019 年的生成器优先项目；Office Oxide 是 yfedoseev 自 2026-03 的独立新实现，其 README 直接拿 docx-rs 做性能对照。
- docx-rust（cstkingkey）是 docx-rs（PoiScript/bokuweb 系）的 fork，不是独立实现。

## 判断：混合路线，craft 不应再是首选

**结论：对 DOCX 而言，craft 路线目前不应是首选。建议混合路线——格式/补丁层用 Office Oxide，编辑/渲染层优先 spike BetterOffice；craft 降级为长期备选。**

理由：

1. **手术式补丁是硬要求，而 craft 是唯一“自称 passthrough 但未经真实文件验证”的候选。** Office Oxide 的 `EditableDocument` 把“未修改 OPC 部件原样保留”写进文档并作为核心卖点；BetterOffice 同样承诺保存时复用模型未表示的包内容。两者都把保真度当作可测试的契约，craft 只有主张没有证据（其路线图自己承认 DOCX 未在真实文件上测过）。
2. **BetterOffice 是唯一现成覆盖“真编辑 + React 19 + 纯 Rust + 无 winit 冲突”的方案。** 它有 `@betteroffice/docx-react` 编辑器组件（React 18/19）、yrs CRDT 编辑、分页/布局、tiny-skia 光栅化，且是 crates.io/npm 正式发布，不是 git-rev。Tauri 集成路径最短。
3. **craft 的三项已知问题没有一项被本次调研推翻**：全部 alpha 且仅 6 周历史（wordcraft 创建 2026-10-07）；git-rev 供应链（craft-libs 无 crates.io 发布）；winit fork 冲突风险仍在。18,021 stars 是热度不是成熟度——同期 v0.18.1 仍是 alpha，且 1,617 个 open issue（第三方 2026-10-22 核查）与“60% 可用”自评一致。
4. **docx-rs / dolanmiu-docx / mammoth / docx-preview 各有所长但都不解决“真编辑 + 保真”**：docx-rs 是生成器（读后重建会丢东西）；dolanmiu-docx 只能 patch 占位符；mammoth/docx-preview 只读。它们适合做辅助层（预览、导入、模板生成），不适合做编辑核心。

前提条件与下一步：

1. **先做一个为期 1–2 天的 spike 再定型**：用 BetterOffice `@betteroffice/docx-react` + `betteroffice-docx` 打开 10–20 个真实 .docx（含表格、图片、页眉页脚、批注、修订、复杂样式），做“改一处文字 → 保存 → 逐字节 diff 未动部件 + Word 打开验证”的保真度测试；同时验证包体积（字体按需裁剪，CJK 26.7 MB 可选）和 Tauri 打包。
2. **若 BetterOffice spike 不通过**（编辑覆盖面不足或保真度有缺口），退路是：格式层 Office Oxide（`EditableDocument` 做手术式读写）+ 自研 React 编辑器；此时 craft-docx 可作为该自研编辑器下层的第二候选，但前提是等它出现 beta 或真实文件往返测试证据，并解决 winit fork 冲突（或将其 format crate 从应用仓剥离单独引用）。
3. **不要把 craft 完全丢掉**：它的长期目标（完整字处理模型 + .doc/.odt/.rtf 全格式）仍是正确的终局方向；建议每季度复评一次，等它发布 crates.io 版本且 DOCX 真实文件测试落地后再重新评估是否替换 BetterOffice/Office Oxide。
4. **许可证红线**：docxcraft、officework（AGPL）、WebODF（AGPL）、docx4js（许可证不明，旧版 GPL）一律不得引入；docxtemplater 付费模块不进核心路径。
5. **.doc 只读**：用 Office Oxide 的原生 .doc 读取（或 wordcraft-docbin，二选一），不引入 antiword/LibreOffice。
