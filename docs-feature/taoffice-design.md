# Taomni 综合文件查看与编辑：taoffice 设计文档

- 文档版本：v1.3（设计稿，非实现记录；v1.3 按成熟库横向对比改写首选路线：craft 降级为备选，混合成熟栈为首选，新增 §8.12，变更见文末修订记录）
- 日期：2026-11-15（北京时间）
- 对象仓库：`engcapa/taomni`，本地克隆 `~/workspace/taomni`，`main` 分支，HEAD `ee9f8062d`（Merge PR #814 feat/file-open-improve），`package.json` 版本 `0.5.9`
- 落点：本仓库 `docs-feature/taoffice-design.md`（v1.3），随同 ADR `claudedocs/adr-taoffice.md`
- 目标读者：Taomni 维护者 / 实现者 / 评审者
- 状态：待评审。§14 的用户确认有效；实现的前提是模块化 M0 插件运行时落地（§1.2），以及 §11 的 13 个 spike 通过。**在 M0 落地之前不启动插件实现**，只做 spike 与核心内的分发扩展点（§5.3）。

> 一句话：Taomni 从“代码编辑器 + 只能看 18 种纯文本的 SFTP 预览”改成“核心自带文本/代码/图片/压缩包查看编辑 + taoffice 插件家族按需查看编辑其余常用文件”。每个插件独立编译、独立版本、独立发布、独立下载安装，单个包 ≤ 100 MB；第三方能力只用编进应用的 Rust/TS 库，**不接受 sidecar 进程**（不跑 LibreOffice headless、OnlyOffice、ffmpeg 可执行文件等外部进程）。

## 0. 决策摘要（先看这页）

### 0.1 要做什么

- 核心（默认安装包，必带）：md、txt、html、代码文件、各类图片查看、压缩包查看 + 解压，外加一个“按类型分发 + 插件注册新类型”的查看器扩展点。
- 插件（一个一个独立模块，按需下载安装）：PDF、Word、Excel、PowerPoint、Visio、MS Project、视频/音频。每个插件独立 SemVer、独立编译、独立发布（`.taomni-plugin` 包 + `modules.json` 条目），只改一个插件就只发它。
- 文件来源：本地文件为主；远程 SFTP 文件沿用现状——下载成只读临时副本再看，不回写（§9.3）。
- 体积红线：**单个安装包 ≤ 100 MB**（核心包与每个插件包各自遵守）；超过红线的引擎方案直接否决，不靠“以后再瘦”蒙混过去。

### 0.2 核心边界（用户已决策，见 §14）

| 归属 | 内容 |
|---|---|
| 核心必带 | md、txt、html、代码文件（走现有 CodeWorkspace / 查看器文本编辑）、图片查看、压缩包查看 + 解压 |
| 插件（各一个） | PDF、Word（docx/doc）、Excel（xlsx/xls）、PowerPoint（pptx/ppt）、Visio（vsdx/vsd）、MS Project（mpp/mppx/xml）、视频/音频 |
| 等 M0 落地后再做 | 全部 7 个 taoffice 插件。M0 是模块化设计 v1.4 的插件运行时（宿主进程 + JSON-RPC + 动态 chunk + 模块商店），目前只有设计、没有代码 |

### 0.3 诚实预告：三处“真编辑 / 像原生一样渲染”在无 sidecar 约束下的真实含义

这三处是本设计最容易产生误解的地方，先写清楚，评审时按这个口径验收，不按“跟 Word/Visio 一模一样”验收：

1. **Office“真编辑”≠ 像素级 Word 克隆。** 不用 LibreOffice/OnlyOffice 这类引擎时，世上没有开源库能做到所见即所得的 Word/PPT 编辑。可实现的是：**在应用内改内容、保存回原格式，且只动改过的部分**（§8 的“手术式补丁”原则）。v1.3 的变化：五路成熟库横向对比后，首选路线从 storytold craft-xxx 改为混合成熟栈（§8.12）——DOCX 用 Office Oxide（`EditableDocument` 承诺手术式补丁）+ BetterOffice 优先 spike（yrs CRDT + React 组件），XLSX 用 calamine 读 + IronCalc 算 + 自研 zip+quick-xml 手术补丁保存，PPTX 用 office_oxide + PptxViewJS 渲染 + PptxGenJS 新建；craft 降级为备选/观察对象。手术式补丁是否兑现，需 spike S6/S11 实测（以真实文件为准，不以文档为准）。其中 Excel 最可行，Word 次之，PPT 最难（只能做文本替换 + 新建的口径不变）。
2. **Visio“像 Visio 一样渲染”没有开源库能完全做到。** 五路对比的结论：没有任何开源库在公开资料中证明能保真渲染 Visio 全部特性（ShapeSheet 公式求值、数据图形、容器/泳道、主题 + 变体、EMF/WMF 内嵌对象）。主路线改为 C++ 的 `libvisio`（MPL-2.0，LibreOffice 在用的解析器）编成 WASM 或 FFI 静态链接，口径是**尽力渲染 + 明确提示**（查看器角落标注保真度边界，并提供“在 Visio 中打开 / 导出 SVG/PDF 对照”出口）；`libvisio-rs`（0.2.1，GPL-3.0）只作隔离对照分支，不进主分发。spike S1 先拿真实文件验证保真度。
3. **.mpp 写回：2026 年 9–11 月出现了模板法开源写入器，但全是 alpha，不可作主路线。** `pymppwriter`/`mppwriter`（MIT，0.4.3，模板法）与 OfficeIMO.Project（MIT，3.6.0，需 .NET 运行时）都能写出 Project 可打开的 .mpp，但只支持 MPP14、日历/约束/基线不写、有损。Project 插件的编辑闭环仍是：读 .mpp → 编辑 → **保存为 .xml/.mppx（MSPDI），MS Project 可直接打开**，并在界面明示“另存为 XML，视图样式会丢失”；.mpp 写回列为 P3 跟踪项（§8.6、§8.12）。另纠正：`.mppx` 不是微软官方的独立格式，它就是 MSPDI XML 的别名，处理时按内容识别，不要只认扩展名。

### 0.4 成功标准（验收口径）

- AC-T01：核心包不带任何 taoffice 插件代码与引擎，卸载/禁用全部插件后核心查看器（文本/代码/图片/压缩包）照常工作。
- AC-T02：每个 taoffice 插件可独立安装、启用、禁用、卸载、回滚，核心无需重启；单个插件包 ≤ 100 MB。
- AC-T03：点开一个已安装插件负责的文件类型，进插件渲染器；未安装时进“未安装”占位页（插件名、简介、去商店安装），不白屏、不调系统应用（除非用户主动选“用系统应用打开”）。
- AC-T04：编辑保存走手术式补丁；回归语料库里的文件改后用原应用（Word/Excel/PowerPoint/Project/Visio）打开不报错、不丢未改内容（§12）。
- AC-T05：远程文件一律只读临时副本；压缩包解压拒绝 `..`/绝对路径/符号链接逃逸，有展开体积上限（防 zip 炸弹）。

## 1. 现状分析：已有什么，缺什么

### 1.1 通用查看器已经有了（main `ee9f8062d`，PR #813/#814）

- `src/lib/openFile/classifyFile.ts`：文件分 8 类（image / svg / text / markdown / html / pdf / source / binary），共约 70 个扩展名；但 `supportsFileViewer` 只认其中 5 类（image、svg、text、markdown、html）。
- `src/components/viewer/ViewerShell.tsx` + `src/stores/documentStore.ts` + Rust `src-tauri/src/viewer/*` 与 `commands/viewer.rs`：文本可编辑（上限 5 MB、硬上限 20 MB、256 KB 分段读）、图片上限 32 MB、HTML 走 `viewer_html_open` 的 token 沙箱、Markdown 已有编辑器且能导出 docx/pdf/png、代码类文件路由回 CodeWorkspace。
- `src/lib/openFile/index.ts`（`openFile`）：本地文件、远程只读副本（`source: "remote-temp"`）、邮件附件三种来源；已有按扩展名选处理方式的偏好（`preferences.associations`）、“用系统应用打开”兜底（`sftpOpenPath`）。
- **缺口**：PDF 虽然分了类，但不在支持列表里，现在是调系统应用；Office/Visio/Project/视频/压缩包没有任何查看器；图片只有 png/jpg/jpeg/gif/webp/bmp/ico/avif/svg，没有 tiff/heic；没有任何“插件注册新类型”的扩展点——每加一种类型都要改核心的分类与 `ViewerShell`。

### 1.2 模块化现状：运行时还没落地，taoffice 必须等它

- `refactor/modules-arch` 分支与 main 的 diff 目前只有文档（模块化设计 v1.5 版），没有插件运行时的代码；main 上的模块化设计是 v1.4（`docs-feature/taomni-modular-split-design.md`，基线 `1d2f5748`）。**2026-11-15 10:43 重新 fetch 核实：main 仍是 `ee9f8062d`，分支仍是 `d4ad575c3`，diff 仍只有文档。** 所以“模块化重构已经落地”在本设计里的准确含义是：重构正在按 v1.4/v1.5 的设计落地，taoffice 按它定好的接口形态（§7）设计；如果重构落地时接口有变，taoffice 的插件形态跟着变，不另起一套。
- v1.4 定好的插件形态（§5.0）：原生部分是独立宿主可执行文件 + stdio JSON-RPC 2.0（高带宽走 loopback WebSocket），前端是动态 `import()` 的独立 chunk，配 `module.json`，发布是 `.taomni-plugin` 包 + 分离签名，进 `modules.json`，`coreApiVersion: 1`。M0 的 G1–G10 验证门（macOS 签名拉起、Windows 拦截、Linux noexec、吞吐、崩溃清扫、热升级、篡改拒绝、核心-only 依赖闭包、RPC 契约）还没跑过。
- **结论**：taoffice 的 7 个插件全部排在 M0 之后。M0 之前只做两件事：§11 的 13 个 spike（验证库，不写插件），和核心查看器的分发扩展点（§5.3，不依赖插件运行时也能先合入）。

### 1.3 已有可复用的依赖（实测数，main `ee9f8062d`）

| 已有 | 位置 | 对 taoffice 的意义 |
|---|---|---|
| `zip` 4.6.1（仅 deflate）+ `flate2` | `src-tauri/Cargo.toml` | 压缩包核心与 OPC（docx/xlsx/pptx/vsdx 都是 ZIP 包）都能复用，不用新引 ZIP 库 |
| `image` 0.25（png；Linux 另有 jpeg） | `src-tauri/Cargo.toml` | 图片解码已有底子，tiff/heic 要另评估 |
| `docx` 9.15.3（JS） | `package.json` | 只用于 Markdown 导出 docx（生成），**不能解析/编辑已有 docx**，不要误以为 Word 编辑已有现成库 |
| Markdown 渲染 + Mermaid | `src/components/editor/workspace/MarkdownPreview.tsx` | md 查看已有，taoffice 不重做 |
| HTML 沙箱（token + 自定义 scheme 思路） | `src-tauri/src/viewer/html_*` | PDF/Office 的 HTML 渲染可复用同一套沙箱思路 |

### 1.4 一条红线：不接受 sidecar，意味着什么

- 不跑外部进程：LibreOffice headless、OnlyOffice Document Server、ffmpeg 可执行文件、7-Zip 可执行文件、任何“下载一个二进制、启动它、通过管道/HTTP 调它”的方案都不接受。
- 接受的是：**编进应用的库**——Rust crate 静态/动态链接进宿主可执行文件（如 `ffmpeg-next` 链接 `libav*`、PDFium 以共享库形式随包发布），或 TS/JS 库与 WASM 打进前端 chunk（如 pdf.js、Mediabunny、IronCalc WASM）。判断标准：用户双击文件时，Taomni 不拉起第二个应用进程。
- 代价写在前面：这条红线排除了市面上唯一成熟的高保真 Office/Visio 引擎，换来的是包体积可控、无外部进程生命周期管理、无服务器依赖。§8 的每个类型都按这条红线给出了“能做到哪一步、做不到哪一步”。

## 2. 目标、原则、非目标

### 2.1 目标

- 一个入口：文件浏览器、终端链接、SFTP、Tao Agent、邮件附件点开文件，都进同一个查看器路由（`openFile`），由类型分发到核心渲染器或 taoffice 插件。
- 核心包默认带最常用的：文本/代码/图片/压缩包；其余常用类型一个插件一个包，按需下载，不进默认包。
- 每个插件独立编译、独立版本、独立发布、独立下载安装、独立回滚；单个包 ≤ 100 MB。

### 2.2 原则

- **库集成，不从头造**：解析/编解码用已验证的 Rust/TS 库；自研只做三件事——类型分发、渲染/编辑 UI、手术式保存。渲染引擎、编解码器、公式引擎不自研。
- **手术式保存**：编辑时不把文件整体读进有损模型再全量重写；保留原包未动部件，只替换改过的部件（§8）。保存前先备份原文件到插件数据目录的回收站，失败可恢复。
- **查看先行，编辑分档**：每个插件先做到查看（P1），编辑按“结构化编辑可实现 → 块编辑可实现 → 画布编辑不可实现”分档，不承诺做不到的编辑。
- **离线优先**：全部渲染/编辑本地完成，不调云端转换服务；远程文件只读，不回传。
- **许可证先行**：GPL/LGPL/AGPL 的库先过合规评审再进依赖表（§8.6），不先写代码后补评审。

### 2.3 非目标（本设计不做）

- 不做 CAD（dwg/dxf）、不做 3D 模型、不做专业音视频剪辑（视频编辑只到裁剪/转码）、不做 OCR（截图插件已有 OCR 引擎，taoffice 不重复）、不做云端协同编辑、不做移动端查看器（`plugin-mobile` 另有设计）。
- 不做“用系统应用打开”的替代：那是已有的兜底，不是 taoffice 的功能。

## 3. 文件类型全目：比用户列出的更多常用类型

下表是 taoffice 的类型注册表草案（扩展名按小写归一；`*` 表示该行是本设计新增列举、用户原话未提到的常用类型）。“归属”一列是最终态，不是第一版全量。

### 3.1 文本、代码、数据（核心）

| 类型 | 扩展名 | 归属 | 现状 |
|---|---|---|---|
| 纯文本/日志/配置 | txt, text, log, ini, conf, config, env, properties, gitignore, editorconfig | 核心 | 已有（查看器文本编辑） |
| Markdown | md, markdown, mdown | 核心 | 已有（编辑 + 导出） |
| 代码 | ts, tsx, js, jsx, mjs, cjs, rs, py, go, java, kt, c, h, cpp, cs, swift, php, rb, sh, sql, css, scss, vue, svelte 等 | 核心 | 已有（路由到 CodeWorkspace） |
| 结构化数据 | json, jsonc, yaml, yml, toml, xml, csv, tsv | 核心 | 已有文本查看；CSV/TSV 表格视图是核心 P1（§5.2，不新起插件） |
| 网页 | html, htm | 核心 | 已有（沙箱预览） |

