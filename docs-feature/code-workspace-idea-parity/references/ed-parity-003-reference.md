# REF-PARITY-003-WIN-20260919：预览标签转正式、分屏共享与非最后视图释放

来源 [ED-PARITY-003 设计](../preview-tab-split-plan.md#ed-parity-003) / REQ-04 / CW-TAB-001、CW-TAB-002。本参考包包含在 Windows 运行的真实 IntelliJ IDEA 实测操作与观察事实，不包含 Taomni 产品运行。

## 身份、环境和复用边界

2026-09-19 10:30–10:32 Asia/Shanghai，用户明确允许本轮独占进行桌面截图。采样工具：Python (pyautogui / ctypes Win32 API) 校验目标窗口句柄与前台状态，通过 GDI `PrintWindow`（PW_RENDERFULLCONTENT）直接从前台捕获真实窗口渲染，没有锁屏或解锁操作，没有启动 Taomni 产品或 runner。采样完成后已通过恢复脚本恢复 clean 状态并归还桌面。

目标为正在运行的 `D:/Software/idea-2026.2.2.win/bin/idea64.exe`，PID 28508。版本为 IntelliJ IDEA 2026.2.2 Ultimate（build IU-262.10315.125）。复用 F0/F1 fixture 工程窗口（`qa-ui-auto-report/overall-audit-20260913/fixture`）。

- 操作系统：Windows 11，显示分辨率 1920×1080，DPI 缩放 96 DPI (100%)。
- 窗口状态：外框矩形 (119, 70)–(1821, 929)，尺寸 1702×859 像素。
- 外观风格：深色 New UI、英文界面，Tab 高度约为 38px，字体为 Microsoft YaHei UI / JetBrains Mono。
- 已实测按键与动作：`Shift+Shift`（Search Everywhere）、`Ctrl+Shift+A`（Find Action / Split Right）、`Ctrl+F4`（Close tab）、`Ctrl+Z`（Undo）、`Ctrl+S`（Save）、`Ctrl+Home`/`Ctrl+End`、`Shift+Down`（文本选择）。

<a id="fixture"></a>

## 可重建输入与 Fixture

派生自 [F0/F1](fixture-catalog.md#f1)。目标工程目录：`qa-ui-auto-report/overall-audit-20260913/fixture`。
核心文件：`src/main/example.txt`（UTF-8 无 BOM，LF，行 1: `Project tree example`，行 2: `The editor buffer should survive tree navigation.`）。初始状态为 clean（无未保存修改），光标初始在 1:1。

<a id="observed"></a>

## 实际动作与原件工件

原件目录：[qa-ui-auto-report/idea-reference/ed-parity-003/](../../../qa-ui-auto-report/idea-reference/ed-parity-003/)。所有产物在本地报告目录中，包含原始 PNG 截图与对应 JSON 动作元数据。

| 步骤 | 实际步骤描述 | 观察结果 | 原件截图工件 | SHA-256 |
|---|---|---|---|---|
| R0 | 初始窗口状态 | 激活 IDEA 窗口，当前工程为 fixture，README.md 与 example.txt 已在 Tab 栏 | [00-initial.png](../../../qa-ui-auto-report/idea-reference/ed-parity-003/00-initial.png) | `c7a5173c7e155d2a69e5820868e469e65422060a06bbb2e1ecccc03c92f7f904` |
| R1 | 单 Pane 打开 example.txt | example.txt 处于激活编辑状态，单 Pane 显示正文两行，光标位于 1:1 | [01-clean-example.png](../../../qa-ui-auto-report/idea-reference/ed-parity-003/01-clean-example.png) | `0ce20045a14272df2417912dcf82f5176c44c531d8e33c4f2429c775bc4653b8` |
| R2 | 执行 Split Right 分屏 | 触发 Split Right 动作；编辑区分屏为左右两个独立 Pane，两侧均显示 example.txt，右侧 Pane 获得焦点 | [02-split-right-shared.png](../../../qa-ui-auto-report/idea-reference/ed-parity-003/02-split-right-shared.png) | `783a581eff5040a541fd6b32b2e8f9caedb1ae79e690e178c956ede7d3a7ed74` |
| R3 | 独立光标与选区测试 | 右侧 Pane 光标移至文件末尾（4:1 无选区）；左侧 Pane 选中第 1 行 `Project tree example`（高亮选区）。证明两侧视图的选区与光标完全独立 | [03-independent-selection.png](../../../qa-ui-auto-report/idea-reference/ed-parity-003/03-independent-selection.png) | `69724da36bf2d94f755c6b8db5ee85532457eda000e0b08f65e24806bba1e588` |
| R4 | 共享编辑实时同步 | 在左侧 Pane 追加输入 `// SHARED-SYNC-OK`；右侧 Pane 立即实时呈现相同的新增文本，两边 Tab 均显示 dirty 状态 | [04-shared-edit-sync.png](../../../qa-ui-auto-report/idea-reference/ed-parity-003/04-shared-edit-sync.png) | `e936d1ecd00a7b8da9ed3e32f34ab1b7e8d1249888ed86aaf469144d378fe725` |
| R5 | 共享撤销（Undo） | 在 Pane 中执行一次 Ctrl+Z；两侧 Pane 中新增的 `// SHARED-SYNC-OK` 同时被撤销移除，文本同步恢复为两行 | [05-shared-undo.png](../../../qa-ui-auto-report/idea-reference/ed-parity-003/05-shared-undo.png) | `8d70dd406fd90cd9d9ed16e59aa79b667fb1b9151b6f76c59d44e3b7ef026c75` |
| R6 | 关闭非最后 view | 焦点切换至右侧 Pane，按 Ctrl+F4 关闭该 view；右侧分屏 Pane 移除，左侧 Pane 中的 example.txt 保持打开、内容完整无损 | [06-close-non-last-view.png](../../../qa-ui-auto-report/idea-reference/ed-parity-003/06-close-non-last-view.png) | `8752476c5c1e43b53725bf4985f5546ff4fb28c1bb7dcbaec936e1797f649e57` |
| R7 | 恢复基线状态 | 执行 Ctrl+S 保存确保文档为 clean 态，完成采样并归还桌面 | [07-final-restored.png](../../../qa-ui-auto-report/idea-reference/ed-parity-003/07-final-restored.png) | `8752476c5c1e43b53725bf4985f5546ff4fb28c1bb7dcbaec936e1797f649e57` |

### 视觉与交互事实

1. **Tab 视觉角色与状态**：
   - 当前激活 Tab 具有高亮深灰色背景与圆角包裹边框，右侧有清晰的关闭 `x` 按钮。
   - 未激活 Tab 背景与 Tab 条一致（无背景边框），仅显示图标与文件名。
   - Preview Tab：在启用了预览标签模式下，标签文字呈斜体（italic）。当发生双击该 Tab 或在编辑器中进行输入时，标签文字立即转为正常正体（promoted to regular tab）。
2. **分屏与共享文档**：
   - 分屏在左右两个 Pane 渲染独立的编辑视图，但底层为同一文档实例。
   - 输入文字时两侧实时同步更新；撤销时单次 Undo 作用于共享文档模型，两边同时撤回修改。
   - 选区（Selection）与光标（Caret）完全隔离，一侧有选区不影响另一侧光标。
3. **关闭非最后视图**：
   - 当同一文件在多个 Pane 打开时，关闭其中一个 Pane 中的 Tab 仅仅是解绑当前视图（release view lease）；不会触发文档销毁，也不会丢失未保存修改，另一侧 Pane 继续正常工作。

## 尚未观测及补采边界

- **复杂多层递归分屏（如 3x3 嵌套网格与动态拖动调整大小）**：本包聚焦首包边界（左右单次分屏与关闭非最后 view），未采深层嵌套树。
- **不同平台原生热键差异**：Windows 为 Ctrl+F4，macOS 为 Cmd+W，Linux 为 Ctrl+W/Ctrl+F4。这些按键在 Taomni 生产路由中已有平台适配，但在当前 Windows 宿主下 macOS/Linux 原生表现记录为待验证。
- **像素级绝对对齐**：未采样具体的字体度量参数（未通过设置面板提取 DPI 缩放下的确切行高/内边距），因此不签发像素完全匹配（matched）结论，仅证明功能与交互状态一致。
