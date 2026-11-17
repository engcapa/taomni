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

## 实施与验证

- TASK-01 / V-01：共享 Git action / 支持类型、Workspace owner；focused unit + 两种 Changes 和 Logs UI/native 文件读取。
- TASK-02 / V-02：Workspace 改名与添加目标；mounted unit + browser/native 新建、取消、命名、切换及持久化；保留 multi-root 文件/目录创建用例。
- TASK-03 / V-03：独立 Export result actions owner；unit + browser/native 实际保存、打开与源文档保留。
- TASK-04 / V-04：独立 Grid search hook / bar；unit + browser/native 会话入口、快捷键、虚拟化、排序/过滤、空态。
- TASK-05 / V-05：Agnes 真实基线与修复回归、严格 oracle；本地 native，不把 key 发送到 hosted。
- V-06：本地受影响 units、refactor/build gate、完整 browser 18 / native 22 crash-regression；匹配 QA release。Windows/macOS 使用 qa-ui-auto-platforms，runner 执行中收集完成 shard，保存至 HDD；原始失败保留并补跑相关失败。

## 当前验证记录（执行中）

- 受影响前端单测：37 文件 / 258 断言中，首次有 1 项 Workspace 持久化异步时序超时；保留原始失败，相应用例与导出动作合计 2 文件 / 16 断言补跑通过。
- Rust `deepseek_app::`：49/49 通过；runner outcome 10/10、receipt 11/11 通过；TypeScript、refactor 边界与 source size 检查通过。
- Linux browser：23/23（含完整 18 项 crash-regression）通过，另补跑导出打开错误恢复 TC-FILE-OPEN-024 通过。
- Agnes 基线：`https://apihub.agnes-ai.com/v1` / `agnes-2.5-pro-beta`，明确无代理。直接 HTTP 流式诊断 200 / DONE；原 QA 二进制内取得非空回复，但期间代码变化导致整份 receipt 身份不稳定，故仅作基线，不作为交付验收。正在构建匹配当前代码的 QA release，随后重新取证。
- 本机原始报告、单测日志与失败保存在 `/data-raw-hdd/temp/taomni-six-20261117/`；工作区报告入口为指向该目录的链接。GitHub 证据也使用 HDD，跳过下载原生构建包，避免重复占用 SSD。

当前 native 和 Windows/macOS hosted 验证仍待完成，结果另行回填。不将旧 follow-up 全部缺口计入本轮交付。