### 3.2 图片（核心查看；编辑只做旋转/裁剪/标注，P2）

| 类型 | 扩展名 | 归属 | 备注 |
|---|---|---|---|
| 常见位图 | png, jpg, jpeg, gif, webp, bmp, ico, avif | 核心 | 已有，32 MB 上限沿用 |
| 矢量 | svg | 核心 | 已有 |
| *照片/扫描 | tif, tiff | 核心 P1 | `image` crate 已支持 tiff 解码，需验证 |
| *苹果照片 | heic, heif | 核心 P2 | 需 `libheif` 绑定或 WASM 解码，spike 验证体积与许可 |
| *专业格式 | psd, raw（cr2, nef, arw, dng） | 不做（P3 候选） | 只有缩略图/元数据查看的价值，无编辑；需单独评审，默认调系统应用 |

### 3.3 压缩包（核心，查看 + 解压；优先级高于视频转码）

| 类型 | 扩展名 | 归属 | 备注 |
|---|---|---|---|
| ZIP | zip, cbz* | 核心 | `zip` crate 已有；写 zip（打包）P2 |
| 7z | 7z | 核心 | `sevenz-rust2`（Apache-2.0，纯 Rust） |
| TAR 及组合 | tar, tar.gz, tgz, tar.bz2, tar.xz, tar.zst | 核心 | `tar` + 各解压 crate 组合 |
| 单文件压缩 | gz, bz2, xz, zst | 核心 | flate2 / bzip2 / xz2 / zstd |
| RAR | rar | 核心（只读解压） | `rarchive`（MIT，纯 Rust，RAR5）为主，`unrar` 为老版本兜底；**只解压，永不写 rar**（§8.4） |
| *磁盘/光盘镜像 | iso | 不做 | 列目录即可的价值低，调系统应用 |

### 3.4 文档（插件，各一个）

| 类型 | 扩展名 | 插件 | 备注 |
|---|---|---|---|
| PDF | pdf | taoffice-pdf | 查看 + 标注/表单/页面操作；正文重排编辑不做 |
| Word | docx, doc, odt*, rtf* | taoffice-word | docx 真编辑（块编辑 + 补丁）；doc/odt/rtf 先转 docx 再看，编辑后存 docx（§8.1） |
| Excel | xlsx, xlsm, xlsb, xls, ods* | taoffice-excel | 真编辑最可行的一档（§8.2） |
| PowerPoint | pptx, ppt, odp* | taoffice-ppt | 查看 + 文本替换；幻灯片画布编辑不做（§8.3） |

### 3.5 图形与项目（插件，各一个）

| 类型 | 扩展名 | 插件 | 备注 |
|---|---|---|---|
| Visio | vsdx, vsdm, vstx, vsd, vss, vst | taoffice-visio | 像 Visio 一样渲染（spike + 许可评审前置）；编辑只做 XML 级简单项 |
| MS Project | mpp, mppx, xml（MSPDI）, mpx | taoffice-project | 读 .mpp → 甘特/表格查看；编辑后存 .xml/.mppx，不存回 .mpp |

### 3.6 音视频（插件，视频为主；音频并入同一插件）

| 类型 | 扩展名 | 插件 | 备注 |
|---|---|---|---|
| 视频 | mp4, m4v, webm, mov, mkv, avi, rm, rmvb, flv, wmv, 3gp | taoffice-video | 先播放（分三档，§8.7），再做裁剪/转码 |
| *音频 | mp3, wav, flac, ogg, m4a, aac | taoffice-video | 播放与波形查看，随视频插件一起发布，不单独立项 |

### 3.7 电子书与其它常见文件（列出，但不进第一版）

| 类型 | 扩展名 | 处理 |
|---|---|---|
| *电子书 | epub, mobi, chm | P3 候选：epub 是 ZIP+HTML，可复用 HTML 渲染；mobi/chm 只做提取文本查看 |
| *字体 | ttf, otf, woff, woff2 | P3 候选：只做字形预览 |
| *数据库文件 | sqlite, db | 不做：数据库客户端已有，taoffice 不重复 |
| *密钥/证书 | pem, crt, key | 不做：Vault 已有，taoffice 不碰 |


## 4. 优先级：核心 → 常用 → 极少用 × 复杂度

排序规则：先核心必带，再按“常用程度 ÷ 复杂度”排插件；压缩包高于视频转码（用户已定）；视频播放高于视频转码；查看高于同类型的编辑。

| 优先级 | 内容 | 查看 / 编辑 | 复杂度 | 依据 |
|---|---|---|---|---|
| P0 核心 | 查看器分发扩展点（§5.3）+ 压缩包查看/解压 + CSV 表格视图 + tiff 查看 | 查看 + 解压 | 低 | 已有 `zip`/`flate2`/查看器底子；压缩包是用户明确的核心项 |
| P1 插件 | PDF 查看 + 标注/表单；视频播放第一档 + 第二档（§8.7）；Excel 查看 + 真编辑 | 查看 + 标注 / 播放 / 真编辑 | 低–中 | PDF 库成熟；视频第一二档无原生代码；Excel 是三件套里唯一有真实编辑 UI 的 |
| P2 插件 | Word 查看 + 块编辑；视频第三档（avi/flv/wmv/rm 转码播放）；Project 查看（.mpp 读 + 甘特）与 .xml/.mppx 编辑 | 查看 + 块编辑 / 播放 / 查看 + 另存 XML | 中–高 | Word 需自研块编辑器 + 补丁；视频第三档要 `ffmpeg-next` 构建与体积 spike；Project 需自研甘特 + 调度重算（P2 后半） |
| P3 插件 | PPT 查看 + 文本替换；Visio 渲染；视频裁剪/转码编辑；heic/psd/raw 缩略图；epub/字体预览 | 查看 + 文本替换 / 渲染 / 编辑 | 高 | PPT 无画布编辑器；Visio 渲染 + GPL 许可待定；视频编辑是转码能力的延伸 |

不在表里的类型（§3.7 后两行）不排优先级，需要时另立项。

## 5. 核心模块：留在默认安装包里的全部

### 5.1 核心查看器（已有，taoffice 只加扩展点，不重写）

- 保留：`ViewerShell`、`documentStore`、Rust `viewer_*` 命令、文本编辑（5 MB/20 MB）、图片查看（32 MB）、Markdown 编辑与导出、HTML 沙箱、`openFile` 路由、远程只读副本、系统应用兜底。
- 新增（P0，核心）：CSV/TSV 表格视图（读前 N 行 + 虚拟滚动，不全量进内存）；tiff 查看（验证 `image` crate 解码）。

### 5.2 核心压缩包（新增，P0）

- 能力：列目录（流式，不全量进内存）、预览包内文件（文本/图片走现有查看器，大小受查看器上限约束）、解压到目标目录、解压单个文件；写 zip 打包 P2。
- 引擎（Rust，全部编进核心宿主）：`zip`（已有）+ `tar` + `flate2`（已有）+ `bzip2` + `xz2`（或纯 Rust `xz4rust`）+ `zstd`（或纯 Rust `ruzstd`）+ `sevenz-rust2`（Apache-2.0）+ `rarchive`（MIT，RAR5 解压）+ `unrar`（仅作老版本 RAR 兜底，见 §8.4）。
- 安全（必须做，不可后补）：拒绝绝对路径/`..`/符号链接逃逸；展开总体积上限与单文件上限（防 zip 炸弹）；流式解压；密码包先提示“需要密码或暂不支持”，不静默失败；解压进度/取消/断点续传走仓库 `AGENTS.md` 的下载规则同款状态机（进度、取消、恢复、校验）。

### 5.3 查看器分发扩展点（新增，P0，M0 之前就能做）

这是 taoffice 落地前核心必须先有的口子，否则每加一种类型都要改核心：

- `classifyFile` 的类型注册表从硬编码集合改成“核心内置类型 + 插件注册类型”：核心注册 text/markdown/html/image/svg/source/binary/archive/csv；插件安装时向核心注册它负责的扩展名与 `FileKind`（pdf/word/excel/ppt/visio/project/video/audio）。
- `ViewerShell` 按 `FileKind` 分发：核心 kind 走现有渲染器；插件 kind 在插件已安装时动态 `import()` 插件 chunk，未安装时渲染“未安装”占位页（插件名、简介、去商店安装按钮），不白屏。
- `openFile` 的偏好（`preferences.associations`）按扩展名扩展到新类型；“用系统应用打开”保留为每种类型的用户可选兜底。
- 该扩展点本身不依赖插件运行时（M0），可以先合入 main；插件真正注册进来要等 M0。

### 5.4 核心不做的事

- 核心不带任何 Office/PDF/Visio/Project/视频编解码引擎；核心的 `cargo tree` 与前端产物不得包含插件依赖（沿用模块化 v1.4 的 G9 闭包验证）。

## 6. 插件清单：7 个 taoffice 插件，各自独立

每个插件都是独立的 `taomni-plugin-taoffice-<slug>`，独立 SemVer、独立编译、独立发布、独立下载安装。`kind` 统一为新增的 `document`（模块化 v1.4 §5.1 的 kind 取值里没有文档类，需在 M0 落地时把 `document` 加进取值表与商店分类）。

| # | 插件 id | slug | 负责类型 | P | 含原生宿主？ | 前端 chunk？ |
|---|---|---|---|---|---|---|
| 1 | `taomni-plugin-taoffice-pdf` | taoffice-pdf | pdf | P1 | 否（纯前端 + Rust 结构操作可选） | 是（pdf.js + pdf-lib） |
| 2 | `taomni-plugin-taoffice-excel` | taoffice-excel | xlsx, xlsm, xlsb, xls, ods | P1 | 是（calamine/umya/IronCalc 引擎层） | 是（Univer Sheets 或自研网格） |
| 3 | `taomni-plugin-taoffice-video` | taoffice-video | mp4, m4v, webm, mov, mkv, avi, rm, rmvb, flv, wmv, 3gp；mp3, wav, flac, ogg, m4a, aac | P1 播放 / P3 编辑 | 是（P2 起：`ffmpeg-next` 解码层） | 是（播放器 + 转码任务 UI） |
| 4 | `taomni-plugin-taoffice-word` | taoffice-word | docx, doc, odt, rtf | P2 | 是（docx-rs / Office Oxide 解析与补丁层） | 是（docx-preview 查看 + 块编辑器） |
| 5 | `taomni-plugin-taoffice-project` | taoffice-project | mpp, mppx, xml（MSPDI）, mpx | P2 | 是（mpxj-rs 解析层） | 是（甘特/表格 UI，自研） |
| 6 | `taomni-plugin-taoffice-ppt` | taoffice-ppt | pptx, ppt, odp | P3 | 是（Office Oxide 文本替换层） | 是（PPTXjs 查看 + 文本替换 UI） |
| 7 | `taomni-plugin-taoffice-visio` | taoffice-visio | vsdx, vsdm, vstx, vsd, vss, vst | P3 | 是（libvisio-rs 或 libvisio 渲染层） | 是（SVG 渲染 + 页面/缩放/搜索） |

注：PDF 插件 P1 不含原生宿主也可先行；但为统一“插件 = 前端 chunk + 可选宿主”的形态，PDF 的结构操作（合并/拆分/加密）如需 Rust 实现（lopdf），再补宿主，不提前引入。

## 7. 插件形态、商店与发布（沿用模块化 v1.4，不另发明）

### 7.1 形态（v1.4 §5.0 DEC-1 选 A）

- 原生部分：独立宿主可执行文件 `taomni-plugin-taoffice-<slug>(.exe)`，核心在插件启用/首次使用时拉起；控制通道 stdio JSON-RPC 2.0（带 `apiVersion` 握手）；高带宽数据（视频帧）走宿主绑定的 `127.0.0.1` 随机端口 + 一次性 token 的 loopback WebSocket（复用现有 rdp/vnc 的模式）。
- 前端部分：独立 ES module chunk，主 WebView 内动态 `import()`；经核心通用命令 `plugin_invoke(slug, cmd, payload)` 调宿主，核心按 `module.json` 的命令清单与 `permissions` 校验后转发；chunk 必须用宿主提供的 React 与共享库（`react`、`react-dom`、`zustand`、i18n、`ipc` 等标 external），不各自打包一份。
- 契约：新增的两个库 crate 不用重造——复用 v1.4 的 `taomni-plugin-api`（协议与宿主 SDK）；插件宿主只依赖它与库 crate，不依赖核心 crate。
- **不是 sidecar**：宿主可执行文件是插件的原生部分、由核心拉起并统一回收（退出时清扫、崩溃限次重启），不是用户可独立运行的外部应用；第三方编解码/解析库是链接进宿主或打进 chunk 的库，不是宿主拉起的第二个外部进程。`ffmpeg-next` 链接的 `libav*`、PDFium 共享库、`libvisio` 静态链接都属于“库”，不是 sidecar。

### 7.2 `module.json`（每个插件一份，随包发布）

以视频插件为例（其余同构，只改 id/slug/类型/命令/权限/数据目录）：

```json
{
  "id": "taomni-plugin-taoffice-video",
  "slug": "taoffice-video",
  "name": "视频与音频",
  "version": "0.1.0",
  "coreApiVersion": "1",
  "kind": "document",
  "status": "stable",
  "platforms": ["windows-x86_64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"],
  "entry": { "host": "bin/taomni-plugin-taoffice-video", "frontend": "frontend/index.js", "protocol": 1 },
  "tabs": [{ "kind": "file-viewer", "title": "视频" }],
  "fileKinds": ["video", "audio"],
  "extensions": ["mp4", "m4v", "webm", "mov", "mkv", "avi", "rm", "rmvb", "flv", "wmv", "3gp", "mp3", "wav", "flac", "ogg", "m4a", "aac"],
  "commands": ["probe", "play-transcode", "transcode", "trim"],
  "permissions": ["fs.dataDir", "fs.readUserFile", "media.decode", "window.open"],
  "dataDir": "plugins/taoffice-video",
  "backupPaths": ["plugins/taoffice-video/cache-index.json"]
}
```

- 新增字段 `fileKinds` 与 `extensions` 是 taoffice 需要的：核心查看器靠它们做分发注册（§5.3）；v1.4 的 `module.json` 没有这两个字段，M0 落地时一并加上。
- `permissions` 取值由核心维护，插件不得自声明集合之外的值；`fs.readUserFile`（读任意用户选中的文件）是 taoffice 新增的取值，需单独评审——查看器读本地路径现在是核心命令直接读，插件化后读路径必须经核心校验（路径在用户已授权的打开范围内，不读 Vault、不读核心数据库）。
- 签名是包旁边的分离文件（`.minisig`），公钥只用核心二进制里内置的那一把；`module.json` 里不放签名与公钥（v1.4 §5.1）。

