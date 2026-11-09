# Notes 编辑光标与显示内容错位

基线：`1baeb208e`。用户报告 Windows 11 的 Notes 输入框光标与文字错位，其他系统未发现。当前工作端为 Linux；GitHub 托管 Windows 使用 Windows Server 2025/WebView2，不能代替物理 Win11 的 DPI/IME 验证。

## 证据与修复边界

源码事实：`NoteEditor.tsx` 在标题/正文包含 URL 时同时渲染真实 input/textarea 和 `notes-link-overlay`。`src/styles/notes.css` 将真实文字及选择文字设为透明，光标仍由输入框绘制。Overlay 继承容器字体，输入框具有独立字号/字重；链接还有额外字重，正文滚动只同步纵向，标题横向滚动未同步。两套排版可能在字体回退、换行和滚动时分离。

根因假设：Win11 字体回退/字号差异放大了这类双层渲染误差。当前没有物理 Win11 复现证据，不把源码推断写成 Win11 已复现。

DEC-01（agent 自决）：保留失焦后的链接预览、Ctrl/Cmd+Click、主题和便签元数据；聚焦后隐藏 overlay，由原生输入框同时绘制文字、选区和光标。无需更换编辑器或迁移笔记。标题/正文的 overlay 使用与对应输入框一致的字号/字重以改善失焦预览。

## 验收与验证

- AC-01 / TASK-01：输入含 URL、中英文和换行时，聚焦编辑只显示输入框文字，光标移动后的插入位置正确。
- AC-02 / TASK-01：失焦后恢复链接预览，保留 Ctrl/Cmd+Click 与原有编辑/保存行为。
- AC-03 / TASK-02：关闭并重开笔记后内容保留；三端样式兼容，无运行时异常。
- V-01：`NotesPanel.test.tsx`、`notesStore.test.ts`、`noteLinks.test.ts` 改前 24/24 通过。
- V-02：`TC-NOTES-008`（browser/native）先运行改前失败探针，再执行候选；保留实际报告身份。
- V-03：GitHub `.github/workflows/qa-ui-auto-platforms.yml` 三端 browser/native 定向用例及完整 `crash-regression` 集合，native 使用匹配源码的 release QA 构建。
- V-04（待真机）：Win11 的 100%、125%、150%、200% 缩放下，中英文、长行换行、横纵滚动、选区与 IME 组合输入；macOS WKWebView、Linux WebKitGTK 通过托管 native 执行，物理键盘/输入法仍单列。

改后单测、改前失败、GitHub run 链接与最终结果在交付文档回填。截图不单独证明光标与文字度量一致；自动化同时检查可见文字层、焦点状态、实际键盘插入结果及重新打开后的内容。
