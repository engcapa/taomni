# 工作区文件打开与 SDK 后台初始化

当前状态：实现和本机单测完成，GitHub browser/native 验收待执行。正式性能对照仍未通过，不把本轮单测称为性能验收。关联[重构实现报告](./workspace-platform-redesign-implementation-report.md)。

## 目标与保留行为

- 空工作区、添加目录、浏览 txt/log/csv/json/Markdown 等普通文件时，不自动启动 SDK 注册表解析、版本探测或语言服务发现。用户主动打开 SDK 对话框和刷新仍可解析当前目录。
- 源码先读取、显示和编辑，SDK/语言服务在后台初始化。重开正在关闭的文件仍先等待原有资源清理，清理完成后不再等待 provider；保留最新 dirty buffer 和 didClose/didOpen 顺序。
- 每次成功添加目录都显示当前工作区的 Project 树并展开目标 root，包括第二个目录和重复选择已有目录。取消、被动导航和迟到的其他工作区操作保留当前侧栏偏好。
- 保留语言服务的文档队列、增量同步、诊断作用域、重启、Java bundles 配置、SDK 绑定、错误、手动刷新与 watcher 生命周期。不改变 IPC 名称、持久化格式、原有 5 秒 SDK 超时或缓存 TTL。

## 实现边界

`useWorkspaceServerDiscovery` 单独拥有自动发现、配置与迟到响应失效。产品 runtime 使用已有扩展名分类器，从真实打开的源码 buffer 推导需求；Project 树的历史 `languagePanelOpen` 开关不是语言服务需求。

`useWorkspaceSdkResolution` 按源码需求或显式对话框解析 SDK，以 root 定义而非临时数组引用识别变化，并拒绝取消、隐藏、卸载后的迟到结果。未检测时显示中性 SDK 状态；真实版本命令的 `installation.lastError` 可见。

后端 `sdk/resolution_cache` 合并同 root 的并发解析，不同 root 独立。注册表修订在解析期间变化时重新解析，错误和既有缓存时效保持原语义；取消会释放该 root 的等待锁。Weak owner 表不永久保留所有访问目录的锁。

`workspaceFolderReveal` 是明确成功操作的显示边界；平台 Add Folder 与旧编辑器 Add Root 均接入。回调保持稳定，避免通过命令注册引发重复渲染。Project 不因单纯切换文件、返回模式或恢复旧工作区而被强制展开。

## 改前证据

产品 source `6294904349ed0130a2eeccbee4214e1f62d8b14523ec29657248581bbcb73b3c`：

- [40746813409](https://github.com/engcapa/taomni/actions/runs/40746813409)：17 passed / 5 failed。普通文件场景仍触发发现、第二 root 未显示 Project，SDK exit-1 的实际错误正文未显示。原始回执与汇总已独立核验。
- [40749400862](https://github.com/engcapa/taomni/actions/runs/40749400862)：16 passed / 1 failed。Java 打开 653.8ms；编辑 1540.9ms 超过既定 1500ms。同项目出现四个并发真实 SDK 版本进程。DOM 已含预期编辑内容，这不能单独证明数秒主线程冻结。
- [40743957940](https://github.com/engcapa/taomni/actions/runs/40743957940)：全量 2115 passed / 3 failed。macOS 慢 LSP 与 RDP 剪贴板为功能失败，不能套用性能例外；RDP 性能 p95 90.153292ms 超过 65ms，按用户授权单列。

## 验证

本机只运行单测与静态检查，没有运行 browser/native UI 用例，并发测试 worker 不超过 2。

- 相关 hook、SDK UI、文件操作、资源恢复及真实编辑器生命周期：7 文件 / 77 tests passed。
- 目录对话框、共享代码编辑器与侧栏：3 文件 / 16 tests passed。
- Rust SDK：37 passed，包含真实 SDK 子进程的并发合并、不同 root、迟到注册表更新、失败 TTL 重试、取消重试五项合同。
- SDK 原生观察工具：7 tests passed，拒绝把多个真实版本进程当成一次共享后台探测。
- TypeScript 与 refactor 合同通过；提取模块不超过 800 行，未改变公共命令、事件及 facade 导出。

托管验收集合包括 `TC-WS-059` 至 `063`、`TC-WS-043`、文件打开/保存/恢复与 LSP 保留场景，以及完整 10 ID `crash-regression`。059 覆盖普通文件保存重开与显式 SDK 刷新；060 覆盖多 root、重复选择、取消及侧栏状态；061/062/063 使用真实待完成 SDK 子进程和真实转发 IPC，在原有 1500ms 操作预算内验证编辑、模式切换、普通文件打开、失败正文、迟到 LSP、dirty 内容及磁盘 SHA。正式结果在当前源码的 GitHub 运行完成后填写，旧源码通过记录不替代本轮验收。