### 7.3 商店、下载与发布

- 商店：taoffice 插件在模块商店里单列“文档与媒体”分类；每个插件页写明负责类型、查看/编辑能力边界（如“PPT 仅文本替换”“Project 编辑后另存为 XML”）、包体积、版本。
- 下载：沿用仓库 `AGENTS.md` 的外部网络与下载规则——三种代理模式（应用代理默认 / 功能独立代理 / 无代理）、进度（已下载字节/总量/百分比）、取消、断点续传、后台下载、关闭对话框不取消任务、重开恢复进度、校验 checksum 后才发布完成件；失败/取消不替换正在用的版本。
- 发布：沿用 v1.4 §7.3——`.github/workflows/release.yml` 加插件矩阵（每个插件 × 四个发布目标；纯前端插件只出一份平台无关包），产物是 `.taomni-plugin` 包（zip，内含 `module.json` + 宿主 + 前端 chunk + `SHA256SUMS`）+ 分离 `.minisig`；只改一个插件时只发它 + 新的 `modules.json`（`sequence` 单调递增，防回滚；先传完所有包与签名，最后发布完整清单）。
- 版本：每个插件独立 SemVer，存在各插件的 `module.json` 与 `src-tauri/plugins/taoffice-<slug>/Cargo.toml` / `package.json` 里；`coreApiVersion` 第一版为 `1`，只在破坏插件接口时才升。

### 7.4 生命周期与缺失处理

- 沿用 v1.4 §5.2：`installed → enabled → disabled → uninstalled`；启用才注册类型、拉起宿主；禁用保留数据、结束宿主、不加载 chunk；卸载删代码、不删数据（除非用户显式勾“同时删除数据”）；启用/禁用/升级/回滚都不需要重启应用。
- 未安装插件负责的文件：查看器渲染占位页（插件名、简介、去商店安装按钮）；欢迎页恢复跳过该条并提示；编辑中的文档在插件被禁用/卸载时先提示保存/另存，不静默丢弃。
- 转码/解压等长任务：任务归属插件宿主，不随 UI 组件生命周期消失；应用退出时未完成的任务按“取消并保留安全中间态”处理，不留坏文件。


## 8. 各类型引擎：库、能力边界、许可证（2026-11-15 核实）

本节的库名与许可证是 2026-11-15 检索核实的；实现前仍需按 §11 的 spike 逐项复核版本与许可。**凡是写“不做”的，都是在无 sidecar 约束下的结论，不是偷懒。**

**v1.3 更新（2026-11-15）：五路成熟库横向对比后，本节的首选路线已改写——每格式的新首选见 §8.12 的总表；§8.1–§8.8 是各格式的详细分析（含被替换掉的旧首选的保留理由），§8.10/§8.11 的 craft 内容降级为备选/观察对象，不再是首选。**

### 8.1 Word（taoffice-word，P2）

- **v1.3 首选（§8.12）：混合路线——Office Oxide 作格式/补丁层 + BetterOffice 优先 spike。** Office Oxide（Rust，MIT OR Apache-2.0，v0.1.x，约 149K 次下载/月，纯 Rust 零原生依赖，约 1.5 MB）是三线共同的最大赢家：一个依赖覆盖 DOCX/XLSX/PPTX 三格式的读 + 手术式补丁，`EditableDocument` 明确承诺只重写动过的 OPC part、其余原样复制——三线调研中唯一在文档层面承诺手术式补丁的已发布库；但它很年轻（2026-03，0.1.x），编辑 API 只有 `replace_text`/`set_cell` 级（模板填充级），承诺必须用真实语料 spike 验证（S11）。BetterOffice（`betteroffice-docx` v0.5，Apache-2.0）是唯一现成覆盖“真编辑 + React 19 组件 + 纯 Rust + 无 winit 冲突”的方案（yrs CRDT、原子编辑批次、tracked changes、分页/布局、tiny-skia 光栅；保存复用未表示的包内容），优先 spike（S11）。craft-docx + WordCraft 降级为长期备选（§8.10/§8.11 保留作对照），每季度复评一次。
- 查看：`docx-preview`（TS，Apache-2.0，`renderAsync(blob, el)`，渲染页眉/页脚/脚注/表格/图片/编号，模仿打印页；长节只按文件中写的分页断开，不按 Word 的实际流式分页）为主；`mammoth.js`（BSD-2-Clause，约 60 KB）为辅（转干净语义 HTML，适合阅读/搜索/提取，**会丢视觉格式**，不作保真查看）。
- 编辑：块/富文本编辑器（自研，TipTap 风格）+ **手术式补丁**——解析 `word/document.xml` 成块树，每块保留原 XML 锚点与切片，只把改过的段落写回原 OPC 包，未动部件字节不变。参考模式：GenOffice `docx-engine`（Apache-2.0，但它是 Electron 应用内引擎、不是可安装的独立库，只能作架构参考）和 Office Oxide 的 `EditableDocument`（Rust，MIT OR Apache-2.0，v0.1.0，`replace_text` 时保留未动部件；非常新，需 spike 验证）。
- 生成新文档可用 `docx.js`（MIT）；它**不能**打开任意 docx、编辑后保存回原文件，不要误用。`docx-rs`（MIT，读 + 写模型，无排版/分页引擎、无编辑 UI）可作 Rust 解析层候选。
- 会丢的（写进插件页与验收，不承诺）：分页、文本框、SmartArt、图表、修订、复杂域、节格式、页眉页脚的复杂布局。
- 老格式：`.doc` 没有浏览器端渲染器；Office Oxide / WordCraft 声称可导入 `.doc` 转 docx——路线是**转成 docx 再看，绝不原地编辑 .doc**。`.odt` 查看可用 `@opendocument/odr-core`（MPL-2.0，只读）；**WebODF（AGPL、2015 年后停更）禁止捆绑**。`.rtf` 用 `rtf-parser`（Rust，MIT）解析 + `rtf-viewer` 渲染，只读；编辑走转 docx。
- 不采用（写明原因）：Univer Docs（DOCX 导入/导出在商业 Pro 层，开源核心不能往返 .docx）、WordCraft（2026-10 才公开的 Rust 整应用，alpha，自评约 60% 的 Word，DOCX 未经真实文件测试，不是可嵌入 Tauri/React 的库，v1.3 已降级为长期备选，先观望）。

### 8.2 Excel（taoffice-excel，P1，三件套里最可行）

- **v1.3 首选（§8.12）：混合路线——calamine 读 + IronCalc 算 + 自研 zip+quick-xml 手术补丁保存。** 读/导入预览用 `calamine` 0.38.0（Rust，MIT，2016 年起，月下载约 1.0M，xlsx/xlsm/xlsb/xls/ods 只读，最稳）；公式计算用 IronCalc 0.9.1（Rust + WASM，MIT OR Apache-2.0，2023 年起，4,274★，约 500 函数，“与 Excel 结果不同即 bug”标准，动态数组/LET/LAMBDA 已落地；图表在研、透视表仅计划中），不用它的 xlsx 导出做保存；默认保存走自研手术补丁层（`zip` + `quick-xml` 薄层：只改目标 sheet XML、其余部件原样拷贝、删 calcChain），以 `rxls` 0.1.2（Rust，唯一明确宣称 byte-for-byte 手术式补丁的库，极早期，需审计 + 实测）作对照 spike；全量重建/新建走 `umya-spreadsheet`（须提示可能丢失项）或 `rust-xlsxwriter`（新建/导出最稳）。craft-xlsx + GridCraft 降级为观察对象（写能力未核实，GridCraft 自认丢未建模内容、图表往返丢类型、透视表 45%）。
- 读：`calamine`（Rust，MIT/Apache-2.0，读 xlsx/xlsm/xlsb/xls/ods，惰性按表解析，**只返回缓存的公式值，不算公式**）。
- 写新文件：`rust_xlsxwriter`（MIT/Apache-2.0，写新工作簿、格式/图表、常量内存模式；不能读改已有文件）。
- 原地改：`umya-spreadsheet`（Rust，唯一读 + 写同一 crate；代价是全量 eager 解析，且有记录的往返损伤——**图表损坏、批注丢失、数据透视表不读**）。只在能接受该损伤时作备选。
- UI（三选一，spike S3 定，v1.3 已按成熟度排定方向）：(a) **Univer Sheets**（TS，Apache-2.0 核心，v1.0，Canvas 渲染，500+ 公式函数，冻结/合并/筛选/验证/条件格式/批注；**XLSX 导入导出、图表、透视表在商业 Pro 层**；Sheets 预设约 6.9 MB JS，约 1.8 MB gzip，需插件模式 + 懒加载）——绝对成熟度最高（1.0.2、24,605★、公司化），但不符合约束（商业 Pro + 服务端转换 + 自有 JSON 模型），“最稳但不能用”；(b) **IronCalc**（Rust + WASM，MIT/Apache-2.0，v0.9.1，约 300–500 个 Excel 兼容函数，XLSX 导入导出保留公式与格式；无图表、无实时协作）+ 自研网格 UI——满足约束的前提下最稳；(c) **craft-xlsx + GridCraft 的 `calc`/`formula`/`functions` crate**（纯 Rust，格式层走 `craft-xlsx`，计算/公式引擎走应用仓 crate，见 §8.11；需 spike 验证能否从应用仓抽出、与 Tauri 共存）——v1.3 降级为观察对象，最不稳（6 周历史、v0.1.0、git-rev、无 crates.io、GridCraft 自评 50% 且 2,257 open issues、写能力未核实）。不要用 Luckysheet（2025-10 已归档 EOL，团队指向 Univer）。
- 回归重点（§12 语料库必测）：公式重算 vs 缓存值、合并单元格、条件格式、数据验证、图表、透视表、图片、批注——这些正是静默丢失的重灾区。
- 老格式：`.xls` 用 calamine 读、SheetJS 读；编辑走转 xlsx，不原地改 .xls。

### 8.3 PowerPoint（taoffice-ppt，P3）

- **v1.3 首选（§8.12）：混合路线——office_oxide 作格式层 + PptxViewJS 渲染 + PptxGenJS 新建；craft 降级为技术储备；OpenPresent 为头号观察对象。** 没有同时满足“成熟 + 开源读写 + 手术式补丁”的 PPTX 库——“无成熟开源读写库”本身就是调研结果。office_oxide 的 `EditableDocument.replace_text` 正是当前口径需要的操作（手术式文本替换），且是唯一在官方文档中承诺“未动 OPC part 原样复制”的已发布 crates.io 库（约 149K 月下载、纯 Rust 零原生依赖、约 1.5 MB）；渲染与格式解耦，先用 PptxViewJS（JS，MIT，Canvas 渲染整份 PPTX，只读）做只读渲染，待任一 Rust 渲染器通过对照测试后再替换；新建用 PptxGenJS（最成熟的新建库）。OpenPresent（Rust 引擎编为 WASM，Apache-2.0，early preview，自称 66 个真实 deck 保存后“每个 XML part 字节相同”，但明确声明输出尚未用 PowerPoint 对照验证）引擎设计与需求重合度最高，待其仓库可公开审计、且通过 PowerPoint 对照测试后重新评估。craft-pptx 模型更广（母版/版式/节），但当前口径用不上，其“kept parts”无独立佐证，且全程 git-rev、无 crates.io 发布，供应链风险最高。
- 查看：**PPTXjs**（JS，MIT，只读；渲染文本/形状/图表/图片/音视频；依赖老：jQuery 1.11.3、JSZip 2.x、D3 v3，维护慢，但仍是唯一广泛使用的开源 PPTX 查看器）。
- 新建：`PptxGenJS`（JS，创建新演示文稿；**不能读/改已有 PPTX**；许可证实现前复核）。
- 编辑：**没有开源幻灯片画布编辑器**（布局、母版、动画、图表编辑 + 往返 PPTX）。可实现的是文本替换（Office Oxide `replace_text` 的手术式做法，或手写 ZIP+XML 手术），以及新建。超出这个范围的是多季度的自研编辑器，不在本设计内承诺；Univer Slides 同样把导入导出放在 Pro 层。
- 会丢的：母版/版式、动画/切换、SmartArt、图表、嵌入媒体、备注（文本替换时只动占位符文本，其余部件不动）。
- 老格式：`.ppt` 无浏览器渲染器，只做文本提取；查看走转 pptx。

### 8.4 PDF（taoffice-pdf，P1）

- **v1.3 首选（§8.12）：混合成熟栈，craft 降级为备选。** 查看/渲染主选 **`pdfium-render` 0.9.5**（Rust 绑定 Google PDFium，MIT/Apache-2.0，PDFium 本体 BSD-3-Clause，2026-11-01 发版，月下载 678,321，104 个 crate 依赖；Chrome 同款引擎，保真度是事实标准；实测单平台动态库约 8 MB——bblanchon chromium/8152：linux .so 7.9 MB、win .dll 7.5 MB，100 MB 上限绰绰有余；需随包分发动态库，不是 sidecar）；前端备选 **pdf.js 6.5.438 + react-pdf 11.1.0**（零 Rust、零分发成本，Web 查看事实标准）。编辑/写回：**lopdf 0.46.0**（Rust，MIT，对象级读写：合并/拆分/页面操作/元数据/读加密）+ **@cantoo/pdf-lib 2.11.1**（pdf-lib 的活跃 fork，MIT，前端表单填写 + AES-256 加密写；原版 pdf-lib 已实质停更，不用）。生成合规新 PDF 用 **krilla 0.8.2**（PDF/A-1~4 validated 导出）。**craft-pdf 的实质是 hayro + krilla 的薄包装**（2026-11-15 用 GitHub API 核实 `craft-libs/crates/pdf/Cargo.toml`：`read`/`interpret`/`raster` 依赖 hayro-syntax/hayro-interpret/hayro，`write` 依赖 krilla）——hayro 0.9.0（2026-11-02，累计 5,396,646 下载）和 krilla 都是 crates.io 上可直接依赖的成熟库，绕开 craft-libs 中转直接依赖，能拿到同样的能力，却去掉 git-rev 供应链、Rust 1.95 强制要求、135-crate monorepo pin 的全部成本；PdfCraft 应用层真正独有的东西（annot/forms/sign/redact 等 34 个 crate）是 alpha、自评约 55% 日常就绪，crate 层 API 未逐项核实过，不能当作“已验证的编辑引擎”。仅当 pdfium 动态库分发被证明不可接受、且纯 Rust 路线被强制要求时，才考虑 craft-pdf。
- 查看：**pdf.js**（Mozilla，Apache-2.0，`pdfjs-dist`，约 1–2 MB；渲染到 canvas、文本层、搜索、大纲、标注显示；**只读，不写文件**）。
- 编辑：**pdf-lib**（JS，MIT，约 400 KB；加/复制/删除/旋转页面、画文字/线/矩形/图片、读写 AcroForm 并拼合、合并/拆分、元数据、加密）+ pdf.js 组合 = 标注（墨迹/高亮/方框/文字覆盖）+ 表单填写 + 页面操作 + 合并/拆分 + 水印。**不能原地改已有正文并重排**（只能覆盖旧文字再重画，字体匹配有限）。
- Rust 结构操作（可选）：`lopdf`（MIT，纯 Rust；合并/拆分/加密/水印/元数据；解析器严格，会拒绝真实世界里能打开的畸形 PDF）。
- 接近正文编辑的唯一开源路径：`pdfium-render`（Rust 绑定，MIT/Apache-2.0，绑 Google PDFium）+ 自研编辑 UI；代价是随包发布约 8 MB/平台的 PDFium 共享库（2026-11-15 实测，见上；v1.0 写的“约 20 MB/平台”已纠正），是编进包的库，不是 sidecar，且仍需自研 UI。**避开 `pdfium` 这个 crate 本身：它的 Rust 绑定是 GPL-3.0。** 数字签名与 PDF/A 是分水岭，要单独决策：开源侧签名创建只有 @signpdf/signpdf（MIT，3.3.0，支持 PAdES subfilter），验证与 LTV 无成熟开源方案；PDF/A 创建可用 krilla，校验无开源 Rust/TS 等价物（veraPDF 是 Java + GPL 成分，不符合约束）。如果把“PAdES 全套 + PDF/A 校验”列为必备，唯一有明确文档的路是商业 SDK（Apryse/Foxit/Aspose），那是商务决策不是技术选型。OCR（P2/P3）用 tesseract-rs 0.4.0（静态编译进应用，默认只捆 eng fast 约 4 MB）。
- 商业 SDK（Nutrient、Apryse、ComPDF）能做正文编辑/密文/签名/对比，但那是付费 SDK，不在本设计内。

