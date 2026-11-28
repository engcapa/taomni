# Taomni taoffice — XLSX 库调研 vs storytold craft 路线

调研日期：2026-11-15（北京时间）。数字均来自当日本文列出的来源；查不到的写“未核实”，不凭记忆编造。
硬约束复述：Rust/TS 库编译进应用，不接受 sidecar；单插件包 ≤100 MB；手术式补丁（未动部件字节不变）；许可证须能进 MIT 项目分发，GPL/AGPL 单独标风险。

## 对比表

| 库 | 语言 | 许可证 | 成熟度（版本/发布日期/下载量或 stars） | 读 | 写 / 保真度 | 体积 / 集成 | 备注 / 来源 |
|---|---|---|---|---|---|---|---|
| calamine | Rust | MIT（GitHub API） | v0.38.0，2026-11-02（Changelog）；GitHub 2,470★，创建 2016-06-24，最后 push 2026-11-14；lib.rs 月下载约 1.0M；519 个 crate 依赖它（lib.rs 旧快照） | ✅ 强：xlsx/xlsm/xlsb/xls/xla/xlam/ods；读值、公式缓存值、0.38 新增单元格样式读取；流式读 | ❌ 无写。只读库，不能做真编辑 | 纯 Rust，无 sidecar；体积未核实（小，zip+quick-xml 系依赖） | 最稳的读层。公式不重算，只返回缓存值。来源：https://github.com/tafia/calamine ；https://lib.rs/crates/calamine ；https://raw.githubusercontent.com/tafia/calamine/master/Changelog.md |
| umya-spreadsheet | Rust | MIT（GitHub API） | v3.1.1（crates.io 最新见到的版本，发布日期未核实）；v3.0.1 2026-07-13，v3.0.0 大版本 breaking；GitHub MathNya/umya-spreadsheet 495★，最后 push 2026-11-14；lib.rs 月下载约 128K–149K（两次快照不一致） | ✅ xlsx/xlsm 读；样式、公式、合并、图表（部分）、透视表（基础创建） | ⚠️ 读写都有，但**全量重写**：读入对象模型再整体写出，未动部件不保证字节不变。已知问题：图表损坏、注释丢失、透视表读不到（第三方评估引述）；条件格式写出曾不能被 openpyxl 回读；图片读路径曾返回空 | 纯 Rust，无 sidecar；API 面大，性能比 calamine+rust_xlsxwriter 慢（第三方评估）；体积未核实 | Rust 唯一较成熟的读写一体库，可做“重度改写/新建”路径，不可做手术式补丁。来源：https://github.com/MathNya/umya-spreadsheet ；https://crates.io/crates/umya-spreadsheet/3.1.1 ；https://docs.apollia.fr/architecture/decisions/ |
| rust-xlsxwriter | Rust | Apache-2.0（GitHub API） | v0.101.0，2026-10-21；v0.100.0 2026-10-17；GitHub jmcnamara/rust_xlsxwriter 602★，open issues 仅 3，最后 push 2026-11-15；lib.rs 月下载约 618K–778K（两次快照不一致） | ❌ 不读 | ✅ 只写新建 xlsx：值/日期/公式/样式/图表/条件格式等，作者同为 Python XlsxWriter 作者；**明确不能修改已有文件** | 纯 Rust，无 sidecar；常数内存/低内存写模式；体积未核实 | 只能做“新建/导出”路径，不能做编辑。来源：https://github.com/jmcnamara/rust_xlsxwriter ；https://github.com/jmcnamara/rust_xlsxwriter/blob/HEAD/CHANGELOG.md |
| SheetJS（xlsx，社区版） | JS/TS | Apache-2.0（社区版） | 社区版 npm 停在 0.18.5（2022，含已知安全漏洞）；CDN/GitHub 最新 0.20.3（2024-07-18 打 tag；多家 2026 年综述称 0.20.3 为最新，2026-01-12 仍有更新说法，未核实）；GitHub SheetJS/sheetjs 36,343★，但 GitHub 镜像最后 push 2024-04-18，主站已迁 git.sheetjs.com；npm 周下载约 7.8M（PkgPulse 2026-02 二手数据，未核实） | ✅ 最广：xlsx/xlsm/xls/ods/csv 等 20+ 格式，解析稳健 | ⚠️ 社区版只做数据 interchange：**无样式写出**（样式要 Pro 或 xlsx-js-style fork）；无公式求值（Pro 才有）；读后写出是重建，非手术式补丁；图表/透视表/图片要 Pro | 纯 JS，可进 Tauri 前端，无 sidecar；体积未核实 | 成熟但分发已离 npm：生产用须走 CDN/tarball 或第三方 fork，供应链别扭；真编辑不够。来源：https://github.com/SheetJS/sheetjs ；https://www.pkgpulse.com/guides/sheetjs-vs-exceljs-vs-node-xlsx-excel-files-node-2026 |
| ExcelJS（上游） | JS | MIT | 上游 v4.4.0，2023-10-19（2026-07-31 现实核查引述；npm 最后修改 2024-12-20 的说法并存）；GitHub exceljs/exceljs 15,517★，830 open issues，最后 push 2025-01-21，维护者自述 inactive | ✅ 读 xlsx/csv，样式/公式缓存值/合并/图片 | ⚠️ 写是全量重建，非手术式补丁；支持样式、图表（有限）、透视表（有限）；无公式计算引擎 | 纯 JS，无 sidecar；支持流式读写大文件；体积未核实 | 上游已停滞。不要直接用上游 4.4.0。来源：https://github.com/exceljs/exceljs ；https://github.com/burakdede/lorepack/issues/113 |
| ExcelJS 社区分支 exceljs-community | JS | MIT | v5.2.1，2026-10-19；v5.0.0 2026-08-10（要求 Node 22.12+）；GitHub xcybplx/exceljs-community 仅 4★，创建 2026-08-08，1 open issue | 同上游 | 同上游（drop-in 替代 4.4.0） | 同上游 | 维护恢复了，但 3 个月历史、个位数 stars、单人维护，成熟度未建立；可作备选观察，不可作首选。来源：https://github.com/xcybplx/exceljs-community/blob/HEAD/CHANGELOG.md |
| Univer（核心） | TS | Apache-2.0（核心） | v1.0.2，2026-09-24（首个 1.x）；GitHub dream-num/univer 24,605★，2,240 forks，最后 push 2026-11-14 | ⚠️ 核心本身不含 .xlsx 导入 | ❌ 开源核心**无 .xlsx 导入/导出、无图表、无透视表、无打印、无协作、无编辑历史**——全在商业 Pro 层 | TS SDK，Canvas 渲染，自带公式引擎；bundle 大（定性，未核实具体 KB）；无 sidecar，但 Pro 导入/导出是**服务端转换服务**，需自托管服务器实例 | 分界已核实：Pro Business $99/月起，Freemium 每月仅 10 次导出；导入不限但要 Pro 服务。Univer 工作格式是自有 JSON 模型，不是 OOXML 原生，往返是转换不是手术补丁；离线桌面 + 手术补丁要求下不适配。来源：https://github.com/dream-num/univer ；https://univer.ai/ ；https://staging.univer.plus/pricing/ ；https://docs.doconda.com/compare/univer |
| IronCalc | Rust（+WASM/TS/Python 绑定） | MIT OR Apache-2.0（双许可） | v0.9.1，2026-10-21；v0.9.0 2026-10-15；GitHub ironcalc/IronCalc 4,274★，创建 2023-11-20，最后 push 2026-11-14；crates.io 上 ironcalc_base 快照仍是 0.7.1（2026-01-25，滞后，未核实最新 crates.io 发布）；约 500 个函数 | ✅ xlsx 导入（流式解析，v0.9 改进大文件） | ⚠️ xlsx 导出有，但**模型重建式写出，非手术式补丁**；官方未支持功能页明言：图表在研（不在 1.0 计划内）、透视表仅计划中、协作在研；模型外特性可能丢失，需实测 | Rust 直编进 Tauri 或 WASM（@ironcalc/wasm、@ironcalc/wasm-xlsx）；无 sidecar；体积未核实 | 最好的 Rust 公式引擎候选：动态数组、LET/LAMBDA、约 500 函数、Excel 兼容为 bug 标准、NLnet/欧盟资助、2 人核心评审。仍 pre-1.0。来源：https://github.com/ironcalc/IronCalc ；https://docs.ironcalc.com/features/unsupported-features.html ；https://blog.ironcalc.com/2026/10/15/Changelog-v0.9.html |
| Luckysheet | JS | MIT | **已归档 EOL：2025-10-30 被 owner 归档，只读**；GitHub dream-num/Luckysheet 16,624★，2,596 forks，最后 push 2025-08-19；官方继任者为 Univer | — | — | — | 排除。来源：https://github.com/dream-num/Luckysheet ；https://blog.univer.ai/posts/univer-vs-luckysheet-a-comprehensive-comparison-of-open-source-spreadsheet-solutions/ |
| Handsontable | JS | 商业许可（≥13 版商业用需付费；MIT 线止于 6.2.2） | v18.1.2（2026-10-08，二手数据）；本身不是 .xlsx 库 | ❌ 无原生 .xlsx 读 | ⚠️ 导出 xlsx 靠 ExcelJS peer 依赖（^4.4.0），新建式导出，非手术补丁；公式靠 HyperFormula 插件 | 前端网格；体积未核实 | 与 .xlsx 文件本身无关，是数据网格 + 导出插件；不列为格式层候选。来源：https://pr-12807.handsontable-docs-staging.pages.dev/docs/angular-data-grid/export-to-excel/ |
| craft-xlsx（storytold craft-libs） | Rust | MIT OR Apache-2.0（craft-libs 双许可；GitHub API 仓库 license 栏只列 Apache-2.0） | v0.1.0（首个协调发布，git tag，未上 crates.io）；craft-libs 创建 2026-10-09，424★，562 open issues，最后 push 2026-11-15；Rust 1.95+ | ✅ 读：xlsx/xlsm/xltx/xltm + xlsb，流式读行；另有 craft-xls 读 BIFF8 .xls | ❓ **写能力未核实**：craft-libs README（镜像）对 craft-xlsx 的描述只讲读取（workbook/sharedStrings/styles/流式行），未见 writer/save API；GridCraft 应用自有 crates/xlsx 做保存 + passthrough，但那是应用代码，不是 craft-xlsx crate。不能把 GridCraft 的保存能力算到 craft-xlsx 头上 | git-rev 依赖，无 crates.io；无 sidecar；体积未核实 | 供应链最弱一环：无 crates.io、6 周历史、562 open issues。来源：https://github.com/storytold/craft-libs ；https://git.dyakov.space/artcraft/craft-libs |
| GridCraft（应用仓，calc/formula/functions） | Rust（egui UI） | MIT OR Apache-2.0 | v0.16.1，2026-11-05；v0.16.0 2026-11-03；GitHub storytold/gridcraft 7,537★（2026-11-15 API），创建 2026-10-07，**2,257 open issues**；自评 alpha、“核心流程端到端能跑，约 50% ready for real work” | ✅ xlsx 原生；.xls 仅值/公式/数字格式，格式化与对象未完成 | ⚠️ 自认短板：图表往返丢类型与选项（图表模型只有标题/图例/两选项/轴标题）、透视表 45% ready、无 slicer/timeline/数据模型、部分未建模内容保存时丢弃、未在真实语料 + 真实 Excel 上验证输出无修复提示；PR #881 曾修 core properties 保存丢失 | Rust 应用，非库；UI 是 egui，按既定决策 UI 不复用；体积未核实 | stars 高但 open issues 极多、自评 50%、未过真实语料验证。函数数 513/523 是 parity 清单数，不是已验证实现数（README 自注）。来源：https://github.com/storytold/gridcraft ；https://github.com/storytold/gridcraft/blob/main/docs/gaps.md ；https://github.com/storytold/gridcraft/blob/f1894c6da64d4326022ae644c767581816a23c2c/ROADMAP.md |
| rxls（新增发现） | Rust | 未核实（crates.io 页未在本次检索中显示许可证，勿当作已核实） | 0.1.2 为兼容候选，crates.io 标注“直至 v0.1.2 打 tag 发布前”；极早期 | ✅ .xls（BIFF8/5/7）、.xlsx、.xlsb、.ods 读入统一 cell 模型 | ✅ **唯一明确宣称手术式补丁的库**：只改 xlsx/xlsm，arena XmlTree 原地改 worksheet/workbook XML，未动部件 byte-for-byte 回写；.xls/.xlsb/.ods 只读；自测语料 916 文件开 869 个 | 纯 Rust，无 JVM/POI/subprocess；体积未核实 | 最贴合“手术式补丁”要求，但 0.1.x、作者与下载量未核实，必须先做代码审计 + 语料实测才能用。来源：https://fastly-app.crates.io/crates/rxls/0.1.2 |
| xlsxcraft（新增发现） | Rust | **AGPL-3.0-only ⚠️** | 0.1，API 演进中；Rust 1.89+ | ❌ 不读、不改已有模板 | ✅ 只写新建 xlsx，含图表/绘图/富文本 | 纯 Rust，无 sidecar | AGPL 与 MIT 项目分发冲突，**排除**，除非另购商业许可。来源：https://crates.io/crates/xlsxcraft |
| poirot / xls crate（新增发现，.xls 补充） | Rust | 未核实 | poirot：docs.rs 有文档，版本未核实；xls crate（zemse/xls）：0.1 pre-release，自称唯一纯 Rust BIFF8 写库，450+ 函数，动态数组/LAMBDA 推迟到 v1 之后 | ✅ poirot：xlsx/xls 输入；xls crate：xls/xlsx 读 | ⚠️ poirot 保存只出 xlsx，且图表/绘图/宏/富样式等未建模特性省略；xls crate：xls 可写回（BIFF8），但 0.1 且未核实 | 纯 Rust，无 sidecar | .xls 只能做到读 + 转 xlsx；写回 .xls 只有未经核实的 0.1 候选。来源：https://docs.rs/poirot/latest/poirot/ ；https://fastly-app.crates.io/crates/xls |

