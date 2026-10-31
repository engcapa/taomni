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
- Linux 已用匹配最终源码的隔离 QA release，在公开 Commons Lang 工程实际执行 Ctrl+click、重复跳转及关闭/重新打开；三平台结果按各平台实际执行报告单独核验。

没有引入超过 800 行的文件，没有改变原有 facade/IPC 边界，不涉及性能优化。

回归测试同时收紧两项既有前置条件：provider preview 必须等真实 editor pane 挂载；Replace in Files 的工作区撤销明确将焦点放在结果行，防止迟到的编辑器挂载抢占 Ctrl+Z。这保留了编辑器输入导致请求过期、跨文件撤销和排除文件不写入的全部原断言，不通过增加超时或放宽结果来回避失败。补强后的五项组合（Java/C#/TypeScript 标签 + preview stale + excluded replace undo）通过。

`pnpm check:refactor` 已通过（768 commands、328 facade exports、39 literal events；919 implementation modules；4178 files）。`qa_ui_auto audit --gate` 和三平台 selected plan 通过。完整 mounted 集已通过：19 files / 378 passed / 0 failed（`/tmp/taomni-navigation-final-378.log`）。分屏就绪 helper 增加最少已挂载编辑器数量，survivor-history 场景明确等待两个 CodeMirror，保留 dirty cancel、history、LSP 释放和保存字节断言。先前本地浏览器 crash 8/8 通过，只作为测试前置条件补强前的辅助证据。

## 最终源码的本机原生验证

修复提交为 `9818711781f82297ebc8d0933a1509e67218e378`；`64fc13951ee380ab7a809c8ad196085b72e3ab6e` 只补强分屏测试就绪条件。后者为本轮 GitHub 验证的精确 head。

本机 Linux C6-06 **1/1 passed，98 步全部通过**，报告位于 `/tmp/taomni-definition-tabs-native-report-02/run-20261031-132036-219734859/`。回执签名及 12 个附件的字节数、SHA256 已核验。已检查最终截图：`ImmutablePair.java`、`Pair.java`、`Map.java` 三个独立外层标签，`Map.java` 被选中并显示真实 JDK 只读源码。此处使用 JDK 21；Java/C#/TypeScript 的 mounted 回归使用替代的 LSP/磁盘边界，不表述为 C#/TypeScript 原生语言服务器实测。

最终 QA release 构建日志为 `/tmp/taomni-navigation-build-04.log`。source 指纹为 `219ae61571a8b54b0f5d8c16fea3e04af3c123194961a72b7071c99f07d5fbf6`，runner 指纹为 `95ca5805bb1bcb492837d23cda668b6216ce7cb0910991dddea0a74b3617e3ee`。首轮本机原生运行因代理未绕过 loopback，在 WebDriver setup 阶段失败且未执行用例；同时设置 `NO_PROXY/no_proxy` 后，以相同输入完成上述通过运行。失败日志和报告保留，不计入通过证据。

## GitHub 三平台最终验收

[workflow 41171099386](https://github.com/engcapa/taomni/actions/runs/41171099386) 已 **success**，head 精确为 `64fc13951ee380ab7a809c8ad196085b72e3ab6e`。13 个用例 ID、6 份执行报告共 **57 passed /0 failed /0 skipped**，精确 selection 与实际执行逐项一致，无能力缺口或未评审用例。C6-05/C6-06 在三平台共 6 次原生执行通过，完整适用 crash-regression 共 51 次通过。

| 平台 | browser crash-regression | native：Java 两项与 crash-regression |
| --- | --- | --- |
| Linux / Ubuntu 24.04 Xvfb / WebKitGTK | 8/8 | 11/11 |
| Windows x64 / WebView2 | 8/8 | 11/11 |
| macOS ARM64 / WKWebView | 8/8 | 11/11 |

三平台分别使用匹配上述 source 的隔离 QA release，输入身份在执行期间稳定；原始构建 producer 和二进制指纹保留。C6-06 指纹为 `089999b3df493d7cf883e85c72c9468fedd6552977a200ba834c554ea830c011`，各平台 98 步全部通过。已分别检查三平台最终源码截图：源文件、Pair.java、Map.java 分立，Map.java 正确选中且只读。Linux/Windows 的 `rt.jar/…/Map.class?…` 和 macOS 的 `java.base/…/Map.class?…` 均显示可读的 Map.java 标签。

三平台都实际下载 Apache Commons Lang 3.17.0，固定 revision `29ccc7665f3bc5d84155a3092ab2209a053324e6`，归档 SHA256 `6cf65d8a31af5025115e5690a3e980baf256ff3bfe0e4d0abf746360acf388f0`；已独立核验各自 `project.json` 的 revision、归档指纹及 `compiled: true`，保留源码归档和编译日志。本地未设置 `QA_JAVA_PROJECT_ROOT` 时的预期 skip 不混入 hosted 通过数。

6 份回执签名及 **1,087 个附件**的字节数和 SHA256 全部核验。Windows 路径分隔符只在本地查找附件时转换，不修改原始回执。CI 汇总与维护中的 `aggregate` 独立复核均为 `passed/report_ok`，基础设施错误为零。证据入口为 `qa-ui-auto-report/_local/workspace-41171099386/`，链接至 `/tmp/taomni-definition-tabs-hosted/`，保留原始 artifacts、`github-run.json`、selection、`verify-evidence.py`、`reports/local-aggregate-check.json` 和 `reports/verified-evidence.json`。

调度参数为 `scope=selected`、三平台、`modes=browser,native`、`native_release=true`、`shards=1`、`browser_workers=1`、`publish_issues=false`。三平台 release 构建及 Windows capture helper 合同本轮通过；Rust 产品代码、依赖和工具链契约未改变，沿用 [41060730487](https://github.com/engcapa/taomni/actions/runs/41060730487) 的原生合同结果，`run_rdp_unit_contracts=false`。selected 策略跳过全工具合同及开发合同 job，不将跳过表述为本轮执行通过；本机 dev contract、catalog gate 和 `pnpm check:refactor` 已通过。

首轮 [41170568373](https://github.com/engcapa/taomni/actions/runs/41170568373) 在 `98187117` 上调度，后为将完整测试就绪修正一并绑定到精确 head 而主动取消，不计入通过结果。此次最终证据归档只改文档，不改变 source/case/runner 指纹，复用本轮已通过证据，不再重编或重跑。性能继续 TODO，不恢复 main 比较。