### 8.5 Visio（taoffice-visio，P3，spike + 许可评审前置）

- **v1.3 首选（§8.12）：无可用开源路线达到“像 Visio 一样渲染”，降级为 libvisio（MPL-2.0）→ WASM 尽力渲染 + 明确提示。** C++ `libvisio` 0.1.11（LibreOffice 在用的解析器，MPL-2.0）→ Emscripten → WASM，在 Tauri WebView 内跑；或 Rust FFI 静态链接 `libvisio + librevenge`。MPL-2.0 合规、LibreOffice 十余年实战、已有 WASM 概念验证（opendesign 称 WASM 引擎约 1 MB，读 .vsd 与 .vsdx/.vstx）。预期效果是尽力渲染 + 明确提示，不承诺 Visio 级保真（查看器角落标注保真度边界，并提供“在 Visio 中打开 / 导出 SVG/PDF 对照”出口）。`libvisio-rs` 只作隔离验证分支（不进主分发）：用它做保真度对照测试，只用于内部评估它比 `libvisio` 好多少；只有法务/产品接受“Visio 插件以 GPL 单独分发、与 MIT 核心隔离”才考虑采用，否则不用。编辑/写回第一版不做“真编辑”，只做查看；写回若必须做，优先评估 Apache-2.0 的 `ooxml-core/visio`（beta，明确无 Office parity）或 draw.io 导入→mxGraph→导出 .vsdx 的迂回路线。P1 跟踪：`ooxml-core/visio` 与 BetterOffice `betteroffice-vsdx`（两者 2026 年下半年才出现、成熟度低，但许可证与架构合规，若半年后其一达到可用保真度可替换 libvisio WASM 路线）。不建议：Aspose.Diagram（JVM/.NET 运行时违反约束）、Syncfusion（experimental 且只覆盖基础形状）、任何 Python 库、单独用 `vsdx-js`（只有解析没有渲染）。
- 格式本质：`.vsdx` 是 OPC ZIP + XML（`document.xml`、`pages/pageN.xml`、`masters/`、`themes/`），解包解析不难；难的是渲染——ShapeSheet 公式（PinX/PinY/Width/Height/Angle、Geometry 的 MoveTo/LineTo/ArcTo、Fill/Line/TextBlock、Character/Paragraph）、Master→Shape、Style→Shape、Theme 三层继承、动态连接器 Glue 与路由、图层、背景页、容器、数据图形、内嵌 EMF/WMF 图片（需转 SVG）。等于重做 LibreOffice 十几年积累的 Visio 导入器。
- 唯一 Rust 原生候选：**`libvisio-rs`**（0.2.1，单作者，声称完整 vsdx+vsd → SVG：主题、渐变、阴影、填充/线型、圆角矩形、富文本、内嵌图片、连接器、超链接、Master 继承、分组/嵌套；另有 C ABI 与 `visio2svg`）。**许可证 GPL-3.0-or-later 是硬问题**：Taomni 是 MIT，静态链接 GPL-3.0 代码进分发产物触发 copyleft，须法务/架构评审，不能直接放进核心或默认包；spike 必须同时验证保真度与合规方案。
- 备选：**libvisio**（Document Liberation Project，C++，MPL-2.0/LGPL/GPL 三选一，LibreOffice 在用的解析器）经 FFI 静态链接或编成 WASM（已有把 libvisio 编成 WASM 的先例）；只读、不写回；内嵌 EMF 另需 `emf2svg`。
- 编辑：XML 级简单项可行（改文本、改 PinX/PinY/Width/Height、改填充/线条颜色、用已有 Master 新增简单形状、删形状；ZIP 解包 → 改 `pageN.xml` → 重打包，保留未动部件；Rust 用 `zip` + `quick-xml` 自研写回层）。难/高风险：新增带 Glue 的连接器、建新 Master、改 Geometry 公式、数据链接形状——写错后 Visio 打开会静默修复或报错，CI 里没有 Visio 很难保证。
- 老格式 `.vsd`：`libvisio-rs` 声称支持；编辑不做，只读。
- 唯一高保真读写是商业 Aspose.Diagram（约 $799 起，要 JVM/.NET 运行时），不符合约束，不采用。

### 8.6 MS Project（taoffice-project，P2）

- **v1.3 首选（§8.12）：读用 mpxj-rs（纯 Rust，只读）；写走 MSPDI XML（自研或参考 MPXJ 的 writer 思路）；.mpp 写回列为 P3 跟踪项。** 两处前提纠正：(1) “.mpp 在任何开源路径上都不能保存回去”已过时——2026 年 9–11 月出现了模板法开源 .mpp 写入器（`pymppwriter` Python / `mppwriter` TS，MIT，0.4.3，alpha；Swift 的 `MPPKit` 是 AGPL，排除；.NET 的 `OfficeIMO.Project`，MIT，3.6.0，声称能写、无需种子文件，但需 .NET 运行时，NativeAOT 进 Tauri 未验证，待定）。它们都能写出 Project 可打开的 .mpp，但全部是 alpha / 有损 / 仅 MPP14，没有一个达到生产级全保真；其中 TS 版 `mppwriter`（MIT、零运行时依赖、无 sidecar）是最值得跟踪的一个，但 npm 上架状态矛盾、模板 .mpp 的再分发合法性未核实，只能作 P3 跟踪，不能作主路线。(2) `.mppx` 不是微软官方的独立格式——Microsoft Support 的格式表只列 `.mpp` 和 XML（`.xml`）；所谓 `.mppx` 实质就是 MSPDI XML 的别名，处理时应按内容（根元素 `xmlns="http://schemas.microsoft.com/project"`）识别，不要只认扩展名。mpxj-rs 的 LGPL-2.1 需法务复核链接方式（LGPL 允许链接进闭源分发但有义务条款）；MPXJ（Java）排除（需要 JVM = sidecar，且捆 JRE 后大概率超 100 MB）。
- 格式难度差：二进制 `.mpp`（OLE 复合文档 + 私有二进制记录，微软未完整公开，靠逆向）最难；`.mppx`/`.xml`（MSPDI，微软公开的 XML Schema）容易，Rust/TS 都能直接读写；`.mpx` 是 legacy 文本格式，Project 2010 后已不支持。
- 读 `.mpp`：**`mpxj-rs`**（Rust，LGPL-2.1-or-later，MPXJ Reader 部分的非官方 Rust 重写；读 MPP8/9/12/14、MPX、MSPDI，落在 `ProjectFile` 模型上；**只读，无 Writer，无完整 CPM 调度**）。非官方、较新，必须拿真实 .mpp 做 spike（日历、基线、自定义字段、时间分段数据、加密文件都可能缺口）；LGPL 在 Rust 静态链接下的合规需评审。Java 原版 MPXJ（LGPL-2.1，行业标准）要 JVM，不符合约束。
- 查看：没有库自带甘特 UI；`mpxj-rs`/MPXJ 只给数据模型（任务树、资源、分配、前置关系、日历），甘特表格 + 时间轴条形图要自研 TS（SVG/Canvas），工作量中等。
- 编辑：改日期/工期/完成百分比、增删任务、改前置关系、改资源分配，数据层都好做；难点在两处：(1) **重算调度**（改工期/前置后重算后续任务 early/late 日期与关键路径；MPXJ 不做完整 CPM，`mpxj-rs` 明确无完整 CPM，需自研调度引擎：前置类型 FS/SS/FF/SF + lag、日历工作日/例外、资源日历；资源平衡直接划出范围）；(2) **保存回 .mpp 开源路线不存在**（MPXJ 官方 FAQ 原话）。可行闭环：读 .mpp → 编辑 + 自研重算 → **保存为 .xml/.mppx（MSPDI，自研 XML Writer）**，MS Project 可直接打开；代价是丢失仅存在于 .mpp 的视图外观、甘特条样式。
- `.xml`/`.mppx`/`.mpx`：直接 XML 解析读写，完全可行，风险最低的一档，先落地。

### 8.7 视频与音频（taoffice-video，P1 播放 / P3 编辑）

- **v1.3 首选（§8.12）：分层混合，FilmCraft 不作当前 Tier 3 首选。** Tier 1 原生 `<video>`（零成本）；Tier 2 **WebCodecs + Mediabunny**（纯 TS，MPL-2.0，核心 40–143 kB gzip，帧不用出浏览器，是唯一不需要解决“帧进 WebView”问题的路线；覆盖 MP4/MOV/MKV/WebM transmux + 转码，硬件加速；不支持 AVI/FLV/WMV/RM；Linux WebKitGTK 的 WebCodecs 支持是最大不确定点，须实测，S5）；Tier 3 **ffmpeg-next LGPL 静态解码构建**（替代原计划的 FilmCraft 首选——ffmpeg-next 是唯一能兜底全部格式的库：官方格式表确认 AVI/Matroska/RealMedia/ASF 均可解；LGPL 裁剪静态构建约 15 MB/平台量级，进 100 MB 上限有裕量；问题是维护模式 + 底层 API + 静态 LGPL 合规设计，都是可工程化解决的，不像 FilmCraft 的覆盖缺口那样是能力缺失；S4 实测裁剪后体积 + 法务定合规方案）；FilmCraft 降格为 S7 并行候选（用真实文件验证解码质量与完整度，通过后可替换 Tier 3 中的主流容器部分，缩小 LGPL 暴露面；冷门格式仍留 ffmpeg-next）。音频：**symphonia + cpal（或 rodio）**（MP3/AAC-LC/FLAC/Vorbis/WAV；Opus 需 `opuscule` 或 libopus 适配器，spike）。**新增最高优先级 spike S10：解码帧进 WebView**——ffmpeg-next、FilmCraft、系统原生解码都存在同一个缺口：未核实到任何一条把解码帧高效送进 Tauri WebView/React 的成熟方案（逐帧传 base64/共享纹理/原生窗口叠加均未验证）；在它通过之前，Tier 3 的播放体验不能承诺。GStreamer 不推荐作主路径（体积贴近/超过上限、打包复杂、rm/wmv 需 ugly 组）。纯 Rust 拼装目前拼不出完整播放器（H.264/VP9 解码、RM、音频编码全是缺口），价值只在音频与解封装。
- 现实前提：Tauri 2 不自带 Chromium，用各平台 WebView（Windows WebView2、macOS WKWebView、Linux WebKitGTK/GStreamer），所以“原生能播什么”没有统一答案，必须运行时按文件探测（`canPlayType`、`VideoDecoder.isConfigSupported()`）。
- 第一档（免费，零新增体积/许可）：原生 `<video>` 播 mp4/mov/webm 的 H.264/VP8/VP9/AV1（HEVC 看平台）；Linux 看 GStreamer 装了哪些插件。
- 第二档（TS，无原生代码）：**WebCodecs + Mediabunny**（`mediabunny`，npm，MPL-2.0，纯 TS，零依赖；读/写 MP4、MOV、WebM、**MKV**、MP3、WAV、Ogg、MPEG-TS、HLS、FLAC、ADTS；经 WebCodecs 用 25+ 编解码器转封装/转码/裁剪）。关键缺口：**没有 AVI、FLV、WMV/ASF**；WebCodecs 本身不做容器解封装，且 Linux WebKitGTK 的 WebCodecs 常不完整，必须实测。MKV 的坑要写进插件页：Chromium `<video>` 连内含 H.264 的 MKV 都不认（容器不认），不是编码问题。
- 第三档（Rust，唯一全覆盖路径）：**`ffmpeg-next`**（Rust  wrapper，WTFPL；绑 `ffmpeg-sys-next`；需 FFmpeg 库：系统安装、Windows 走 vcpkg、或从源码构建）。解码 mp4/webm/mov/mkv/avi/flv/wmv/rm 用的都是 FFmpeg 原生解码器，在 **LGPL-2.1+ 默认构建**里；编码 H.264 是坑——`libx264` 是 GPL，LGPL 替代是 `libopenh264`（BSD-2-Clause + Cisco 专利授权）或硬件编码器（NVENC/QuickSync/VideoToolbox，看平台）。**`--enable-nonfree`（如 libfdk_aac）不可开——不可再分发。** 静态链接触发 LGPL 的重新链接/源码义务，动态链接是干净路径；发版前法务复核，发布时注明。
- RM/RMVB：浏览器、WebCodecs、Mediabunny 全都不支持；FFmpeg 的 `libavcodec` 有原生 RealVideo（RV10–40）与 RealAudio 解码器。形态二选一：(a) **按需转码后播放**（解码后重编码成 H.264/AAC MP4 放临时/缓存文件再播；简单、可定位，但打开时要等 + 占磁盘）；(b) 解码成帧推 canvas + 音频走 Web Audio（实时、无临时文件，但要自研播放器：音画同步、关键帧定位、无字幕，720p 尚可、1080p 在弱机器上吃力）。本设计选 (a)，且 RM/RMVB 列为视频里优先级最低（legacy 格式，用的人最少、成本最高）。
- 不作主路径：`ffmpeg.wasm`（`@ffmpeg/core` 约 31 MB WASM，**按现成发布是 GPL-2.0-or-later**；纯软件、无 GPU、约 2 GB 文件上限、多线程要 SharedArrayBuffer + COOP/COEP 头，在 Tauri 自定义 scheme 下难以保证；只作小文件/短转码的兜底）、GStreamer（Windows/macOS 要另捆运行时 + 插件集，渲染进 WebView 是另一个集成问题；只在 Linux 已有 GStreamer 时有吸引力，不作跨平台主路径）。
- 编辑/转码（P3）：第二档做支持编解码的裁剪/缩放；第三档做其余格式；H.264 编码走 openh264/硬件，不走 libx264（除非项目接受 GPL）。