## .xls（二进制 BIFF）小结

| 能力 | 库 |
|---|---|
| 读 .xls（值/公式/格式） | calamine（最稳）、craft-xls（读 BIFF8，未核实写）、GridCraft（值/公式/数字格式，格式化与对象未完成）、Rust xlrd 0.1.1（读 BIFF8 → 转 umya 的 xlsx 结构，见 https://docs.rs/crate/xlrd/0.1.1）、rxls（BIFF8/5/7）、poirot、xls crate |
| 写回 .xls | 只有 zemse/xls crate 自称纯 Rust BIFF8 写库（0.1 pre-release，未核实）；其余均无。建议策略：.xls 只读，编辑后另存为 .xlsx，不承诺写回 .xls |
| .xlsb | 读：calamine、craft-xlsx；写：无成熟 Rust 库（rxls 只读） |

## 判断

### 结论：不要把 craft 路线作为首选；采用混合路线，craft 只做观察/尖刺

理由（按权重排序）：

1. **手术式补丁是决定性要求，而 craft 路线在这一点上是未证实、最弱的。** 本次检索中，没有任何成熟库能完整满足“未动部件字节不变 + 公式/图表/透视表保留”。最接近的是新库 rxls（明确 byte-for-byte）和“自研 zip+quick-xml 补丁层”模式（Apollia 文档证实可行：只改目标 sheet XML、其余部件原样拷贝、删 calcChain 强制重算；他们评估后放弃 umya正是因图表损坏/注释丢失/透视表不读）。craft-xlsx 在检索到的描述里只是流式读取器，写能力未核实；GridCraft 虽有 passthrough.rs，但其 gaps.md 自认“部分未建模内容保存时丢弃”、图表丢类型、透视表 45%、未在真实语料上验证 Excel 无修复提示。把“手术式补丁”押在一个写能力都未核实的 alpha 库上，是本方案最大风险。
2. **成熟度差距是量级差距，不是几个月。** calamine（2016 年起，0.38.0，月下载约 1.0M）、rust-xlsxwriter（2022 年起，0.101.0，月下载约 0.6–0.8M）、SheetJS/ExcelJS（2012/2014 年起）与 craft（2026-10-07 建仓，v0.1.0，562 open issues）不在同一成熟度带。GridCraft 的 7,537★ 是 5 周内冲出来的关注度，同时有 2,257 个 open issues，自评仅 50% ready——stars 在此不能当作成熟度证据。
3. **公式引擎上 IronCalc 明显优于 GridCraft calc。** IronCalc：2023 年起，v0.9.1，约 500 函数且以“与 Excel 结果不同即 bug”为标准持续修正，动态数组/LET/LAMBDA 已落地，MIT OR Apache-2.0，可直接编进 Tauri（Rust 直引或 WASM），无 sidecar。GridCraft calc：513/523 只是 parity 清单数，README 自注“不是已验证实现数”，且 calc 正确性仍在 beta 待办（20–33 agent-hours）。两者都 pre-1.0，但 IronCalc 有 3 年历史、NLnet/欧盟资助、持续 3 年的函数正确性积累；GridCraft 只有 6 周。
4. **Univer Pro 不是“更稳的替代”，而是“不适配的替代”。** 它在绝对成熟度上最高（1.0.2、24,605★、公司化运营），但 .xlsx 导入/导出在 Pro 层且是服务端转换服务（自托管服务器实例、Business $99/月起、Freemium 月 10 次导出），工作格式是自有 JSON 而非 OOXML 原生，往返是转换不是补丁，且 bundle 大。Taomni 是离线桌面 + 手术补丁 + ≤100 MB 插件，Univer Pro 三项全撞线，只能做 UI/编辑器参考，不能做格式层。

