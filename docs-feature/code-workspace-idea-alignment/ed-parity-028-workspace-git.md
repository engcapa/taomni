# Workspace 专属 Git 页整合

<a id="ed-parity-028"></a>

2026-10-09，基线 `57cde15f`。用户明确要求将 IDEA 对齐的 Git 管理能力迁到 Workspace 专属页，替代 ED-PARITY-018 的底部嵌入位置决定；历史卡与历史证据保留。复用 018 的 IDEA Git/Commit 功能参照与 008 的多仓库上下文契约，不宣称布局与 IDEA 相同。

当前 CodeWorkspaceTab 同时提供底部 WorkspaceGitManager 与独立 Git 页；Workspace Changes 只提供首个目录的 GitPanel，且独立管理器的 Open in Editor 创建单目录工作区。此次统一这些入口。GitPanel/WorkspaceGitManager 的提交、暂存、diff、log、分支、标签、stash、设置及取消/错误处理继续复用。编辑器 gutter/blame/rollback 保留。

## 验收

- ED-PARITY-028-A1：Changes、工具栏、Git/Commit Actions、Alt+9/Alt+0、Commit rail 打开同一 Workspace Git 页；不在编辑器底部再嵌入管理器。首次从 Changes 打开也探测所有目录内仓库，非 Git 目录、加载与失败可见，失败可重试；迟到结果不污染其他 Workspace。
- ED-PARITY-028-A2：Git 页由 canonical Workspace 持有，切换 Surface、关闭 Files 后保持；目录变更重探测，删除 Workspace 依循已有 Surface 清理契约。管理器实例保留提交草稿、scope、diff 选择；原多仓库同名文件、迟到 diff 与取消零写入契约继续成立。
- ED-PARITY-028-A3：Open in Editor 返回所属 Workspace，按真实 repo/path 映射到原 root，复用已打开编辑器及 dirty buffer；重复打开同一文件仍定位它。Files 返回保留文档、选择与撤销历史。Git Shift+Esc 返回 Files；不拦截模态弹窗的 Escape。
- ED-PARITY-028-A4：沿用原有主题、Lucide 图标和完整 Git 控件；移除重复嵌入带来的拥挤，补齐三端 browser/native 入口与回归证据。

## 实施边界

WorkspaceChrome 创建 Workspace Changes 描述符；独立 WorkspaceGitSurface 负责目录探测、加载/重试和稳定管理器生命周期；MainLayout 负责 dedup、scope 与 Git→Files 路由；CodeWorkspaceTab 接收重复可识别的打开请求并将 Git Action 转到独立 Surface。GitPanel/WorkspaceGitManager 的 Git 副作用及后端契约不改。

## Test cases

1. 更新 `TC-IDE-PARITY-018-01`：reset_db + parity008_git，打开原多目录 workspace；Alt+9 → 专属 manager，两仓库状态；输入提交草稿，Shift+Esc → Files；Commit rail 与 Alt+0 再进同实例，草稿、选中项保留；无嵌入 Git dock。对应 A1/A2/A4。
2. 更新 `TC-IDE-PARITY-018-02` native：真实 parity008 repo fixture，编辑文件不保存，经快捷键打开 Git、查看两个仓库、返回原 editor，dirty 文本保留；对 index、HEAD、worktree 做原哈希断言。三端执行，不能用 browser stub 证明零写入。对应 A1/A3/A4。
3. 新增 `TC-WS-019` browser：从 Workspace Changes 首次打开多仓库；选 repo-b 同名文件，Open in Editor 复用 Files；dirty 后再切换、关闭 Files 并返回 Changes，草稿仍在；覆盖不存在仓库与重试状态由定向 mounted tests 支撑。对应 A1/A2/A3。
4. 保留并执行 `TC-IDE-PARITY-008-01/02/03`：多仓库 diff 身份、迟到结果、编辑器选区、真实磁盘取消零写入。原测试返回入口如变更仅调整 selector，保留效果断言。

Windows 本机与 Linux/macOS GitHub workflow 使用隔离 fixture。UI 布局细项由 browser 三端验证；完整本地 unit、一次组合 typecheck、稳定源码后的 native 构建归本次 Workspace 集成任务承担。当前所有新增契约均待实现/待验证；证据回填于 Workspace implementation 文档，不能借历史 PASS 认定本次完成。