### 8.8 压缩包引擎（核心，§5.2 的展开）

**v1.3 首选（§8.12）：直接用成熟库混合搭配；不要为 archive 单独引 craft-zip。** `craft-zip` 的解码就是 `zip` 9 crate（注释写明 "The `zip` crate does the decoding."），增量全在不可信输入的安全壳（preflight、条目数预检、Budget 总量上限、重名检测、确定性写）——有价值，但只在 taoffice 同时采用 `craft-docx`/`craft-xlsx`/`craft-pptx` 且它们都依赖 craft-zip 时才值得顺带复用；否则直接用 `zip` 9 + Taomni 自己实现一层 preflight/Budget/重名检测即可（逻辑不复杂）。另纠正 v1.0 的说法：`zip` 4.6.1 不是“仅 deflate”——它的 `default` 特性已含 aes-crypto、bzip2、deflate64、lzma、ppmd、zstd、xz；“仅 deflate”只在 Taomni 的 `src-tauri/Cargo.toml` 用了 `default-features = false, features = ["deflate-flate2"]` 时才成立（2026-11-15 核实，`src-tauri/Cargo.toml` 第 135 行）。**Zip Slip 防护：未在任一库的文档中核实到默认 Zip Slip 防护，不能假设库已做，由 Taomni 自己实现**（拒绝 `..`/绝对路径/符号链接逃逸 + 展开体积上限，见 AC-T05）。

| 格式 | Rust crate | 许可证 | 读 | 写 | 备注 |
|---|---|---|---|---|---|
| ZIP | `zip`（已有，**升到 9.5.1**，2026-11-10，3.46 亿下载；先做 4.6.1→9.5.1 升级回归 + 确认 feature 设置，S12） | MIT | ✅ | ✅ | Stored/Deflate/Bzip2/Zstd/XZ/LZMA/AES、ZIP64；AES（`aes-crypto`，AE-1/AE-2，读+写）；**分卷（Multi-disk）明确不支持**，`.z01/.zip.001` 需另想办法（`unarc-rs` 称支持） |
| TAR | `tar` 0.4.46 | MIT OR Apache-2.0 | ✅ | ✅ | 与解压 crate 组合，流式 |
| gz | `flate2` 1.1.11（已有） | MIT OR Apache-2.0 | ✅ | ✅ | 默认纯 Rust `miniz_oxide` |
| bz2 | `bzip2` 0.6.1 | MIT OR Apache-2.0 | ✅ | ✅ | 默认已切纯 Rust 后端（`libbz2-rs-sys`） |
| xz | `lzma-rust2` 0.25.0（**替 `xz2`；`xz2` 已 4 年无更新，不要新用**） | Apache-2.0 | ✅ | ✅ | 纯 Rust；`zip` 9.x 与 `sevenz-rust2` 现在都依赖它 |
| zst | `zstd` 0.14.4（开 `vendored` 或 `rust-backend`，否则默认绑 C 库） | BSD-3-Clause | ✅ | ✅ | 多线程编码器 |
| 7z | `sevenz-rust2` 0.25.0（用这个，不用已停更的 `sevenz-rust`） | Apache-2.0 | ✅ | ✅ | 纯 Rust；LZMA2、AES-256（`aes256` 默认开，读+写）；分卷未核实（API 列表中无分卷入口） |
| RAR/RAR5 | `rars` 0.12.4（**spike 首选**，S12） | Apache-2.0 | ✅ 解压 | ❌（写支持 split volumes，但 taoffice 只解压不创建） | 纯 Rust，RAR 1.3–7，`encryption` 特性默认开；但仅 6 个月历史、crate 5.37 MB、作者自认“比 WinRAR 慢、内存多、压缩略差”，须 spike 验证真实 WinRAR 语料 |
| RAR 老变体 | `unrar` 0.5.8（备选） | 包装 MIT/Apache-2.0；内嵌 UnRAR C++ 按 UnRAR 许可 | ✅ 解压 | ❌ | 功能最稳（官方 UnRAR），静态链接进二进制、无 sidecar；但 UnRAR 许可非 OSI，需法务/合规确认；随包发布 `license.txt`；解压合法，创建永不做 |
| 统一门面（可选） | `unarc-rs` 0.8.1（评估，不直接采用） | MIT OR Apache-2.0 | ✅ 解压 | — | 一个 API 覆盖 zip/7z/RAR/tar/各压缩流 + 分卷 + 加密 + 1 GiB 防炸弹上限；但 15,653 下载、8.11 MB crate、MSRV 1.95 高于 Taomni 1.94+ 指导，需 spike 对比手写门面的体积与可控性 |

不用：`rarchive`（**不作主力**：503 下载、2026-11-09 才创建 6 天历史、“非 Windows 未测试”，风险极高）、`compress-tools`（不是纯 Rust，引入 C 依赖链）、`hivepack`（720 下载、10 天历史）、`sevenz-rust`（旧，已停更）、`xz2`（4 年无更新）。

### 8.9 许可证观察清单（实现前逐项复核，不先写代码后补评审）

| 许可证 | 影响 | 涉及 |
|---|---|---|
| GPL-3.0 | 静态链接进分发产物触发 copyleft；Taomni 是 MIT，必须先过法务/架构评审 | `libvisio-rs`；`pdfium` crate（避开，用 `pdfium-render`） |
| LGPL-2.1 | 动态链接是干净路径；静态链接有重新链接/源码义务 | `ffmpeg-next`（FFmpeg）、`mpxj-rs`、`rawloader`（RAW 解码） |
| LGPL-3.0 | 同上，更严 | `libheif`（HEIF 查看的成熟路径，但许可证 + HEVC 专利最重；只读解码、放可选插件、不要默认开） |
| AGPL | 捆绑即传染整个应用 | WebODF（已排除）、MuPDF（AGPL-3.0，技术优秀但排除）、`heic`（imazen，AGPL-3.0-only，排除）、`MPPKit`（AGPL-3.0-only + Swift only，排除）、`xlsxcraft`/`docxcraft`/`pptxcraft`（AGPL-3.0-only，排除） |
| MPL-2.0 | 文件级 copyleft，可接受 | Mediabunny、libvisio（C++ 备选）、`@opendocument/odr-core`、`ical.js`、`epub-builder` |
| UnRAR 许可 | 非 OSI 批准；源码可免费用于处理 RAR，但不能用来开发兼容 RAR 的压缩器与重建 RAR 压缩算法 | `unrar`（RAR 备选，需合规确认 + 随包发布 `license.txt`） |
| 商业 Pro 层 | 开源核心不能往返文件，需买许可 | Univer Sheets/Docs/Slides 的导入导出、图表、透视表 |


### 8.10 storytold 参考：craft-libs 与 Craft 套件（v1.1 新增，2026-11-15 核实）

本节是 v1.1 的核心改动：§8.1–§8.8 的引擎选型不变作备选，但**首选路线改为 storytold 的 `craft-libs` 格式层 + 各 Craft 应用的引擎 crate**。核实方式：2026-11-15 经 GitHub API（82 个仓库全量）+ 浅克隆核对 README 与 crate 清单；`crates.io` 发布情况未核实（当时返回 403），消费路径按 git 依赖 pin tag 处理。

**v1.3 更新：本节的首选地位已被 §8.12 的混合成熟栈取代；craft-libs 与各 Craft 应用仓降级为备选/观察对象。本节保留作对照与复用细节参考（§8.11 的复用程度说明仍有效：若某格式最终仍选 craft 路线，按 §8.11 的三层分工集成）。**

**先纠正一个前提。** storytold **没有已落地的插件运行时**可抄：`craft-extensions` 的 README 自述“provisional and early，没有应用或启动器在用它”，架构文档明言“这只是设计，未被维护者接受，不授权实现”。taoffice 的插件运行时仍按模块化 v1.4（M0）走，不抄 storytold。

**真正可参考的是两层：**

**(a) `storytold/craft-libs`（Apache-2.0，协同发布 v0.1.0，约 130 个 crate，git 依赖 pin tag，Rust 1.95+）——格式层，直接复用。** 它是跨应用共享的格式库，应用仓只留模型、布局、引擎与 UI。这正是 taoffice 想要的“格式能力抽成共享库、插件宿主只做引擎”的形态：

| taoffice 插件 | craft-libs crate（v1.3：已降级为备选，见 §8.12） | 说明 |
|---|---|---|
| taoffice-word | `craft-docx`（DOCX 读写，基于 `craft-wordmodel`；Flat OPC + Word 2003 XML；加密包；**模型未覆盖的标记保存在 `Document::passthrough`，写回时原样写回**——即本设计 §2.2 的手术式保留）、`craft-doc-binary`（老 .doc）、`craft-rtf`、`craft-odf`/`craft-ods`、`craft-opc`、`craft-drawingml` | 有界读取（20,000 个 ZIP 条目、单部件 256 MiB、总量 512 MiB、XML 嵌套 256 层），与 §10 的安全要求同构 |
| taoffice-excel | `craft-xlsx`（xlsx/xlsm/xltx/xltm + 二进制 .xlsb，clean-room 自 ECMA-376/MS-XLSB，无 `unsafe`）、`craft-sheet`、`craft-xls`、`craft-csv` | 格式层；公式/计算引擎在 GridCraft 应用仓的 `calc`/`formula` crate，不在 craft-libs 里 |
| taoffice-ppt | `craft-pptx`（PresentationML 的纯 Rust 类型 + serde；母版/版式/幻灯片/节；经 `craft-drawingml`；“kept parts”保留）、`craft-drawingml` | 格式层；编辑 UI/动画在 DeckCraft 应用仓 |
| taoffice-pdf | `craft-pdf`（`read` 有界打开、`interpret`、`raster` RGBA8 渲染、`write` 经 Krilla、`write-svg`、`write-pdf`） | 格式层；标注/表单/签名/密文等在 PdfCraft 应用仓的 `annot`/`forms`/`sign`/`redact` 等 crate |
| 核心图片 | `craft-image-codecs`、`craft-jpeg`、`craft-heif`、`craft-tiff`、`craft-webp`、`craft-gif`、`craft-psd`、`craft-raw`、`craft-svg` | heic/psd/raw 的查看至此有库路线，替代 §3.2 的“需另评估” |
| 核心压缩包 | `craft-zip`（ZIP 读写，明确写着它包装了 `zip` crate——即 Taomni 已在用的 crate；无 `unsafe`，调用方设限） | 与 §5.2 的 Rust 栈同构，不另起一套 |
| taoffice-video | `craft-video`、`craft-audio`（待核实 API） | 见下文 filmcraft |
| P3 候选 | `craft-epub`、`craft-markdown`、`craft-html`、`craft-dwg`/`craft-dxf`、`craft-indd`/`craft-idml` | epub 与 CAD 的格式层已有，但不在第一版范围 |

**(b) 各 Craft 应用仓（全部 Rust，MIT OR Apache-2.0，2026-09-30–10-31 创建，全部 alpha）——引擎层，按需 git 依赖或参考，不直接当库用。** 每个仓都是 Cargo workspace（`crates/<name>` + `apps/<app>` 原生/`-web` WASM/`-cli` + `xtask`），与 taoffice 每插件“宿主 + 前端 chunk”的形态同构：

| 应用 | 定位与自评 | 对 taoffice 的意义 |
|---|---|---|
| wordcraft（18,021 stars） | Word 处理器，v0.18.1；ribbon 覆盖 97%，自评约 60% 能用于真实工作；DOCX 从未在真实文件上测试过（gap #1）；图表/SmartArt 只保留不编辑（3%）；分页保真度 55% | L0–L4 的 `wordcraft-doc`/`wordcraft-docx`/`wordcraft-layout`/`wordcraft-render`/`wordcraft-engine` 是普通 lib crate，可 git 依赖；L6 egui 前端扔掉，Taomni 自研 React 渲染层。三种接法见 §8.1 的补充：只用格式层（推荐起步，2–4 周 spike+集成）、再加布局/渲染做分页查看（+3–6 周）、整机搬入 engine（不建议） |
| gridcraft（7,537） | 电子表格，alpha；“核心流程端到端能跑，但深度、保真度未完成” | 格式层走 `craft-xlsx`；计算/公式引擎在应用仓的 `calc`/`formula` crate，需 spike 评估能否 git 依赖 |
| deckcraft（4,796） | 演示文稿，可打开/保存 .pptx；early development；自评 84% 功能广度 | 格式层走 `craft-pptx`；编辑 UI/动画在应用仓，PPT 画布编辑的口径不变（文本替换 + 新建） |
| pdfcraft（20,743） | PDF 阅读编辑，alpha；自评约 55% 日常工作就绪、49% 专业流程；`cos`/`content`/`annot`/`forms`/`sign`/`redact`/`ocr` 等 crate 是本次调研中见到的最完整 PDF 栈 | 格式层走 `craft-pdf`；标注/表单/签名等能力按需从应用仓取 crate，需 spike 核实 |
| filmcraft（18,287） | 非线性视频编辑，alpha；自带纯 Rust 的 Matroska + ISOBMFF 解封装器与编解码器（H.264/HEVC/AV1/VP8/ProRes/DNxHD） | **taoffice-video 第三档的并行候选（v1.3：已降级，不再是首选；首选是 ffmpeg-next，见 §8.7/§8.12）**：无 ffmpeg、无 sidecar 进程。但它们是应用仓内 crate、未发布为库，复用 = git 依赖/vendor + spike（S7）；AVI/RM/FLV/WMV 不在 filmcraft 已核实的格式里，仍需 ffmpeg-next 兜底 |
| lightcraft / photocraft / soundcraft / vectorcraft / designcraft / figcraft / cadcraft | 照片/raw、音频 DAW、矢量、页面设计、CAD | 音频（soundcraft）供 taoffice-video 的音频部分参考；照片/raw（lightcraft，`craft-libs` 的 `raw`/`heif`）供核心图片参考；CAD 不在范围 |

**套件里没有的东西（taoffice 仍按原计划）**：Visio（无对应仓库/crate）、MS Project（filmcraft 的 `project` crate 是影片项目文件，不是 MS Project）、压缩包管理器（只有 `craft-libs` 的 `craft-zip`）。