### 推荐的混合架构（分层，各层只用其最稳的部分）

- **读 / 导入预览层：calamine**（Rust 直引）。最稳、读格式最广（含 .xls/.xlsb），只读正好匹配“读不破坏原文件”。
- **公式计算层：IronCalc base（`ironcalc_base` + `ironcalc` xlsx crate）**。Rust 直引进 Tauri；WASM 只作可选。先用它做公式求值与重算，不用它的 xlsx 导出做保存（模型重建会丢未建模内容）。
- **保存层：分两档，明确告知用户哪档会丢什么——**
  - （a）**手术式补丁（默认保存路径）：自研薄层，基于 `zip` + `quick-xml`**，只重写被改动的 sheet/workbook/sharedStrings/styles 等 XML 部件，其余部件原样拷贝、calcChain 删除；先以 rxls（0.1.2）做对照尖刺：若审计 + 真实语料测试通过，可用 rxls 替代自研层，省掉自研成本。两者都不是“读入模型再全量写出”，这是唯一能兑现“未动部件字节不变”的结构。
  - （b）**全量重建（新建文件 / 结构性大改 / 导出）：umya-spreadsheet**（Rust 唯一较成熟读写一体库）或 IronCalc xlsx 导出；保存前明确提示可能丢失图表/透视表/注释等未建模内容，并跑真实语料回归。
