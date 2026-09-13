<a id="ed-tree-001"></a>

# Project tree 键盘导航与焦点交互对齐修复设计

## 状态与范围

状态：本卡 Windows 范围已验证。基线 HEAD：`7c38e41f4c84320e2ebc70a1b9d15133b943cc42`。目标平台为 Windows；Linux/macOS 需要保持可构建并记录未在本轮运行。范围限定为 Code Workspace 左侧 Project tree 的选择、方向键导航、展开/折叠、Enter 打开和右键菜单焦点，不扩展到完整 IDEA Project view 能力盘点。

参照：[REF-TREE-2026-09-13](../docs-feature/code-workspace-idea-parity/references/project-tree-navigation-2026.2.2.md)。本卡对齐普通方向键和选中/失焦视觉角色；目录单击切换、文件单击永久打开与 Ctrl+Enter 分屏保留，明确属于本轮尚未与 IDEA 统一的行为。Home/End 是本卡补齐的导航边界，未声明已做 IDEA 同键采样。

IDEA 2026.2.2（IU-262.10315.125，IntelliJ Dark New UI）在隔离 fixture 上实测：单击目录只选择；Down/Up 只移动选择；Right 在折叠目录上展开，在展开目录上进入首个子项；Left 从子项回到父目录，从父目录折叠；Enter 打开选中文件；右键菜单覆盖编辑区，Escape 取消后文件仍保持选择。

## 现状、复现与根因

生产入口为 `CodeWorkspaceTab.tsx` 的 `handleTreeKeyDown`，行元素由 `ProjectTree.tsx` 渲染并通过 `FileTreePane.tsx` 承载。当前 Up/Down 对目标行调用 `.click()`，因此移动到文件会触发打开、移动到目录会触发展开/折叠。当前 Left/Right 也对当前目录调用 `.click()`，两者都变成同一切换动作，不能表达 IDEA 的父子导航。导航候选还遗漏 loose file 行，且 aside 范围会把工具栏按键带入树处理。

复现：打开包含 `src/main/example.txt` 的 fixture，聚焦 Project tree，选择 `src`，按 Right、Right、Left、Left、Down/Up。预期分别为展开、进入子项、回父项、折叠和只改变选择；当前实现会调用行 click，导致文件打开或目录切换。该差异已由 IDEA 真实截图 `qa-ui-auto-report/project-tree-e2e/idea/09-right-expand.png`、`10-right-child.png`、`11-left-parent.png`、`12-left-collapse.png`、`13-down-select-src.png`、`31-down-example.png`、`32-enter-example.png` 对照确认。

## 修复契约

- **ED-TREE-001-A1**：Up/Down/Home/End 在可见树行间移动选择、保持编辑器当前 buffer 与展开状态，不调用打开或切换副作用；支持 root、directory、file、flat 与 loose rows。
- **ED-TREE-001-A2**：Right/Left 遵循 IDEA 方向语义：折叠目录 Right 展开，已展开目录 Right 进入首个可见子项；子项 Left 选择父目录，父目录 Left 折叠；文件 Right/Left 只导航到父级或保持选择。
- **ED-TREE-001-A3**：Enter 打开选中文件；Ctrl/Meta+Enter 的既有分屏打开、F2/Delete、右键菜单目标与 Escape 取消行为继续通过；编辑器已打开 tab 和内容不因导航改变。
- **ED-TREE-001-A4**：树行暴露 `aria-selected`、目录 `aria-expanded`、稳定层级/路径属性，并区分树有焦点与失焦的选中视觉状态；工具栏按钮不被树导航处理。

## 实施任务

- **TASK-1**：将可见行导航与父子关系计算提取为 `workspace/projectTreeNavigation.ts`，`CodeWorkspaceTab.tsx` 保留事件分派和 open/split owner；增加 Home/End 和 loose rows，限制事件目标为 tree body。
- **TASK-2**：在 `ProjectTree.tsx`/样式中补齐 tree/treeitem 语义、expanded/selected/focus 状态和层级属性，保持现有 compact/flat 映射及点击打开契约。
- **TASK-3**：在 `CodeWorkspaceTab.test.tsx` 增加 baseline 暴露问题的 mounted 回归，并保留 Ctrl+Enter split、context menu、编辑器 buffer 相关测试。
- **TASK-4**：新增 `qa-ui-auto-tests/cases/TC-IDE-TREE-01-project-tree-keyboard-native.testcase.yaml`，在隔离 fixture 中批量验证方向键、Enter、右键取消和真实文件/编辑器结果；更新 covers/feature-list 后运行一次 audit。

## 验证计划与边界

本轮实施与验证已记录在 [skill E2E 评估](../docs-feature/code-workspace-idea-parity/skill-e2e-project-tree.md)。实跑另修复保存触发 watcher 后展开目录缓存未重载的问题，属于本卡保存后导航回归的阻断；对应 owner 为 `useWorkspaceFileActions.ts`。最终状态以工作包任务板为准。

快速迭代：目标 mounted 测试与 FileTreePane/toolbar 现有测试；随后 scoped typecheck。稳定后只构建一次隔离 QA binary，运行上述 native case（Windows WebView2）；浏览器 case 只证明 renderer。IDEA 截图用于交互/视觉比较，不把 validator 退出码当作对齐通过。Linux/macOS 原生和屏幕阅读器本轮未运行。

失败/取消恢复：方向键不得改变打开文件、磁盘或 history；Enter/open 失败沿现有 toast/错误 owner；右键 Escape 不改变所选文件。若异步目录加载中，旧选择不得覆盖新选择。