**必须写明的限制与待验证项（进 spike，不先承诺）：**

- **全部 alpha、只有约 6 周历史**，自评就绪度 WordCraft 约 60%、PdfCraft 约 55%/49%、DeckCraft 84% 广度、GridCraft alpha。**star 数不能作成熟度证据**（如 photocraft 79,422 stars 是 API 返回值，与 6 周历史不相称，只作记录）。
- **git 依赖供应链**：craft-libs 按 tag `v0.1.0` pin；应用仓的 crate 不在 crates.io（未核实发布），只能 git 依赖 pin rev；`craft-libs` 本身是横跨音视频/图片/CAD 等几十个 crate 的大 monorepo，pin 的是整个仓的 rev。
- **工具链**：craft-libs v0.1.0 要求 Rust 1.95+；Taomni 仓库规则写的是 Rust 1.94+，依赖前核对工具链版本（S8）。
- **Tauri 冲突风险**：WordCraft 的 `[patch.crates-io]` 把 egui 全家与 winit pin 到 storytold 自己的 fork；Tauri 2 自身依赖 tao（winit 的 fork），同一 workspace 共存必须先验证（S8）。
- **许可证**：套件本体 MIT OR Apache-2.0，干净。2026-11-15 经 GitHub API 核实：`craft-libs` 工作区根 `Cargo.toml` 的 license 就是 `MIT OR Apache-2.0`，各 crate 的 `license.workspace = true` 继承它（已抽查 docx/xlsx/pptx/pdf/zip/video/image-codecs/wordmodel 八个 crate）；rust-version 1.95、版本 0.1.0。S8 的许可证核对项因此已完成一半，剩下的是应用仓各 crate 的 license 文件抽查 + 品牌/logo 移除。`craft-launcher`（安装/更新/打开全部 Craft 应用）可作模块商店的参考实现，不作依赖。
- **passthrough 分歧（S6）**：org 普查核对 `craft-docx` 的 `lib.rs` 称 passthrough 会写回；wordcraft 细查核对 `wordcraft-docx` 的 `model_bridge.rs` 称写路径没有 `kept` 处理、是整包重序列化。两者可能同时成立（craft-docx 层保留、wordcraft 桥接层丢弃），也可能有一方过时。**在 spike S6 里用真实 .docx 验证“改一段文字后，未动部件是否字节不变”，以实测为准，不以文档为准。**

### 8.11 复用程度：格式层直接依赖、引擎层适配依赖、UI 全部重开发（v1.2 新增，2026-11-15 核实）

本节把 §8.10 的 craft 路线（v1.3 已降级为备选）落到“每层复用多少、每层谁来写”。若某格式最终仍选 craft，按本节的三层分工集成；若选 §8.12 的成熟栈，则本节不适用。结论先说三句：

1. **格式层（`craft-libs`）——直接依赖，按 crate 取用，不照搬整个 monorepo。** 2026-11-15 经 GitHub API 核实：`craft-libs` 共 135 个 crate，工作区 license 是 `MIT OR Apache-2.0`，rust-version 1.95，协同发布 v0.1.0。消费方式是 Cargo git 依赖 pin tag `v0.1.0`（`version = "=0.1.0"` + rev）；pin 的是整个仓的 rev，但 Cargo 只编译实际依赖的 crate 及其传递依赖，不会把 135 个 crate 都编进包。Taomni 每个插件只取自己需要的几个 crate。
2. **引擎层（各 Craft 应用仓）——适配依赖，不是拿来即用。** 应用仓的 crate 是 in-app 的普通 lib crate（不是发布到 crates.io 的库），复用 = git 依赖 pin rev，必要时 vendor/fork 做适配：去掉与 egui 前端绑定的部分、去掉 `[patch.crates-io]` 的 fork 影响、抽出只算不画的部分。复用程度分三档：Word 高、Excel/PDF 中、PPT/视频 低–中（见下表）。**上游 rev 本身不统一**：WordCraft 自己的 `Cargo.toml` 里不同 craft-libs crate pin 的是不同 rev（如 `craft-proof` rev `01315d9c`、`craft-docx`/`craft-wordmodel`/`craft-zip` rev `41fb2275`、`craft-pdf` rev `6e03f65b`），taoffice 必须自己选一组能一起编译的 rev，在 S8 里验证。
3. **UI 层——全部重开发，不复用任何 Craft 应用的 UI。** 全部 Craft 应用的 UI 都是 egui（immediate-mode、原生 GPU 绘制，没有 DOM、没有 React 绑定、没有可嵌入 WebView 的组件）；`wordcraft-web` 也是 WASM + egui 整页画布，不是可嵌入的组件。Taomni 前端是 React 19 + WebView，UI 只能自研。复用的是“算出来的东西”（解析后的文档模型、排版后的页面、光栅后的位图、解码后的视频帧），不是“画出来的界面”。分工是：Rust 宿主算，React 画，中间用 Tauri 命令传结构化结果（模型 JSON、页图 PNG、文本层坐标）。

| 插件 | 格式层 crate（直接依赖） | 引擎 crate（适配依赖） | Taomni 自研 | UI |
|---|---|---|---|---|
| taoffice-word | `craft-docx`（读写，`Document::passthrough` 保留未建模标记）+ `craft-wordmodel` + `craft-doc-binary`（老 .doc）+ `craft-rtf` | `wordcraft-doc`（文档模型）+ `wordcraft-docx`（2026-11-15 在浅克隆里核实 API：`read`/`read_with_password`/`read_with`/`read_xml`/`write`/`write_as`/`write_flat`/`write_wordml2003`，另有 `decrypt`/`is_encrypted`）+ `wordcraft-layout`（`layout(doc, cache, opts) -> DocLayout`，分页/页眉/表格/浮动/脚注/数学公式）+ `wordcraft-render`（`to_png`/`to_jpeg` 光栅） | 手术式保存（只写改过的部件）、Tauri 命令桥、脏态进 `documentStore` | 自研 React 块编辑器（段落/表格/图片块）；分页查看用 layout 的页图 + 文本层 |
| taoffice-excel | `craft-xlsx` + `craft-sheet` + `craft-xls` + `craft-csv` | GridCraft 的 `calc`/`formula`/`functions`/`model`（2026-11-15 API 核实 crate 清单：`calc chart core engine formula functions math mcp model numfmt pdf sandbox ui-egui xlsx`）；S3 三选一：Univer Pro（商业）/ IronCalc / craft-xlsx + GridCraft calc | 网格 UI、公式栏、筛选/冻结、保存（手术式补丁） | 自研 React 网格（或 Univer/IronCalc 的 TS 渲染层，S3 定） |
| taoffice-ppt | `craft-pptx`（PresentationML 纯 Rust 类型 + serde，母版/版式/幻灯片/节，“kept parts”保留）+ `craft-drawingml` | DeckCraft 的 `model`/`pptx`/`render`（2026-11-15 API 核实 crate 清单：`anim color engine fonts format geom mcp media model pdf pptx render text ui-egui`）；动画/切换效果不在复用范围 | 幻灯片画布、文本替换编辑、新建（PptxGenJS 作新建备选） | 自研 React 幻灯片画布 |
| taoffice-pdf | `craft-pdf`（`read` 有界打开、`interpret`、`raster` RGBA8 渲染、`write` 经 Krilla） | PdfCraft 的 `annot`（标注）/`forms`（表单）/`sign`（签名）/`redact`/`cos`/`content`（2026-11-15 API 核实 crate 清单，共 34 个 crate，另有 `ocr`/`optimize`/`preflight`/`xfa`/`xfdf`） | 注释/表单/签名流程、加密包处理、Tauri 命令桥 | 自研 React 阅读器（页图 + 文本层 + 标注层） |
| taoffice-video | `craft-video`、`craft-audio`（API 待核实，见 §8.10） | FilmCraft 的 `matroska`（Matroska 解封装）/`isobmff`（MP4 解封装）/`codecs`/`h264enc`/`bitstream`（2026-11-15 API 核实 crate 清单，共 32 个 crate）；AVI/RM/FLV/WMV 不在其中，仍需 `ffmpeg-next` 作兜底 | 播放器 UI、转码任务管理、解码帧 → WebView 的传输 | 自研 React 播放器；解码在 Rust 宿主做 |
| 核心图片 | `craft-image-codecs` + `craft-jpeg`/`craft-heif`/`craft-tiff`/`craft-webp`/`craft-gif`/`craft-psd`/`craft-raw`/`craft-svg` | 无（纯格式层即可） | 已有图片查看器 + 旋转/裁剪/标注（P2） | 已有查看器 + 自研 |
| 核心压缩包 | `craft-zip`（明确包装了 Taomni 已在用的 `zip` crate；无 `unsafe`） | 无 | §5.2 的 Rust 解压栈 | 已有文件浏览器 + 自研 |

**集成方式（四条硬规则）：**

- **依赖隔离**：每个插件的 Rust 宿主是独立可执行文件（v1.4 形态），craft 依赖只进该插件自己的 `Cargo.toml`，不进核心；核心不直接依赖任何 craft crate——核心图片/压缩包例外（`craft-image-codecs`/`craft-zip` 进核心，但它们是纯格式库，无 egui/winit 依赖，S8 核实其传递依赖不带 UI 栈）。
- **`[patch.crates-io]` 冲突**：WordCraft 用 storytold 自己的 egui/winit fork 做 patch；Taomni 不能全盘接受这个 patch（Tauri 2 自身依赖 tao，即 winit 的 fork）。只依赖 lib crate 时若其传递依赖触发 patch，必须在 S8 里验证能否去掉 patch 或用 `[patch]` 隔离；验证失败则退回“只用 craft-libs 格式层”，不碰应用仓 crate。
- **100 MB 称重**：按需依赖后只编用到的 crate，S8 实测单插件包 ≤ 100 MB；vendor 只 vendor 用到的 crate，不全量 vendor（上游 600+ crate 全量 vendor 是 v1.1 提到的风险，实际按需依赖后小得多，仍需实测）。
- **品牌与合规**：ArtCraft 品牌/logo 不在许可内，复用代码时移除品牌元素；MIT OR Apache-2.0 要求保留版权声明；复用的 crate 若带 `deny.toml` 合规门禁，那是对方 CI 的配置，不直接复用。

### 8.12 成熟库横向对比与新首选路线（v1.3 新增，2026-11-15 核实）

背景：用户要求除了 craft-xxx 之外再深入调研成熟流行库，哪个更好用哪个。五路并行调研（Office 三件套、PDF、视频/音频、图片/压缩包、Visio + Project + 冷门类型），方法：`browser.search` + `browser.open` 核实 crates.io / npm / GitHub / 官网，查不到的写“未核实”。**五路结论一致：craft 路线不应继续当首选，改为混合成熟栈，craft 降级为备选/观察对象。** 五路完整报告文件在本分支的 `docs-feature/taoffice-research/` 下：`taomni-taoffice-docx-research.md`、`taomni-taoffice-xlsx-research.md`、`taoffice-pptx-research-2026-11-15.md`、`taomni-taoffice-video-routes-research-2026-11-15.md`、`taoffice-rust-av-research-2026-11-15.md`、`taoffice-video-native-decode-research.md`（视频三份）。

| 格式 | v1.3 首选 | craft 路线地位 | 关键理由 |
|---|---|---|---|
| Word | Office Oxide 作格式/补丁层 + BetterOffice 优先 spike（S11） | 长期备选，每季度复评 | Office Oxide 是唯一在文档层面承诺手术式补丁的已发布库；BetterOffice 是唯一现成覆盖“真编辑 + React 19 组件 + 纯 Rust + 无 winit 冲突”的方案；craft 自称 passthrough 但无真实文件证据 |
| Excel | calamine 读 + IronCalc 算 + 自研 zip+quick-xml 手术补丁保存（rxls 作对照 spike） | 观察对象 | craft 写能力未核实，GridCraft 自认丢未建模内容、图表往返丢类型、透视表 45%；IronCalc 3 年历史、约 500 函数 vs craft 6 周历史 |
| PPT | office_oxide + PptxViewJS 渲染 + PptxGenJS 新建；OpenPresent 为头号观察对象 | 技术储备 | “无成熟开源读写库”本身就是调研结果；craft 的 kept parts 无独立佐证，供应链风险最高 |
| PDF | pdfium-render 渲染 + lopdf + @cantoo/pdf-lib 编辑（+ krilla 做 PDF/A 创建） | 备选（仅当 pdfium 动态库分发不可接受、且纯 Rust 被强制要求时） | craft-pdf 的实质是 hayro + krilla 的薄包装，直接依赖更干净；MuPDF AGPL / Poppler GPL 已排除 |
| 视频 | Tier 1 原生 `<video>` / Tier 2 WebCodecs + Mediabunny / Tier 3 ffmpeg-next LGPL 静态解码构建；FilmCraft 降格为 S7 并行候选 | S7 并行候选 | FilmCraft 覆盖不了需求单（无 AVI/RM/FLV/WMV）；ffmpeg-next 是唯一能兜底全部格式的库 |
| 音频 | symphonia + cpal（或 rodio） | — | 纯 Rust 拼装的价值在音频与解封装，不在视频解码主路径 |
| 图片（核心） | image-rs 生态：`image` 0.25.10（只开需要的 features）+ `kamadak-exif` + `imageproc`；SVG 主显示走 WebView、位图需求走 resvg 0.50.0 | 顺带取用（仅当整体已采用 craft-libs 时）：`craft-image-codecs` 统一层、`craft-heif` 色彩修正；**不要为图片单独引 craft-libs** | 亿级下载（image 2.52 亿、png 3.14 亿、tiff 1.57 亿）vs v0.1.0 git-only；craft 不是一个完整格式层：`craft-webp` 无 VP8、`craft-tiff` 不解像素、没有 `craft-png`，选 craft 仍需再接 image/png/dav1d 补齐 |
| HEIF/RAW/PSD/AVIF（可选插件） | heic-rs 0.1.4 首选（须真实 HEIC 语料 spike）否则 libheif-rs；RAW 用 rawloader（LGPL，需法务确认）或 craft-raw；PSD 用 `psd` 0.3.5 或 craft-psd；AVIF 查看用 dav1d（放可选插件） | craft-heif / craft-raw / craft-psd 是自研、无上游等价物，能力面超过成熟库，但止点明确（不合成、不去马赛克），可按需评估 | libvips（体积/部署/LGPL 三重冲突）、mozjpeg（核心场景无必要）、AGPL 的 `heic` 排除 |
| 压缩包（核心） | `zip` 9.5.1 + `sevenz-rust2` 0.25.0 + tar/flate2/bzip2/lzma-rust2/zstd；RAR 走 rars spike（备选 unrar + 合规确认）；统一门面评估 unarc-rs | 不单独引（仅当已用 craft-docx/xlsx/pptx 时顺带复用其安全壳） | craft-zip 的解码就是 `zip` 9；`rarchive` 太新不作主力 |
| Visio | libvisio（MPL-2.0）→ WASM 尽力渲染 + 明确提示；libvisio-rs 只作隔离对照分支 | 无覆盖 | 没有任何开源库能保真渲染 Visio 全部特性 |
| MS Project | mpxj-rs 读 + MSPDI XML 写；.mpp 写回（mppwriter 模板法）列为 P3 跟踪 | 无覆盖 | MPXJ（Java）排除（JVM = sidecar）；MPPKit 排除（AGPL + Swift only）；OfficeIMO.Project 待定（需 .NET 运行时） |
| 冷门类型 | EPUB 用 epub.js（阅读）+ Rust `epub`（元数据）；MOBI 用 ebook-rs（spike）；字体用 @cantoo/fontkit；DXF 用 `dxf` 0.6.2；DWG 只有 cadkit-dwg（极新，spike）；.eml 用 mail-parser 0.11.9；.ics 用 icalendar + rrule 或 ical.js；CSV 用 `csv` 1.4.0 | 对照：craft-epub/dwg/dxf/ical/csv/font 相关 crate 只在 crate 清单核实中确认存在，未核 API（S13） | 除 DWG 外都有纯 Rust 或纯 TS 的编译进应用方案，无 sidecar；解析库本身源码体量大多 < 1 MB，体积瓶颈在渲染/编辑 UI 而不在解析器 |

