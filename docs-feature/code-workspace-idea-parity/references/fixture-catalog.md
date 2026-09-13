# 场景 fixture 与环境边界

本文是矩阵的可重建输入目录。**只有 F0 本轮已准备并采样**；F1–F5 是补采规格，未创建运行结果。每个场景还要执行矩阵所列正常、取消、错误和恢复步骤，不能因共享 fixture 而共享通过结论。

<a id="f0"></a>
## F0：项目树与无 provider 的纯文本工作区

权威内容来自 [.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/project_tree.py](../../../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/project_tree.py) 的 `SEED_FILES`。四个文件 UTF-8 无 BOM / LF；本轮磁盘隔离副本和 browser VFS 使用相同字节。初始无 Git/SDK/运行配置；IDEA 自建元文件不计 fixture。

| 相对文件 | SHA-256 |
|---|---|
| README.md | `129d0894d94b5ee43912087eea91c53d6e1ef86ff3d1fc12e6d4aaa612252c6f` |
| src/main/example.txt | `bbbab91a4e4ea594b1e2207721999dc375ac98c30c5960cfbbf1329a441aa01a` |
| docs/notes.txt | `32b23e9c2f782364b0b923f37ffbfe08b43574ef978fa758626065ebd4f9e3cd` |
| tests/sample.txt | `6076b94485933c3a8d3d9aad9468cac29ba559c68734a95b263b6bf9b3a6cb0f` |

本轮 browser 为 `/preview/fixture`，host 副本为 `qa-ui-auto-report/overall-audit-20260913/fixture`。IDEA旧参照的原始 fixture 位于 `qa-ui-auto-report/project-tree-e2e/fixture`；只复用四个种子文件，不能把旧 `.idea` 设置当成已确认配置。

复原：建空隔离目录，按上述 Python 常量写入 UTF-8 字节；清空的只是本轮隔离副本。browser 准备参见 raw `seed.js`，写入专用 IndexedDB，不能称 native disk 证据。打开 README 源码态；root 展开，docs/src/tests 折叠；初始 caret=1:1、selection 空、dirty=false。每组操作前记录实际初态，不依赖上组遗留选择。

<a id="f1"></a>
## F1：编辑、标签策略与可撤销保存（待准备）

复制 F0 到新的隔离目录，新增 `edit.txt`（UTF-8/LF）：

```text
alpha Alpha ALPHA
tree tree
line three
```

为 tab eviction 复制 `tab-01.txt` 到 `tab-32.txt`，内容为相应文件名加 LF。分别建立 clean、dirty（只在本次测试副本编辑）、pinned、preview 状态；不通过注入 store 代替用户打开/固定/编辑。缩小 limit 的预览、取消、实际关闭、最后视图释放、重开都要有可观察结果。编辑前后保存全文 hash 与 selection。剪贴板必须隔离或保存恢复；物理 IME 另记，W3C 按键不能证明 IME。

<a id="f2"></a>
## F2：Java 工程与真实语义 / Build / Debug（待准备）

先复用现有可重建 fixture 源：`src/components/editor/workspace/__fixtures__/jdtls/projects/` 下的 `maven-single`、`maven-multi-module`、`gradle-single`、`gradle-multi-module`、`maven-broken-classpath`。每次运行复制到报告目录，核对当前源码与依赖后写一份实际 manifest；不直接操作工程中的测试 seed。此前 App.java 语法问题的历史记录不是本次编译事实。

首个语义最小样例可以先用离线两类工程：`Main.java` 引用 `Helper.greet()`，Helper 返回确定字符串；新增只在注释/字符串中的同名词，另有一个编译错误用于 Quick Fix。扩展场景加同名类跨 module、外部库只读源码、泛型/重载、被引用方法、存在副作用表达式；每次扩展记录 hash 与 ID 修订。进入条件：

- 实际项目 JDK 与 source language level 已记录；JDT LS 运行 JDK 21+ 的要求与 IDEA 自带 JBR 不是同一件事。
- IDEA build IU-262.10315.125，记录 Ultimate 授权/Java 插件、import/index ready；Taomni 记录 JDT LS 完整版本/命令/Java extensions、workspace/project generation。
- Maven/Gradle 工具及依赖缓存就绪；失败工程明确用于 degraded 状态，不用作成功场景。
- Debug 额外记录 java-debug bundle/DAP adapter 版本、launch config、断点实际 verified 状态；Tests 额外记录测试框架；coverage 记录真实报告来源。