- **新建空白文件 / 报表导出：rust-xlsxwriter**（只写新建，极稳）。
- **UI：按既定决策 React 自研**，不复用 GridCraft egui UI，不引入 Univer（Pro + 服务端 + 自有模型）。
- **craft 路线处理：降级为观察 + 尖刺。** 钉住 craft-libs v0.1.0 tag 做一次性评估：只测 craft-xlsx/xlsb 读取保真与 GridCraft passthrough 在真实语料上的表现；同时跟踪其是否上 crates.io、是否出 beta、是否补齐 writer 与独立语料验证。在这三项全部满足之前，不把任何 taoffice 发布路径押在 craft 上。

### S3 三选一：从成熟度看哪个最稳

**绝对成熟度排序：Univer Pro ＞ IronCalc ＞ craft-xlsx + GridCraft calc。**

- **Univer Pro 最稳**（1.0.2、24,605★、4 年历史、公司化），但**不符合 Taomni 约束**（商业 Pro + 服务端转换 + 自有 JSON 模型 + 大 bundle），所以是“最稳但不能用”。
- **在满足约束的前提下最稳：IronCalc。** 3 年历史、v0.9.1、4,274★、约 500 函数、MIT OR Apache-2.0、Rust/WASM 直编、无 sidecar；短板是 pre-1.0、无图表/透视表、模型重建式导出（需配合手术补丁层使用，不能单独做保存）。
- **craft 路线最不稳。** 6 周历史、v0.1.0、git-rev、无 crates.io、562 open issues、GridCraft 自评 50% 且 2,257 open issues、写能力未核实、未过真实语料验证。它的唯一优势是“格式层 + 引擎层同源、理论上可做 passthrough”，但该优势目前是未兑现的承诺，不是已验证的能力。