**本轮被纠正的旧说法（以本次核实为准）：**

1. `zip` 4.6.1“仅 deflate”——错在 Taomni 的 feature 设置，不在 crate：`zip` 4.6.1 的 `default` 特性已含 aes-crypto/bzip2/deflate64/lzma/ppmd/zstd/xz；Taomni 的 `src-tauri/Cargo.toml` 第 135 行写的是 `default-features = false, features = ["deflate-flate2"]`，限制是自己加的。
2. “.mpp 在任何开源路径上都不能保存回去”——已过时：2026 年 9–11 月出现了模板法开源 .mpp 写入器（`pymppwriter`/`mppwriter`，MIT，0.4.3），但全是 alpha / 有损 / 仅 MPP14，不可作主路线。
3. “`.mppx` 是 MS Project 格式”——不是微软官方的独立格式，它就是 MSPDI XML 的别名，按内容识别，不要只认扩展名。
4. pdfium“约 20 MB/平台”——实测约 8 MB/平台（bblanchon chromium/8152：linux .so 7.9 MB、win .dll 7.5 MB）。
5. craft-pdf 是独立格式层——实际是 hayro + krilla 的薄包装（`craft-libs/crates/pdf/Cargo.toml` 直接核实）。
6. `rarchive` 是 RAR 主力——503 次下载、2026-11-09 才创建 6 天历史，不作主力；rars（Apache-2.0，纯 Rust，RAR 1.3–7）才是 spike 首选。
7. “craft-image-codecs 不存在”（某路在过时 README 镜像里检索零命中误判）——GitHub Contents API 直接读到 `crates/image-codecs/Cargo.toml` 与 `lib.rs`，确认存在，是厚包装（统一 `Image` 类型、有界解码、元数据保留、保真度警告）。

**观察对象清单（定期复评，触发条件写清）：** BetterOffice（DOCX spike 通过即转正）、OpenPresent（仓库可公开审计 + 通过 PowerPoint 对照测试后重评）、rxls（审计 + 语料通过后可替代自研补丁层）、mppwriter（出 beta + 补齐日历/约束/基线后重评 .mpp 写回）、cadkit-dwg（真实 DWG 语料 spike 通过后立项）、ebook-rs（真实 MOBI/AZW3 语料 spike）、heic-rs（真实 iPhone HEIC 语料 spike）、unarc-rs（体积与可控性对比手写门面后定）、craft 全系（出 beta/上 crates.io/真实文件往返证据/解决 winit 冲突后重评，每季度一次）。

## 9. 打开流程与编辑语义

### 9.1 路由（`openFile` 的扩展，不另起入口）

1. 用户在文件浏览器、终端链接、SFTP、Tao Agent、邮件附件点开文件 → 现有 `openFile(target, options)`。
2. `classifyFile` 查注册表：核心类型 → 核心渲染器；插件类型 → 查注册表：已安装且启用 → 动态加载插件 chunk；未安装 → 占位页（插件名、简介、去商店安装、或“用系统应用打开”）。
3. 代码类文件仍路由回 CodeWorkspace（现有规则不变）；脏文档（未保存的查看器文档）优先回到已有查看器，不静默另开（现有 `documentStore` 规则不变）。
4. 同一文件重复打开只激活已有 tab（现有去重规则不变）。

### 9.2 编辑语义（各插件统一）

- 脏态、保存、关闭守卫、外部改动冲突提示，沿用查看器 `documentStore` + `closeGuard` 的语义；插件文档也进同一套脏态模型，不各写一套。
- 保存 = 手术式补丁（§2.2）+ 先备份原文件到插件数据目录（保留最近 N 份，N 在插件设置里，默认 3）；保存失败不覆盖原文件，报错里给备份路径。
- 大文件：文本 5 MB/20 MB、图片 32 MB 的上限沿用；Office/PDF/视频按类型在插件页写明上限（如视频转码只接 ≤ 2 GB 的文件，先走 ffmpeg.wasm 兜底的反面教训——不在主路径用它）；超限时明确提示，不静默截断。
- 编码：文本类沿用现有编码选择；Office/PDF/Visio/Project 是二进制格式，不走文本编码。

### 9.3 远程文件

- 沿用现状：远程 SFTP 文件下载成只读临时副本再看（`source: "remote-temp"`，`readOnlyReason` 明确写“只读副本”）；不回传、不在远程原地改。用户要改远程文件，先下载到本地、改完再上传（现有上传流程不变）。
- 临时副本的清理：查看器关闭后按现有临时文件规则释放；转码/解压产生的临时文件由插件宿主在退出时清扫，不留垃圾。

### 9.4 Tao Agent 的接入（P2，不阻塞 P1）

- 插件可向 Tao Agent 工具总线注册只读工具（如“提取本文本”“列出本表前 10 行”“总结本 PDF”），走模块化 v1.4 §5.6 的 scope 检查与确认制；写工具（改文件）必须过用户确认，不绕过安全路径。
- 查看器里的“问 Tao”入口复用现有选择工具条，不另起一套。

## 10. 数据、临时文件与安全

- 数据目录：每个插件唯一可写目录 `应用数据目录/plugins/taoffice-<slug>/`（设置、缓存索引、备份、转码缓存各放子目录）；核心不代写插件数据；备份路径声明进 `module.json` 的 `backupPaths`，供核心备份读取（沿用 v1.4 §5.6 的 S9 扩展点）。
- 临时文件：转码、解压、渲染中间件一律进插件数据目录下的 `tmp/`，不进系统临时目录的不可控位置；应用退出与插件禁用时清扫；转码缓存设上限（默认 2 GB，插件设置可改），超限按最久未用清理。
- HTML/PDF 渲染沙箱：Office/PDF 转 HTML 的渲染走现有 HTML 沙箱思路（token + 自定义 scheme + CSP），不放宽 `script-src` 到任意来源；外链图片与网络请求默认不加载，按查看器 HTML 的代理三模式处理（应用代理默认 / 功能独立代理 / 无代理，沿用 `AGENTS.md`）。
- 压缩包安全：§5.2 的四条（路径逃逸、展开上限、流式、密码提示）是验收项，不是建议。
- 隐私：文件内容不上传、不调云端转换；Office/PDF 的文本提取只在本地做；Tao 的工具调用只读用户明确选中的内容。

## 11. 实施计划（M0 之后；先 spike，后插件）

### 11.1 前置 spike（M0 之前可做，各 1–2 周，任一失败即降级，不硬上）

| # | Spike | 通过标准 | 失败降级 |
|---|---|---|---|
| S1 | `libvisio` → WASM 尽力渲染保真度（主路线已改，`libvisio-rs` 只作隔离对照分支） | 20–50 个真实 .vsdx/.vsd（主题、渐变、阴影、富文本、分组、连接器、数据图形、内嵌图片、EMF 形状各至少 2 个）人工打分可接受；WASM 构建链（Emscripten）工作量可估 | 降级为“尽力渲染 + 明确提示”，保真度边界写进查看器；不硬上 libvisio-rs（GPL） |
| S2 | `mpxj-rs` 解析完整度 | 真实 .mpp（多版本、多日历、基线、自定义字段）解析无关键字段丢失 | 降级为“只读 .xml/.mppx，.mpp 仅基础查看” |
| S3 | Excel 编辑路线三选一（v1.3 已按成熟度排定方向） | IronCalc + 自研 zip+quick-xml 手术补丁：拿 20 个真实工作簿测公式/合并/条件格式/图表/透视表的往返；Univer Pro 只确认“不符合约束”的结论，不再比价；craft-xlsx + GridCraft 只作观察对照 | 降级为“查看 + 单元格文本编辑”，不承诺公式/样式往返 |
| S4 | `ffmpeg-next` 最小 LGPL 构建体积（v1.3：已是 Tier 3 首选，更重要） | 每平台最小构建 ≤ 100 MB（视频插件包总预算内）；动态链接方案可行；HEVC/音频编解码在 LGPL 构建里可用；法务确认静态编入的源码 + 重链接合规方案 | 降级为“只做第一二档播放，第三档调系统应用” |
| S5 | WebCodecs 在 Linux WebKitGTK 的可用性 | 目标 Linux 发行版上 `VideoDecoder.isConfigSupported()` 对 H.264/VP9/AV1 返回可用 | Linux 上 MKV 走转码（第三档），不承诺 WebCodecs 路径 |
| S6 | 手术式补丁是否兑现（Office Oxide `EditableDocument` + BetterOffice 保存，v1.3 改向） | 真实 .docx/.xlsx/.pptx 改一处后，未动 OPC 部件字节不变（以实测为准；craft-docx passthrough vs WordCraft 桥接的两路调研不一致仍记在案，craft 只作对照） | 降级为“全量重存 + 语料库回归兜底”，插件页明示 |
| S7 | FilmCraft 解封装/编解码 crate 的复用（v1.3：降格为并行候选，不再是 Tier 3 首选） | Matroska/ISOBMFF 解封装 + H.264/HEVC/AV1/VP8 解码能 git 依赖进插件宿主并播出画面；通过后可替换 Tier 3 中的主流容器部分，缩小 LGPL 暴露面；冷门格式仍留 ffmpeg-next | 第三档整体走 ffmpeg-next（§8.7），FilmCraft 不阻塞 |
| S8 | craft-libs 接入合规与工具链（v1.3：范围缩小，只在某格式最终仍选 craft 时才需要） | craft-libs 的 workspace license 已核实为 MIT OR Apache-2.0（2026-11-15，见 §8.10）；剩下：应用仓各 crate 的 license 文件抽查、选一组能一起编译的 rev、Rust 1.95+ 与 Taomni 工具链共存、winit/egui fork 与 Tauri 2 的 tao/winit 在同一 workspace 共存、单插件包称重 ≤ 100 MB | 对应格式用 §8.12 的成熟栈，不碰 craft |
| S9 | pdfcraft / gridcraft / deckcraft 的 crate 复用（v1.3：降级为观察，只在 craft 被重新启用时才需要） | `craft-pdf` 的 `raster`/`write` 与 pdfcraft 的 `annot`/`forms`/`sign`，`craft-xlsx` + gridcraft 的 `calc`/`formula`，`craft-pptx` + deckcraft 的 `model`/`render`，各拿真实文件验证一轮 | 对应插件用 §8.12 的成熟栈 |
| S10 | **解码帧进 WebView（新增，最高优先级）** | ffmpeg-next 解码帧 → Tauri WebView/React 的传输方案与性能实测（逐帧 base64 / 共享纹理 / 原生窗口叠加三选一）+ 音画同步方案；在它通过之前，Tier 3 的播放体验不能承诺 | Tier 3 退回“转码后播放”（RM 方案 a），不承诺实时解码播放 |
| S11 | **BetterOffice DOCX + Office Oxide 三格式（新增，1–2 天）** | BetterOffice 打开 10–20 个真实 .docx（含表格/图片/页眉页脚/批注/修订），改一处 → 保存 → 未动部件逐字节 diff + Word 打开验证；同时验证体积（CJK 字体可选裁剪）与 Tauri 打包；Office Oxide 在真实 PPTX 语料上跑 `replace_text`（跨 run 占位符、母版/版式占位符文本、图表内文本、SmartArt、备注页是否覆盖；保存后 PowerPoint/LibreOffice 打开无修复提示；未动 part 字节 diff 是否为零） | DOCX 退路是 Office Oxide + 自研 React 编辑器；PPTX 退路是同标准对照 spike craft-pptx |
| S12 | **pdfium 分发 + RAR + zip 升级（新增）** | pdfium 动态库进 Tauri 打包（三平台 resource 打包、macOS 签名与 notarization 是否放行随包 .dylib、Linux .so 的 rpath）；20–50 个真实 PDF 对比 pdfium-render 与 hayro 的渲染结果（加密 PDF 必须进语料）；`rars` 对真实 WinRAR 语料（RAR4/RAR5、加密头、分卷、损坏文件、恢复记录）的解压正确率与速度/内存；`zip` 4.6.1→9.5.1 升级回归；`unarc-rs` vs 手写门面的二进制体积 | pdfium 分发失败则渲染退回前端 pdf.js + react-pdf（或纯 Rust hayro 直连）；RAR 退回 `unrar` + 合规确认；zip 升级失败则留在 4.6.1 + 只开需要的 features |
| S13 | **craft-libs 未核 crate 对照（新增）** | `craft-epub`/`craft-dwg`/`craft-dxf`/`craft-ical`/`craft-csv`/font 相关 crate 逐个对照本轮推荐库（epub.js、`dxf`、`icalendar`、`csv`、fontkit），决定是沿用本轮推荐还是统一用 craft-libs 格式层 | 沿用本轮推荐，craft 只作格式层统一的远期选项 |

### 11.2 阶段（M0 落地后才开始 M1）

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0（模块化侧） | 插件运行时落地（G1–G10 通过）+ `document` kind + `fileKinds`/`extensions` 字段 + `fs.readUserFile` 权限 | v1.4 的 AC-001–AC-014 |
| M1 核心 | §5.3 分发扩展点 + §5.2 核心压缩包 + CSV 表格视图 + tiff 查看 | AC-T01、AC-T05；核心包体积基线实测 |
| M2 插件第一批（P1） | taoffice-pdf、taoffice-excel、taoffice-video 播放（第一二档） | AC-T02、AC-T03、AC-T04（Excel 语料库） |
| M3 插件第二批（P2） | taoffice-word、taoffice-project、taoffice-video 第三档 | AC-T04（Word/Project 语料库） |
| M4 插件第三批（P3） | taoffice-ppt、taoffice-visio、视频编辑/转码、heic/psd/raw 缩略图 | AC-T04；Visio 保真度抽查 |

