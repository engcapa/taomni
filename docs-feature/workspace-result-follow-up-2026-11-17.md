# Workspace / Git / 导出 / Query Result 与 Agnes 完善

当前分支直接实施；本轮仅覆盖用户优先的六项。代码起点 `078e33bfe`。

## 行为与保留契约

- AC-01：Changes（单仓库、多仓库）及 Logs 文件右键显式“用 Tao 打开”，复用统一 file viewer / source editor，支持既有格式；保留 Diff、复制路径、系统定位、终端与工作区归属。打开的是工作树文件，日志 Diff 仍展示所选修订；不支持的类型不伪装成内置打开。
- AC-02：默认与自建 Workspace 均可改名；trim、拒绝空名，ID、根目录、tabs 与默认不可删除规则保留。Notes 是专用系统空间，保留其身份。
- AC-03：现有添加目录弹窗内选择“加入当前工作区 / 创建新工作区”；默认保留加入当前。新名称默认目录 basename，可修改；路径改变时仅更新未手改名称。取消无副作用，迟到 chooser 不修改其他请求；新建原子创建、激活并挂载根目录，不移动磁盘数据。
- AC-04：导出成功提示首位主要按钮使用 Tao；支持格式直接打开独立 tab，Markdown 图片包打开其中 MD；未有内置 viewer 的 PDF/Word/draw.io 使用 Tao 文件管理器显示产物。次要按钮继续系统文件管理器。保留菜单、导出目录、异步所有权、源文档内容与打印/PDF 分离。
- AC-05：隔离 QA release 用 Agnes / agnes-2.5-pro-beta 真实调用，401/403 不能作为成功；密钥只读临时文件，不记录/上传。沿用 provider 代理模式、Vault、流式/取消/历史。先取基线，依据响应诊断，不猜测鉴权绕过。
- AC-06：Query Result 搜索仍按可见命中单元格计数、忽略大小写；增加上/下一个、当前/总数、循环与空态禁用。按排序和过滤后的显示顺序定位，跨虚拟化与水平滚动可见，导航切回 Table。不替代行过滤，不改数据。

## 局部决定

DEC-01（agent 自决，现有成熟控件）：复用 ContextMenu、app prompt、现有添加目录弹窗、工具栏按钮；不引入新依赖或独立页面。
DEC-02（agent 自决，既有 viewer 能力）：导出未支持格式使用 Tao Explorer，并用“在 Tao 中显示”准确命名；不将系统打开冒称内置查看。
DEC-03（agent 自决，平台惯例）：仅结果区域拥有焦点时 Cmd/Ctrl+F 聚焦搜索，F3/Shift+F3 导航；搜索框 Enter/Shift+Enter；macOS Cmd+G/Cmd+Shift+G。编辑、IME、其他 pane/SQL editor 不被接管，按钮提供相同操作。原生菜单 accelerator 不新增。

快捷键验收边界：DB002 在真实数据库与打包 WebView 中验证焦点、可见命中和滚动；macOS 的 `press` 使用 WKWebView 桥接，不能据此声称完成 OS 层按键送达、真实菜单栏点击或所有 macOS 版本/Intel 的验证。AppKit 菜单规格没有新增 Find/Next accelerator；本轮不把上述未覆盖范围计作通过。

## 实施与验证

- TASK-01 / V-01：共享 Git action / 支持类型、Workspace owner；focused unit + 两种 Changes 和 Logs UI/native 文件读取。
- TASK-02 / V-02：Workspace 改名与添加目标；mounted unit + browser/native 新建、取消、命名、切换及持久化；保留 multi-root 文件/目录创建用例。
- TASK-03 / V-03：独立 Export result actions owner；unit + browser/native 实际保存、打开与源文档保留。
- TASK-04 / V-04：独立 Grid search hook / bar；unit + browser/native 会话入口、快捷键、虚拟化、排序/过滤、空态。
- TASK-05 / V-05：Agnes 真实基线与修复回归、严格 oracle；本地 native，不把 key 发送到 hosted。
- V-06：本地受影响 units、refactor/build gate、完整 browser 18 / native 22 crash-regression；匹配 QA release。Windows/macOS 使用 qa-ui-auto-platforms，runner 执行中收集完成 shard，保存至 HDD；原始失败保留并补跑相关失败。

## 当前验证记录（本轮完成）

