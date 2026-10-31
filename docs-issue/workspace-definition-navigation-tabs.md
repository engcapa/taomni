# Workspace 定义跳转与外层标签同步修复

## 问题与复现

用户在 Linux 打开 Java 源文件，点击引用类跳转，编辑内容已切换，Workspace 外层却仍选中原文件；部分目标标签出现 URI/查询串式名称。问题位于共享编辑器宿主契约，适用于其他语言的虚拟源码和根目录外文件。

修复前 HEAD：`bea7cb01`。新增 mounted 回归使用真实 CodeWorkspace、WorkspaceCodeEditor、WorkspaceTabStrip，仅替代磁盘/LSP 边界。Java `jdt://…/String.class?=java.base` 和 C# `csharp:/metadata/…` 均到达目标内容，但找不到选中的 String.java/String.cs 外层标签（两项失败，`/tmp/taomni-navigation-baseline.log`）。以前 C6-06 保留了通用 CODE 标签，只断言编辑内容/历史，无法发现外层文件标签与缓冲区不一致。

## 原因和修复

- `useWorkspaceHostFiles` 发布快照时排除了 library 和 loose 缓冲区；外层宿主只投影 root 类型。现在快照覆盖所有打开文档，宿主使用原始 `CodeWorkspaceFileRef`，保留 URI 身份，不将 URI 规范化成磁盘相对路径。
- 原 loose 激活会回退到通用 CODE 标签。现在复用真实文件标签，新的目标随包含标题的完整快照发布；目标标题来自编辑器的可读 `title`，而非切割 URI 的最后一段。
- 新的外层目标标识继续兼容旧 root 标签 ID；普通 loose 文件可恢复、编辑和保存，provider 源码只保留运行期标签，不写入磁盘恢复列表/草稿，也不会持久化其 initialFile；关闭后立即退出的迟到 context 和旧版本残留的 provider initialFile 都按普通 loose 文件登记表清理。
- 关闭、切换、split、dirty 恢复继续交由原编辑器 owner；外层菜单也通过同一文件引用查找菜单。公开编辑器/LSP IPC 和磁盘写入契约不变。
- 旧 recent/Sessions 入口在恢复时同时登记普通 loose 文件和初始目标，避免宿主将已有合法的外部文件误判为已关闭。

## 验收与保留行为

- Java/C# 虚拟源码以及 TypeScript 根目录外磁盘文件：源/目标分立标签、可读标题、选择与内容一致、重复跳转去重、关闭后再次打开；虚拟源码保持只读且不读写磁盘、不持久化 URI。
- root 文件原有选择、dirty/save/undo、StrictMode、工作区切换、即时关闭后重载、split、恢复与错误状态由现有 Workspace lifecycle/host/store 测试继续保护。
- C6-06 改为关闭通用 CODE 标签后验证同文件跳转不增加标签，Pair.java/JDK Map.java 新增并激活对应外层标签；增加真实 Mod+click、重复跳转及关闭/重新打开。原字段位置、历史恢复、源文件/POM 哈希断言保留。
- 当前验证结果及原生截图将在本轮执行完成后补录。Linux 结果不外推为其他平台实际验证。

没有引入超过 800 行的文件，没有改变原有 facade/IPC 边界，不涉及性能优化。

回归测试同时收紧两项既有前置条件：provider preview 必须等真实 editor pane 挂载；Replace in Files 的工作区撤销明确将焦点放在结果行，防止迟到的编辑器挂载抢占 Ctrl+Z。这保留了编辑器输入导致请求过期、跨文件撤销和排除文件不写入的全部原断言，不通过增加超时或放宽结果来回避失败。补强后的五项组合（Java/C#/TypeScript 标签 + preview stale + excluded replace undo）通过。

`pnpm check:refactor` 已通过（768 commands、328 facade exports、39 literal events；919 implementation modules；4178 files）。`qa_ui_auto audit --gate` 和三平台 selected plan 通过。完整 mounted 集已通过：19 files / 378 passed / 0 failed（`/tmp/taomni-navigation-final-378.log`）。分屏就绪 helper 增加最少已挂载编辑器数量，survivor-history 场景明确等待两个 CodeMirror，保留 dirty cancel、history、LSP 释放和保存字节断言。匹配最终源码的 GitHub browser/native 结果待本轮验证后补录；先前本地浏览器 crash 8/8 通过，只作为测试前置条件补强前的辅助证据。