### 11.3 任务分解（M1–M4 的卡片级拆分在评审后补进 §11.2 的任务表，不在 v1.0 里虚构工时）

- 每插件一张卡：引擎集成、渲染/编辑 UI、手术式保存、占位页、商店页、语料库回归、体积门禁（CI 里对每个 `.taomni-plugin` 包称重，超 100 MB 即失败）。
- 体积基线：M1 第一件事是实测核心包与每个插件包的体积（Win/macOS/Linux 三端），不是凭感觉报数。

## 12. 测试与验收

- 回归语料库：每种类型 20–50 个真实文件（用户提供的脱敏文件优先；无真实文件时用公开样例），覆盖：Office 的公式/图表/透视表/批注/修订、PDF 的表单/签名/加密、Visio 的母版/EMF/数据图形、Project 的多日历/基线/自定义字段、视频的各容器/编码组合、压缩包的加密/分卷/损坏文件。
- 往返测试：编辑后用原应用（Word/Excel/PowerPoint/Project/Visio）打开，不报错；未改内容逐项比对（Office 用 Office Oxide 的思路：未动部件字节不变）。
- 体积门禁：CI 对每个插件包称重，超 100 MB 失败；核心包不含插件依赖（G9 闭包验证复用）。
- 崩溃回归：每插件的查看器 tab 进 `crash-regression` 套件（沿用仓库 `AGENTS.md` 的要求：新功能必须跑完整 crash-regression 套件再评审）。
- 平台：Win/macOS/Linux 三端都要有真机验证记录；WebKitGTK 的视频能力（S5）与 Linux 的 GStreamer 插件缺失要明示，不写“Linux 同 Windows”。

## 13. 风险与回滚

| # | 风险 | 应对 |
|---|---|---|
| R1 | `libvisio` WASM 渲染保真度不达标，或 `libvisio-rs` 的 GPL 合规不过 | S1 前置；失败即降级为“尽力渲染 + 明确提示”，保真度边界写进查看器；不硬上 libvisio-rs（GPL） |
| R2 | Office 编辑往返丢格式，用户以为是 Word | 插件页与保存前明示能力边界；手术式补丁 + 备份；语料库回归挡住静默丢失 |
| R3 | IronCalc 不成熟，或自研手术补丁保存有缺口 | S3/S11 前置；失败降级为单元格文本编辑；Univer Pro 已确认不符合约束，不再作为备选 |
| R4 | `ffmpeg-next` 体积超 100 MB 或 LGPL 合规不过（v1.3：已是 Tier 3 首选，风险更高） | S4 前置；失败降级为第一二档播放 + 系统应用兜底 |
| R5 | .mpp 写回被用户当成承诺 | 插件页与保存对话框明示“编辑后另存为 XML”；.mpp 写回只作 P3 跟踪，不承诺 |
| R6 | M0 延期，taoffice 跟着延期 | 本设计已接受“等 M0 落地后再做”；M0 之前只做 spike 与核心扩展点，不提前写插件 |
| R7 | 插件前端 chunk 与核心 React 双份 | 沿用 v1.4 §5.3：共享库标 external，运行时由核心提供；CI 检查 chunk 里不含 react |
| R8 | 压缩包/HTML/PDF 的安全问题（路径逃逸、zip 炸弹、XSS） | §5.2 与 §10 的验收项；安全测试进语料库；Zip Slip 防护由 Taomni 自己实现，不假设库已做 |
| R9 | storytold 全系 alpha + git-rev 供应链（v1.3：craft 已降级为备选，风险敞口缩小；只在某格式最终仍选 craft 时才适用） | S6–S9 前置；star 数不作成熟度证据；pin rev + vendor + 定期跟进；任一 spike 失败即用 §8.12 的成熟栈 |
| R10 | craft-libs / WordCraft 的 winit fork 与 Tauri 2 冲突，或单插件包超 100 MB（v1.3：只在用 craft 的格式上适用） | S8 前置，第一周验证共存与称重；失败即用 §8.12 的成熟栈 |
| R11 | storytold 上游快速变化（一个多月从 0.1.0 到 0.18.1），API 与行为不稳定 | pin rev + vendor；S6–S9 在固定 rev 上验证；升级只在有回归语料库时跟进；v1.3 起 craft 只作备选，变化影响已缩小 |
| R12 | 解码帧进 WebView 无成熟方案（新增，最高优先级） | S10 前置；在它通过之前，Tier 3 的播放体验不能承诺；退路是“转码后播放” |
| R13 | pdfium 动态库分发被平台拦截（macOS 签名/notarization、Linux rpath） | S12 前置；失败则渲染退回前端 pdf.js + react-pdf（或纯 Rust hayro 直连） |
| R14 | RAR 没有“又成熟、又 MIT、又纯 Rust”的完美选项（rars 仅 6 个月历史，unrar 许可非 OSI） | S12 前置；rars spike 不通过则用 unrar + 合规确认；RAR 只解压不创建，风险可控 |

回滚：单个插件出问题只回滚该插件（`modules.json` 回退 `sequence`、商店下架该版本），不重发核心；插件卸载不删用户数据（除非显式勾选）。

## 14. 决策记录（用户已决策，2026-11-15）

| # | 决策 | 来源 |
|---|---|---|
| 1 | 内部模块名 taoffice；按独立编译、独立 release、独立下载安装设计 | 用户 2026-11-15 原话 |
| 2 | 核心必带：md、txt、html、代码文件、图片查看、压缩包操作 | 用户 2026-11-15 原话 |
| 3 | 其余类型（Office 等）一个一个独立模块，按需下载安装 | 用户 2026-11-15 原话 |
| 4 | 优先级按核心 → 常用 → 极少用 × 复杂度排 | 用户 2026-11-15 原话 |
| 5 | project = MS Project 的 .mpp、.mppx | 用户 2026-11-15 确认 |
| 6 | Office 要真编辑 | 用户 2026-11-15 确认；“真编辑”的口径见 §0.3 第 1 条（手术式补丁 + 块/表格编辑，不是像素级 Word 克隆） |
| 7 | Visio 必须像 Visio 一样渲染 | 用户 2026-11-15 确认；v1.3 修正口径：没有开源库能完全做到，主路线是 libvisio → WASM 尽力渲染 + 明确提示（§8.5、§0.3 第 2 条） |
| 8 | 视频先支持 mp4/webm/mov/mkv/avi/rm 等常用格式，先播放、再编辑转码 | 用户 2026-11-15 确认；三档见 §8.7 |
| 9 | 压缩包做到查看 + 解压，支持常用压缩格式；优先级高于视频转码 | 用户 2026-11-15 确认 |
| 10 | 远程文件沿用只读临时副本 | 用户 2026-11-15 确认 |
| 11 | 等 M0 插件运行时落地后再做 taoffice | 用户 2026-11-15 确认 |
| 12 | 单个包体积上限 100 MB；接受独立下载、按需安装、不进默认包 | 用户 2026-11-15 确认（“体积底线 100M”按“单个包 ≤ 100 MB”理解） |
| 13 | 第三方实现用 Rust/TS 库集成，不从头做；**不接受 sidecar 形式** | 用户 2026-11-15 确认；口径见 §1.4 |
| 14 | 设计时参考 storytold 的开源实现，尤其 office 系列；按模块化重构已经落地（正在做）的基础设计 | 用户 2026-11-15 10:40、10:43 确认；参考落点见 §8.10；模块化落地状态的核实见 §1.2（2026-11-15 10:43 re-fetch：分支仍只有文档，设计按 v1.4/v1.5 的接口形态走）。**v1.3 更新：五路成熟库横向对比后，首选路线改为混合成熟栈（§8.12），storytold craft-xxx 降级为备选/观察对象；storytold 仍是参考来源之一，不再是首选。** |

### 14.1 仍需用户确认的解释项（§0.3 的三处已写进文档，但口径需要你点头）

- (a) Office“真编辑”按手术式补丁 + 分档理解：Excel 可真编辑，Word 是块编辑（分页/文本框/SmartArt/图表/修订会丢），PPT 只有文本替换。你点头，这个口径就进插件页；不点头，我就得把 PPT/Word 的编辑范围重排。
- (b) Project 编辑后另存为 .xml/.mppx、不存回 .mpp，你是否接受？这是开源路线唯一可行的闭环。
- (c) 视频 RM/RMVB 按“按需转码后播放、优先级最低”处理，你是否接受？在无 sidecar 约束下它是成本最高的一档。
- (d) 手术式补丁是否兑现（S6/S11）：以 spike 实测为准——Office Oxide 的 `EditableDocument` 与 BetterOffice 的保存是否做到“未动 OPC 部件字节不变”；如果实测是不保留，Word/Excel/PPT 插件的保存语义就按“全量重存 + 语料库回归兜底”写进插件页，你是否接受？（craft-docx passthrough vs WordCraft 桥接的两路调研不一致仍记在案，craft 只作对照。）
- (e) 视频第三档首选改为 ffmpeg-next LGPL 静态解码构建（S4），FilmCraft 降格为 S7 并行候选（通过后可替换 Tier 3 中的主流容器部分）；如果 S4 的 LGPL 合规或体积不过，第三档退回“只做第一二档播放 + 系统应用兜底”，你是否接受？
- (f) **首选路线整体从 craft-xxx 改为混合成熟栈（§8.12），craft 降级为备选/观察对象**——DOCX 用 Office Oxide + BetterOffice、XLSX 用 calamine + IronCalc + 自研补丁、PPT 用 office_oxide + PptxViewJS + PptxGenJS、PDF 用 pdfium-render + lopdf + @cantoo/pdf-lib、视频 Tier 3 用 ffmpeg-next、图片/压缩包用 image-rs 生态 + `zip` 9 + `sevenz-rust2` + rars。改动最大的一处是这个，你点头，v1.3 的路线就定下来进评审；不点头，我就把有争议的格式逐个列出来再议。

## 15. 参考

- 模块化拆分设计 v1.4：`docs-feature/taomni-modular-split-design.md`（插件形态 §5.0、清单 §5.1、商店 §6、发布 §7、G1–G10）
- ADR：`claudedocs/adr-taomni-modular-split.md`
- 通用查看器（main `ee9f8062d`）：`src/lib/openFile/classifyFile.ts`、`src/lib/openFile/index.ts`、`src/components/viewer/ViewerShell.tsx`、`src/stores/documentStore.ts`、`src-tauri/src/viewer/*`
- 仓库规则：`AGENTS.md`（外部网络与下载、文件体积、crash-regression）
- 库来源（2026-11-15 检索核实）：pdf.js / pdf-lib / docx-preview / mammoth.js / docx.js / docx-rs / Office Oxide / Univer / IronCalc / calamine / umya-spreadsheet / rust_xlsxwriter / SheetJS / ExcelJS / PPTXjs / PptxGenJS / libvisio-rs / libvisio / vsdxkit / MPXJ / mpxj-rs / Aspose.Diagram / Aspose.Tasks / Mediabunny / ffmpeg-next / ffmpeg.wasm / `zip` / `sevenz-rust2` / `rarchive` / `unrar`

## 修订记录

- v1.0（2026-11-15）：初版。按用户 2026-11-15 的 13 项确认写成；库选型经三路检索核实（Office+PDF、Visio+Project、视频+压缩包）；§0.3、§14.1 的三处口径待用户点头。
- v1.3（2026-11-15）：按五路成熟库横向对比改写首选路线。新增 §8.12（总对比表 + 逐格式新首选 + 被纠正的 7 处旧说法 + 观察对象清单）；§8.1–§8.8 各加 v1.3 首选 bullet（DOCX：Office Oxide + BetterOffice；XLSX：calamine + IronCalc + 自研补丁；PPT：office_oxide + PptxViewJS + PptxGenJS；PDF：pdfium-render + lopdf + @cantoo/pdf-lib；Visio：libvisio → WASM 尽力渲染；Project：mpxj-rs + MSPDI 写出，.mpp 写回列为 P3 跟踪；视频 Tier 3 改为 ffmpeg-next 首选，FilmCraft 降格并行候选；压缩包：zip 9.5.1 + sevenz-rust2 + rars spike）；§8.10/§8.11 的 craft 内容降级为备选/观察对象；§0.3 三处口径全部改写（Office、Visio、.mpp）；spike 从 9 个扩到 13 个（新增 S10 解码帧进 WebView 最高优先级、S11 BetterOffice + Office Oxide、S12 pdfium 分发 + RAR + zip 升级、S13 craft 未核 crate 对照）；§13 风险补 R12–R14，R1/R3/R9–R11 改写；§14 决策 7/14 更新，§14.1 (d)(e) 改写并新增 (f) 首选路线整体改动待确认。被纠正的旧说法：zip 4.6.1“仅 deflate”（实为 Taomni 自己的 feature 设置）、“.mpp 无法写回”（模板法写入器已出现但全是 alpha）、“.mppx 是官方格式”（实为 MSPDI XML 别名）、pdfium“约 20 MB/平台”（实测约 8 MB）、craft-pdf 是独立格式层（实为 hayro + krilla 薄包装）、rarchive 是 RAR 主力（503 下载、6 天历史，不作主力）。
- v1.2（2026-11-15）：新增 §8.11（复用程度详细说明：格式层直接依赖、引擎层适配依赖、UI 全部重开发；逐插件复用表 + 四条集成硬规则）；S3 从二选一改成三选一（Univer Pro / IronCalc / craft-xlsx + GridCraft calc）；删除 §8.10 与 ADR 里关于 craft-anything 的描述（只留 craft-extensions 无插件运行时的前提纠正）；§8.10 的许可证核实更新（craft-libs workspace license 经 API 核实为 MIT OR Apache-2.0，rust-version 1.95），S8 的许可证核对项相应缩小。
- v1.1（2026-11-15）：按 storytold 参考改写。新增 §8.10（craft-libs 格式层 + Craft 套件应用仓 + filmcraft 视频路线 + 两处前提纠正）；§0.3 第 1 条改写（Word 有了更强的 Rust 路线，但仍是 alpha、无 React 渲染器）；§1.2 补 10:43 re-fetch 核实（模块化分支仍只有文档）；§11 spike 从 5 个扩到 9 个（S6–S9 为 storytold 接入验证）；§13 风险补 R9–R11；§14 补第 14 项决策与 14.1 (d)(e) 两项待确认。v1.0 的 §8.1–§8.8 库选型保留作备选，不删除。
