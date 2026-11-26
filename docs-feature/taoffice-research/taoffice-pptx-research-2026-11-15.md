# Taomni taoffice — PPTX 库调研（对比 storytold craft 路线）

调研日期：2026-11-15（北京时间）。核实方法：browser.search / browser.open 读 crates.io、npm、lib.rs、官方文档页；GitHub 仓库信息用 `github_api.py get /repos/<owner>/<repo>` 及 releases API 核实。查不到的写“未核实”，不编数字。

## 核心结论（先说）

**没有同时满足“成熟 + 开源读写 + 手术式补丁”的 PPTX 库。“无成熟开源读写库”本身就是本次调研结果。**

- 唯一把“未动部件字节不变”写进产品保证里的三个候选都很年轻：`office_oxide`（2026-03 才建仓，0.1.x）、OpenPresent（early preview，自认未用 PowerPoint 对照验证）、`adapters-ooxml`/stichos（0.2.x，仓库目前仍私有）。
- 在当前设计口径（**文本替换 + 新建，不做像素级画布编辑**）下，craft 路线不是最优解：它的优势（母版/版式/节的完整模型 + DeckCraft 渲染）恰好超出当前口径，而它的短板（全 alpha、git-rev 供应链、`kept parts` 无独立佐证）恰好打在 taoffice 的硬约束上。

## 对比表