本轮未连接任何真实 LSP/DAP，也未编译/运行上述工程。将 browser `No LSP`、Facts Failed、Debug disabled 直接当 native 产品缺陷是错误归因。

<a id="f3"></a>
## F3：Git 多根与冲突（待准备）

在报告目录创建两个本地 Git 仓库，无远端；使用本地 fixture 身份提交固定种子（未来采样范围内，绝不提交 Taomni 工程）。先记录 HEAD、index、worktree hash。一个仓库有修改/未跟踪/重命名文件，另一个只有 clean 文件；两个分支分别修改同一行，准备 merge/rebase/cherry-pick 的可取消冲突。

双侧以相同 commit graph 和字节操作：浏览 diff、选择 hunk、stage/unstage、提交选择、日志定位；在独立分支制造冲突，采 preview、取消/abort 与恢复。禁止把 push/pull 的网络成功静默包含在本地场景中；远端认证与网络失败另需明确测试环境。本轮未创建 Git fixture、未提交、未 push。

<a id="f4"></a>
## F4：语言 / edition 边界（待定 provider 后准备）

| 语言或能力 | Taomni 源码基础 | IDEA 目标边界 / 必补证据 |
|---|---|---|
| Plain text / Markdown / JSON / XML / YAML | CodeMirror language 包、MarkdownPreview、本地编辑命令 | 先采核心编辑；Markdown 预览与源码态须一致。格式化 provider 和 IDEA 插件各自记录 |
| Java | LSP/JDT LS、工程 facts、Java debug/test extensions | 主代表语言；语义完备性不能从通用 LSP 协议推定，逐动作比较同工程 |
| Kotlin | 未证明与 IDEA Kotlin 分析器等价的生产 provider | 保留 IDEA 常用 JVM 目标；先核对 Taomni语言/自定义provider接入和目标插件，再拆需求，不静默排除 |
| JavaScript / TypeScript / HTML / CSS | CodeMirror 语法包及可配置 LSP | Ultimate / 对应插件与 TS SDK/Node 环境待核对；不能从 Java 结果推广 |
| Python / Go / Rust / C/C++ / PHP / SQL | 语法高亮与相应 LSP/自定义命令基础；实际安装本轮未探测 | IDEA 对这些语言的支持需逐插件/edition 核对；官方对应独立 IDE 不自动等价 IDEA 目标。保留待决目标，不直接记“排除” |
| Smart / Type-Matching / Full Line | Smart action 当前禁用；Full Line 只有 companion model；没有可用生产全链证明 | IDEA 具体语言、模型安装、edition、硬件/隐私选项待采；不是 Basic Completion 的重命名 |
| SSR / injected language / scratches | SSR backend 未接入证据；其他行为待查目标与入口 | IDEA 内建语言支持与完整插件生态分开；场景仍保留在矩阵或待决扩展登记 |

每个变体必须建立文件内容、预期结果集合、provider/SDK版本；没有外部版本时标为未验证，不用单个 Java 通过缩小范围。完整第三方插件生态默认排除，仅指无限插件集合；不排除实现所选 IDEA 语言场景所需的内建/明确插件能力。

<a id="f5"></a>
## F5：恢复 / 大文件 / 三端（待准备）

在 F1 副本上分别构造 UTF-8 BOM、UTF-16、CRLF/LF、Unicode 路径、大小写不同路径、只读/锁定文件、外部修改、1 MiB 与 5 MiB 文件、多个 workspace 的同名文件。每变体独立记录 hash，避免把异常变体混入普通保存基线。

Windows/WebView2 当前待采：同源 QA、真实文件写入/回读、外部冲突、Ctrl/AltGr/IME、剪贴板、窗口恢复。Linux/WebKitGTK 与 macOS/WKWebView：计划相同用户结果，用各平台正确路径/键位/窗口工具，分别列未验证。仅样式和 browser 结果不能替代这三种 native 边界。

性能只在单独匹配 baseline/candidate 后记录原始样本与实际端点；本轮无性能测量，不输出延迟改善或对齐百分比。