- 受影响前端单测：37 文件 / 258 断言中，首次有 1 项 Workspace 持久化异步时序超时；保留原始失败，相应用例与导出动作合计 2 文件 / 16 断言补跑通过。
- Rust `deepseek_app::`：49/49 通过；runner outcome 10/10、receipt 11/11 通过；TypeScript、refactor 边界与 source size 检查通过。
- Linux browser：23/23（含完整 18 项 crash-regression）通过，另补跑导出打开错误恢复 TC-FILE-OPEN-024 通过。
- Agnes：`https://apihub.agnes-ai.com/v1` / `agnes-2.5-pro-beta`，明确无代理。匹配上一批源码的 QA release 已在 `native/run-20261117-160433-349710605` 完成 TC-TAO-HOME-047，非空真实回复、0 错误、566 input / 52 output tokens；全部环境代理指向不可达的 `127.0.0.1:9` 仍成功。后续 Mermaid 产品变更后再次取当前源码回执；不以基线或旧指纹冒充当前验收。
- 首轮 Linux native 完整 31 项为 27 pass / 4 fail，运行中调整 DB 用例导致整批 identity 不稳定，不作为最终完整验收。DB 搜索改点横向滚动后可见的 label 表头，具名补跑已通过；HTML 导出改检查普通文档标题，避免要求已转为矢量路径的 Mermaid 文字仍出现在 HTML 原始文本中。邮件等待与系统文件管理器抢焦点另行保留诊断。
- 首轮 hosted [44043296197](https://github.com/engcapa/taomni/actions/runs/44043296197)：Windows/macOS browser 各 24/24；native 分别 28/31、29/31。两端共有 DB 表头与 HTML 文字检查失败，Windows 另有 WS-038 在执行步骤前根节点启动超时。原始失败不覆盖，新版复跑纳入本轮修正与完整 crash 集合。
- 后续 Mermaid 修复后，当前产品 `97e89ead9` 的 Linux browser 有效并集为 28/28（18 项 crash），Linux native 为 33/33（22 项 crash）。native 完整批次 30/33 的三项用例时序/焦点问题已在 `run-20261117-173646-156961843` 全部补跑通过；签名、源码/runner/QA release、用例、配置与绑定文件散列独立核验通过。修正用例提交 `00696cf81`，未改变产品和 runner。
- 当前产品 hosted [44052981988](https://github.com/engcapa/taomni/actions/runs/44052981988)：Windows/macOS browser 各 28/28（18 项 crash），native 均 31/33（全部 22 项 crash 通过）；失败为两端相同的旧 023 隐藏 Explorer 定位和 026 异步写盘等待。运行期间已持续下载完成的分片并检查，不等待 summary；原始失败保留。
- 当前源码 Agnes：`native/run-20261117-173954-824087751` 中 047 为 1/1、identity stable；真实回复 38 字符，566 input / 65 output tokens、0 错误。provider 为 none，外部环境代理不可达，仅本地 WebDriver/应用地址豁免；修正过一次清空 NO_PROXY 导致本地 setup 超时的测试环境失误，该次未发送模型请求。当前回执的签名、QA release、用例/配置及 13 个绑定产物复核通过；整个报告扫描无原始密钥。
- 两端 native 用例修正复跑：[44057813183](https://github.com/engcapa/taomni/actions/runs/44057813183) 成功结束；选 023/026/WS085 与完整 crash-regression，Windows/macOS 各 25/25（完整 22 项 crash）。八片均在 workflow 结束前下载并核验，保持原批次和原始失败证据。
- 本机原始报告、单测日志与失败保存在 `/data-raw-hdd/temp/taomni-six-20261117/`；工作区报告入口为指向该目录的链接。GitHub 证据也使用 HDD，跳过下载原生构建包，避免重复占用 SSD。

最终当前有效并集：Linux/Windows/macOS browser 各 28/28（18 项 crash），native 各 33/33（22 项 crash）；Linux Agnes 另外 1/1。源码/runner/匹配 QA release、用例指纹、配置、回执签名与全部绑定文件大小/散列独立核验见证据根 `independent-mermaid-evidence.json/.log`。后续 Mermaid 追加修复及其 149 项 Markdown 单测、实际 draw.io 文件检查，详见 [修复验收](../docs-issue/markdown-mermaid-editable-export-2026-11-17.md)。本轮六项及追加修复已完成，不将旧 follow-up 全部缺口计入本轮交付。