| 库 | 语言 | 许可证 | 成熟度（版本 / 发布日期 / 下载量或 stars） | 读 | 写 / 保真度 | 体积 / 集成 | 备注 |
|---|---|---|---|---|---|---|---|
| **storytold craft-pptx + DeckCraft（现首选路线）** | Rust | Apache-2.0（GitHub API 字段；项目页自称 MIT OR Apache-2.0 双许可） | craft-libs 建仓 2026-10-09，424★ / 859 forks / 562 open issues，最后推送 2026-11-15；DeckCraft **v0.18.1（2026-11-12）**，4,796★；自评 ~55% 可用于真实工作；**无 crates.io 发布，只能 git-rev** | 读：PresentationML 类型 + serde，母版/版式/幻灯片/节 | 写：有；“kept parts”保留未动部件——**未独立核实**（公开检索无佐证，属任务给定的设计口径）；动画/母版保留程度未核实 | 纯 Rust 编译进应用，无 sidecar；但 craft-libs 是大 monorepo，依赖面大，包体积未核实 | 任务称 DeckCraft 自评 84% 功能广度；公开资料另有 79%（10 月中旬）与 ~55% ready 两种口径，84% 未核实。来源：[craft-libs](https://github.com/storytold/craft-libs)、[deckcraft](https://github.com/storytold/deckcraft)、[DeckCraft v0.18.1](https://craftsuite.net/deckcraft) |
| **office_oxide ⭐ 推荐格式层** | Rust（纯 Rust，零原生依赖；另有 WASM/Node/Python/Go/C# 绑定） | GitHub API：Apache-2.0；官方文档称 MIT OR Apache-2.0 双许可 | **0.1.x**（0.1.0 首发 2026-04-28；crates.io README 示例 0.1.17；lib.rs 快照为 0.1.8，2026-07-22）；**约 148,875 次下载/月**（lib.rs），52 个依赖 crate；GitHub 168★，建仓 2026-03-01，最后推送 2026-11-11 | 读：DOCX/XLSX/PPTX + 老格式 DOC/XLS/PPT；PPTX 文本抽取 0.7ms，10,386 文件集 98.7% 通过（官方自测） | **写：`EditableDocument` 明确保证“只重写动过的 part，其余 OPC part 原样复制”，是本次调研中唯一在文档层面承诺手术式补丁的已发布库**；但通用编辑 API 只有 `replace_text`（跨 run 合并处理，遍历全部 `<a:t>` 含备注页）+ `set_cell`（XLSX）；新建/增删幻灯片走 `pptx::edit::PptxEditor` / `PptxBuilder`，其覆盖度**未核实** | crate 约 1.5MB / 29K SLoC，纯 Rust 直引，Tauri command 直接调用，无 sidecar，≤100MB 毫无压力 | 核心定位是文本抽取/转换，PPTX 编辑是“模板填空”级别；正好覆盖当前口径，但结构编辑能力需 spike 验证。来源：[crates.io](https://crates.io/crates/office_oxide)、[编辑文档](https://office.oxide.fyi/rust/docs/editing/overview)、[GitHub](https://github.com/yfedoseev/office_oxide) |
| **rpptx / rpptx-oxml（tensorbee/rdocx）** | Rust | MIT | facade `rpptx` 0.2.0，`rpptx-oxml` 0.15.0（两 crate 版本号不同步，迭代极快）；仓库 44★，建仓 2026-02-22，最后推送 2026-11-09，活跃 | 读/编辑/创建/校验/渲染一体化 facade；typed PresentationML（含 timing/transition/notes/comments） | 写：facade“拥有包保留（package preservation）”，细节未核实；曾有设计文档指出 `Presentation` 一度无新建构造函数（靠内置 default.pptx 模板补），成熟度存疑 | 纯 Rust，无 sidecar；workspace 含 22 个本地包，依赖面不小 | 有野心但极年轻、文档驱动感强，社区几乎为零。来源：[rpptx](https://crates.io/crates/rpptx/0.2.0)、[rpptx-oxml](https://crates.io/crates/rpptx-oxml)、[rdocx](https://github.com/tensorbee/rdocx) |
| **ooxml / ooxml-pml（pterror）** | Rust | Apache-2.0 | v0.1 alpha，功能自述“核心读写 API 可用”；9★，建仓 2026-01-20，最后推送 2026-08-29（近 3 个月无推送） | 读：PresentationML；特性开关含 masters/animations/transitions/notes/comments/charts | 写：有，但往返保真度、未动 part 是否保留**未核实** | 纯 Rust，无 sidecar | 几乎无采用量，维护已放缓；只能作技术参考。来源：[crates.io](https://crates.io/crates/ooxml-wml)、[GitHub](https://github.com/pterror/ooxml) |
| **adapters-ooxml（stichos 工具链）** | Rust | MIT OR Apache-2.0 | 0.2.2；crates.io 已发布，但**仓库目前仍私有**（github.com/reinartz/stichos，公开上线待定），源码不可审计；下载量未核实 | 读 docx/xlsx/pptx 到 IR（返回序列化 IR JSON，非 live 结构）+ 保真度诊断 | 写：**`SurgicalWriter` 字节级手术写回，保留未动 part 的包与 ZIP 元数据**——与 office_oxide 并列最贴合“手术式补丁”；不支持加密包；不做排版/渲染 | 纯 Rust `zip` crate，无强制外部二进制；`engines` 副 crate 会 spawn LibreOffice/Chromium 子进程（渲染用，格式层本身不用） | 设计最贴合，但私有仓 + IR 间接层是硬伤；只能等公开或谈合作。来源：[crates.io](https://crates.io/crates/adapters-ooxml/0.2.2) |
| **OpenPresent（casual-slide 引擎）** | Rust（引擎编译为 WASM 跑在浏览器/桌面壳里） | Apache-2.0 | **Early preview**；自称 66 个真实 PowerPoint  deck 打开保存后“每个 XML part 字节相同”、8,739 个格式元素逐行建模；**明确声明输出尚未用 PowerPoint 本身对照验证**（对照基准是 LibreOffice）；**仓库地址与 stars 未核实**（官网外链未暴露完整地址） | 读：形状/文本/图片/表格/图表/SmartArt/主题进统一模型，未建模部分字节保留 | 写：保存时只 patch 动过的部分；未编辑文件保存回相同字节；含宏的 .pptm 宏项目原样保留；动画放映、表格/图表编辑、评论**尚未实现** | WASM 引擎可嵌 Tauri WebView 或编译为原生 Rust 库复用；无 sidecar、无服务端 | 引擎设计与 taoffice 需求重合度最高，但成熟度与可审计性是短板，列为头号观察对象。来源：[官网](https://slides.casualoffice.org/index.html) |
| **ppt-rs（yingkitw）** | Rust | Apache-2.0 | 0.2.37（crates.io 最新提及）；52★，建仓 2025-11-26，最后推送 2026-11-13 | 读：自称 python-pptx 的 Rust 移植，可读/改现有文件；Markdown/HTML 导入、PPTX→HTML、修复损坏文件 | 写：有（新建为主）；手术式保留**未核实**，无相关承诺 | 纯 Rust + 可选 MCP server（二进制是 stdio 进程，格式层不用它即可）；体积未核实 | 生成向为主，编辑保真度无证据；备选。来源：[crates.io](https://crates.io/crates/ppt-rs)、[GitHub](https://github.com/yingkitw/ppt-rs) |
| **@office-open/pptx（DemoMacro/office-open）** | TypeScript（Node / 浏览器 / Deno / Bun） | MIT | **0.15.1**，约 2026-10-29 发布；42★，建仓 2026-04-14，最后推送 2026-11-09 | 读：`parsePresentation` 解析为 JSON 模型（自称 100% OOXML 覆盖，厂商口径） | 写：`generatePresentation` 新建 + `patchPresentation` 补丁；官方措辞是“未编辑的规范字段保留源往返事实”，并明说 patch“不成其为通用包编辑器”——**是模型级往返，不是字节级手术补丁**；PPT 生成“有意不支持” | 纯 TS，npm 直引，跑在 Tauri WebView/前端，无 sidecar；包体积未核实 | 对“文本替换 + 新建”口径可用，但保真语义弱于 office_oxide；且项目仅 42★、7 个月历史。来源：[npm](https://www.npmjs.com/package/@office-open/pptx)（本次 npm 页访问被拒，数据取自 npm.io 镜像）、[补丁文档](https://www.office-open.com/en/pptx/patch)、[GitHub](https://github.com/DemoMacro/office-open) |
| **PptxGenJS** | JS/TS | MIT | **4.0.1**；6,382★，建仓 2016-02-23，最后推送 2025-11-28；周下载约 75,000+（二手来源口径） | **无读 API——确认只能新建**（README/文档只有创建；社区通行做法是“新建用 pptxgenjs、编辑走原始 XML、读取用 markitdown”）；v4 有 API 漂移记录（常量重命名） | 写：新建能力最成熟（母版/图表/表格/HTML 表转幻灯片）；对已存在文件的写回能力为零，保真度不适用 | 零运行时依赖（内置 JSZip），ESM+CJS，可直接跑在 React 前端；体积小 | 只能承担“新建”一半口径，不能读改。来源：[npm](https://www.npmjs.com/package/pptxgenjs)、[GitHub](https://github.com/gitbrent/PptxGenJS) |
| **nodejs-pptx（`nodejs-pptx`，非被抢注的 `node-pptx`）** | JS | MIT | **1.2.5（2025-09-26）**；周下载约 5.9k–9.7k（Snyk 两次抓取不一致）；Snyk 判定维护 Inactive；**GitHub 仓库地址未核实**（API 查询无返回） | 读：`load()` 载入已有文件 | 写：可改已有文件（增删/重排幻灯片、加文本/图片/形状；图表仅概念验证；音视频不支持；母版应用 TODO）；保存时是否保留未动 part **未核实**，无相关承诺 | 纯 JS，体积小 | 能读写但半停滞、无保真承诺；不建议作主依赖。来源：[npm](https://www.npmjs.com/package/nodejs-pptx)、[Snyk](https://snyk.io/advisor/npm-package/nodejs-pptx) |
| **PPTXjs（meshesha）** | JS（jQuery 插件） | MIT | 279★，最后推送 **2022-03-26**（已停滞 4 年多） | 读：解 ZIP + 解析 XML 转 HTML/SVG，支持文本/形状/媒体/图表（D3/NVD3） | **无写能力——确认只读渲染** | 依赖 jQuery 1.11.3 + JSZip 2.x（v3 不兼容）+ D3 v3，技术栈陈旧；纯前端，无 sidecar | 只可作渲染参考，且已停滞。来源：[GitHub](https://github.com/meshesha/PPTXjs)、[文档](https://pptx.js.org/pages/docs.html) |
| **PptxViewJS（`pptxviewjs`）** | JS | MIT | 1.1.x（1.1.9 在用）；npm/jsDelivr 可查，stars 未核实 | 读：Canvas 渲染整份 PPTX | **无写能力，只读渲染** | 纯前端 Canvas，无 sidecar，体积小 | 渲染层最省事的现成选择。来源：[jsDelivr](https://www.jsdelivr.com/package/npm/pptxviewjs) |
| **python-pptx（仅参考）** | Python | MIT | **1.0.2（2024-08-07）**，3,585★，最后提交 2024-08-07（已 2 年多无发布）；13 年历史最成熟的读写模型 | 读：母版/版式/占位符/文本框/表格/图表/备注 | 写：原地改 run，保留主题/母版；动画无 API，无渲染 | **Python 运行时不符合约束**（Tauri 应用内无 Python；要跑只能 sidecar 或嵌入解释器，二者皆禁） | 作“读写语义正确性”的参照实现，不进入选型。来源：[GitHub](https://github.com/scanny/python-pptx) |
| **pptxcraft** | Rust | **AGPL-3.0-only ⚠️** | 0.1，API 演进中 | **无读/改 API——确认仅新建** | 写：仅新建 | 纯 Rust | AGPL 分发风险 + 功能不符，直接排除。来源：[docs.rs](https://docs.rs/pptxcraft/latest/pptxcraft/) |
| **Aspose.Slides（商业）** | .NET/Java/C++/Node.js via Java 等 | 商业许可，Slides 起价 **US$999**；另有新出的 **FOSS C++ 版 MIT** | 商业版 25.4（2026 年）；FOSS C++ 版 12★，建仓 2026-03-19，最后推送 2026-10-22 | 读：完整 | 写：商业版读写转换全功能；FOSS 版可读写 PPTX、未知 XML part 原样保留，但**无图表/SmartArt/OLE/动画/过渡/超链接/VBA/签名，无 PDF/HTML/SVG/图片导出** | 商业 Node.js 版走 Java（需 JVM 运行时）；FOSS C++ 需 C++20 编译 + FFI 接入，**不符合“Rust 或 TS 库编译进应用”的约束**；未授权版有水印 + 读文本截断 | 商业版贵且引入 JVM；FOSS 版太新太窄。仅作备选观察。来源：[定价](https://purchase.aspose.com/pricing/)、[FOSS C++](https://products-qa.aspose.org/slides/cpp/)、[GitHub](https://github.com/aspose-slides-foss/Aspose.Slides-FOSS-for-Cpp) |
| **LibreOffice / OnlyOffice（排除）** | C++/JS | LibreOffice MPL-2.0；OnlyOffice DocumentServer 社区版 **AGPLv3**（20 并发连接上限），Desktop Editors AGPL-3.0 | 均成熟（LibreOffice 26.8.x；OnlyOffice Docs 10.0.0，2026-10） | 读：完整 | 写：完整，保真度业界标杆 | **LibreOffice 需 `soffice --headless` 子进程（sidecar），数百 MB——违反硬约束**；OnlyOffice DS 是 5 服务服务端（≥8GB RAM）+ AGPL 网络传染风险，同样出局 | 成熟但架构与许可双双不符，只能作渲染对照基准。来源：[OnlyOffice/LibreOffice 对比研究](https://github.com/kutupbt/kutup/blob/HEAD/docs/research/04-office-collab-engines.md) |

另注（未进主表）：`js-pptx2`（0.1.1，四年前停滞，早期开发，保留已有内容但不能查询/编辑已有幻灯片）；`officegen`（仅新建，老）；OpenPresentation `@openpresentation/opf-pptx` 0.34.0（MIT，JSON 模型生成 + 导入，非手术编辑器）；`@file-viewer/pptx`（flyfish-dev，新 TS 渲染器，Worker 解析，成熟度未核实）；`ibisOffice`（新 Rust 办公套件，自称 7 万+像素对照测试，仓库与许可未核实，暂不采信）。

## 判断：混合路线，craft 降级为储备

**推荐：格式层用 `office_oxide`，渲染层用成熟 JS 只读渲染库（PptxViewJS 首选，PPTXjs 备选），新建能力由 `office_oxide` 的 `PptxBuilder` + PptxGenJS 兜底；craft 路线降级为技术储备与渲染参考；OpenPresent 列为头号观察对象。**

理由：

1. **当前口径决定胜负手是“手术式文本替换”，不是模型广度。** `office_oxide` 的 `EditableDocument.replace_text` 正是这个操作，且是本次唯一在官方文档中承诺“未动 OPC part 原样复制”的已发布 crates.io 库（0.1.x，~149k 月下载，52 个依赖 crate，纯 Rust 零原生依赖，1.5MB）。craft-pptx 的模型更广（母版/版式/节），但当前口径用不上；它的“kept parts”无独立佐证，且全程 git-rev、无 crates.io 发布，供应链风险是三者中最高的。
2. **渲染与格式解耦。** PPTX 渲染最难的是像素保真，DeckCraft 的 render crate 与 OpenPresent 的渲染器都是 alpha；与其赌一个 alpha 渲染器，不如先用 PptxViewJS（MIT、Canvas、已在多个产品中使用）做只读渲染，渲染保真度不足之处在 UI 层明示即可。待任一 Rust 渲染器通过对照测试后再替换。
3. **新建不需要 craft。** 新建 = 空模板 + 加幻灯片/文本，`PptxBuilder`（office_oxide）或 PptxGenJS（最成熟的新建库，75k 周下载）都能覆盖；PptxGenJS 甚至可直接跑在 React 前端，零 Rust 成本。
4. **craft 仍有价值，但不是现在。** 若未来口径扩展到“像素级画布编辑 / 母版编辑 / 动画编辑”，`office_oxide` 的 `replace_text` 天花板会立刻见顶，届时唯一有完整编辑器形态的开源路线就是 DeckCraft/OpenPresent 这一系。保留 craft 作为观察对象，成本只是一个定期复核。

前提条件（缺一不可，否则结论失效）：

- **Spike 验证 office_oxide（1–2 天）：** 在真实用户 PPTX 语料上跑 `replace_text`：跨 run 的占位符、母版/版式占位符文本、图表内文本、SmartArt、备注页是否覆盖；保存后用 PowerPoint/LibreOffice 打开无修复提示；未动 part 的字节 diff 是否为零；`PptxEditor`/`PptxBuilder` 能否新建与增删幻灯片。若覆盖不足，结论改判。
- **Spike 失败的回退：** 对照 spike craft-pptx 与 adapters-ooxml（若 stichos 届时已公开），以同一语料 + 同一字节 diff 标准打分，不凭感觉选。
- **OpenPresent 跟踪：** 待其仓库可公开审计、且通过 PowerPoint 对照测试后，重新评估它替代 office_oxide 成为长期格式层的可能性（它的引擎设计与 taoffice 需求重合度最高）。
- **许可证复核：** office_oxide 的 GitHub API 字段只显示 Apache-2.0，文档称 MIT OR Apache-2.0——接入前以仓库 LICENSE 文件为准确认双许可；craft 同理。
- **渲染预期管理：** PptxViewJS 的渲染与 PowerPoint 有差距（字体/图表/SmartArt），v1 只承诺“查看”，不承诺“所见即所得”。
