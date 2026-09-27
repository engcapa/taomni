# ED-PARITY-008/009 IDEA 参照摘要

- **采样身份**：IntelliJ IDEA Ultimate 2026.2.2, IU-262.10315.125；Windows 11 远程桌面，1920x1080，DPI 96，深色主题；2026-09-27 15:45–15:57（Asia/Shanghai）。原始截图、输入记录和 fixture 在被忽略目录 `qa-ui-auto-report/idea-reference/p1-remaining/run-20260927/`。
- **桌面边界**：每个动作前确认 IDEA PID 30860、前台窗口和 Default desktop。15:55 有一次远程桌面断开，动作记录为无效并丢弃；中文输入法首次键入模板污染，`s12` 起改用剪贴板并保留污染原件。

## F3 / ED-PARITY-008

隔离工程包含 `repo-a`、`repo-b` 两个无远端 Git 仓库，各自有固定 baseline commit。repo-a 有 index+worktree 双态、未跟踪文件；repo-b 有 worktree 修改。Commit 工具窗口同时显示两个 repo 的分组、分支 `main`、文件数和各自 change；选择 `repo-a/same.txt` 打开 `HEAD → WORKTREE` diff 后可切换 `repo-b/same.txt`，顶部显示 1/2、2/2 文件导航且 diff 内容、路径和 hash 随仓库切换。截图 `g01`, `g03`, `g05` 是有效状态。

可观察保留语义：切换 repo 不混入另一仓库的路径/内容；返回编辑器不改变编辑器文本；关闭 diff/Commit 不写 Git。IDEA 本次未执行 stage/commit/冲突合并，这些边界由 P2 以取消/零写入用例验证。

## F2 / ED-PARITY-009

Java fixture `StructuralTarget.java` 含 3 个真实 `System.out.println` 调用（单行、数字、跨行）、注释/字符串中的伪匹配、`System.out.print` 与 `System.err.println` 反例。IDEA 用 `Search Structurally…` 打开独立 Structural Search 工具窗口，语言下拉显示 Java，模板编辑器显示 `$arg$`，右侧可加 Count/Reference/Text/Type/Script modifier，底部可选 In Project/Module/Directory/Scope。

- 模板 `System.out.println($arg$);` 在 In Project 返回 **3 results**，结果树按 class → method → locations 展开并高亮源码。
- 为 `$arg$` 加 Text=`42` 后返回 **1 result**，精确定位 `System.out.println(42);`；Text=999 的无匹配状态为空结果。
- 取消/关闭工具窗口返回编辑器；未执行替换。截图 `s04`、`s12`、`s13`、`s45`、`s47`、`s56`、`s57`、`s39` 为有效或边界原件。

这证明 IDEA 的 AST/语义匹配排除了注释、字符串和相似但不同方法调用；不能推出 Taomni 已有 SSR。采样工程因未设置 Project JDK 出现警告，P2 应使用明确 JDK/索引 ready fixture 重采一次。

## 未观测与复用边界

未观测 macOS/Linux、重启/持久模板、全部 scope 组合、Replace、Script/Reference modifier、Git staged/unstaged 多 hunk、冲突/abort、Taomni 双侧运行。该摘要是采样输入，不是 comparison schema 的 matched 记录。