### 前提条件（判断成立所依赖的）

1. “手术式补丁”是硬要求且优先级高于“一个库包办一切”——若放宽为“全量重建可接受”，则 umya + IronCalc 即可，craft 更无必要。
2. .xls 只读 + 转存 .xlsx 可接受；若必须写回 .xls，需另立项评估 zemse/xls（0.1，未核实）。
3. 体积（各库对 ≤100 MB 插件包的实际占用）本次未核实——Rust 侧 calamine/umya/rust-xlsxwriter/IronCalc 均为纯 Rust 小依赖，定性判断可进 100 MB，但须在原型期实测 release 包体积；Univer bundle 与 GridCraft 整体体积同样待实测。
4. rxls 与 craft-xlsx 写能力须以代码审计 + 真实语料（图表/透视表/宏/条件格式齐全的 .xlsx）实测为准，本报告不作采纳承诺。

### 工作表选择与编辑（2026-11-28）

Excel 模块 0.3.1 以 Microsoft 365 的活动单元格操作为参照。方向键逐格移动。F2 和双击进入可编辑单元格，光标位于原内容末尾，公式栏同步显示草稿。Enter 下移，Shift+Enter 上移，编辑时 Tab 右移，Shift+Tab 左移。Escape 放弃此次编辑并恢复单元格焦点。浏览状态的 Tab 可离开网格。Windows、Linux 和 macOS 在工作表拥有焦点时处理这些局部按键。[Microsoft Excel 键盘快捷方式](https://support.microsoft.com/en-us/office/keyboard-shortcuts-in-excel-1798d9d5-842a-42b8-9c99-9b7213f0040f)

公式、表头和汇总行支持选择及读取。无效数字保留输入草稿和就近错误提示，输入法组词期间保持编辑焦点。UI-INP-06、UI-INP-07、UI-KEY-04、UI-FOC-02 对应的操作与断言见 TC-TAOFFICE-019 和 TC-TAOFFICE-020。原生用例通过系统保存对话框生成副本并重新打开。
