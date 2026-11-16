# 合并 main 与 DeepSeek 原生扩展验证 · 2026-11-16

分支：`feat/tao-home-follow-up`。本轮在既有用户反馈修复后，合并远程 main，并扩展真实 DeepSeek / Taomni native 测试。新授权总测试预算上限为 **2M tokens**；短合成输入、受限请求数量及 usage 记录用于控制消耗，不以花满预算作为覆盖目标。临时凭据只从本机文件读取，不写入报告或上传 GitHub。仅明确失效/过期凭据可记录 `credential-invalid` 成功，其他错误继续失败。

## 1. main 合并与冲突处理

- 合并前分支提交：`0dd598e6f`。
- 通过配置代理获取的 `origin/main`：`e8e3afc0f`（含 PR #820 / `15fa24bee`）。
- 两侧共同基线：`6170f095f`。远程新增内容只修改终端文件链接实现及其测试，目标同为避免延迟激活抢走用户已选择的终端页签。
- 冲突文件：`src/components/terminal/panel/fileLinks.ts`、`src/components/terminal/panel/fileLinks.test.ts`。
- 实现处理：保留当前分支由共享 `openFile` 一次负责身份、去重与激活的实现。main 虽删除 1000/3000ms 重试，仍有 50/250ms 的延迟激活；重新引入它们会覆盖用户立即切回终端的选择。保留 main 的修复意图，而不是重新加回短延迟抢焦点。
- 测试处理：合并 main 的可调整 workspace mock、完整 viewer fixture 和初始 store 重置，保留当前分支的 fake timers / 清理；增加 `0ms` 与 `350ms` 两种用户切回时机，每种同时验证首次与重复链接打开。确认打开会展示 viewer，随后用户手动回终端，在 3.5 秒后仍保持终端。
- 已执行：`fileLinks.test.ts` 与 `openFile.test.ts` **2 files / 12 tests passed**；`pnpm check:refactor` 与 `git diff --check` 通过。合并后匹配构建及真实终端 modifier-click 保留回归待本轮 native 执行，单元结果不替代该原生证据。

## 2. 原生扩测范围与结果口径

| 场景组 | 目标与必要观察 | 当前状态 |
|---|---|---|
| 基础与多轮 | 中文/英文、代码说明、上下文回忆、重新生成、Stop/Continue、草稿、原会话/分支隔离 | 既有 TC005/011/013 本轮需重新执行，并补未覆盖步骤 |
| 图片 | 真实系统文件选择、PNG/JPEG/WebP 上传、进度/失败、正文引用与识别、重复上传、移除引用/删除及后台任务 | 待实现并执行新 native case；不将仅出现文件 chip 算成识别通过 |
| 代码与文档 | 多语言 fenced code、表格/Mermaid、复制、代码附件/PDF，附件能力冲突的明确错误及恢复 | 待实现并执行新 native case；磁盘/剪贴板结果需原生观察 |
| 模型、模式与联网 | Flash/Pro、Ask/Act/Research、thinking/web 开关、真实工具来源/usage、切换与新线程默认值 | 待实现并执行；服务实际拒绝必须保留结果，不能静默当作成功 |
| 本地资料与执行 | 工作区/终端/Notes 引用、脱敏预览、明确引用后发送，合成安全动作的确认/拒绝/实际结果/撤销 | 待按实现能力细化并执行；仅在隔离测试目录操作 |
| 会话与生命周期 | 多线程流式切换、Stop 后继续、编辑/重试、历史搜索、重启持久化、主题/语言/侧栏操作 | 待扩展并执行；重启与同进程历史恢复分别记录 |
| 辅助功能 | 设置、演示模式、归档导出、记忆/技能/工作流与语音入口的可达/取消/错误恢复 | 待核查并执行；依赖设备/模型/系统权限的未执行部分明确记录 |

所有商业请求必须从真实桌面 UI 经 Tauri 后端到 DeepSeek；自动化观察只转发原调用/回调并记录白名单元数据，不替换 provider、响应或内部状态。每个新 case 登记 policy/dependencies、明确动作与结果断言。图片/代码实际能力、失败与修复、请求数、已知 usage、截图、源码/runner/build 身份及 browser/native 保留回归将追加在本文件。既有完整跨平台结果见 [上一批回执](verification-2026-11-16.md)，不能冒充本批新源码执行。
