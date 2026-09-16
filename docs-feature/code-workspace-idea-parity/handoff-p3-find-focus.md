# P3 交接提示词：ED-FINDFOCUS-001

你接手 Taomni Code Workspace IDEA 对齐任务 `WP-FIND-FOCUS-01 / ED-FINDFOCUS-001`。先读取并遵守：

- `AGENTS.md`
- `.agents/skills/code-workspace-idea-task/SKILL.md`
- `.agents/skills/qa-ui-auto/SKILL.md`
- `.agents/skills/code-workspace-idea-parity/SKILL.md`
- `claudedocs/code-workspace-idea-parity-backlog-find-focus.md`
- `docs-issue/code-workspace-find-focus-design.md`
- `docs-feature/code-workspace-idea-parity/references/find-focus-2026.2.2.md`
- `qa-ui-auto-report/find-focus-20260914/evidence.json`

不要重领 done 卡，不创建新任务，不扩展到无关 Smart/SSR/Git/Debug 工作，不启动 P4。除非后续明确授权，不提交、推送、合并或发布。

当前板卡状态为 `implemented`，生产实现与 focused/browser 验证已完成，涉及：

- Find 打开时延迟 focus/select，并取消 stale focus；
- tree 输入自动选第一匹配，Enter/Shift+Enter 循环导航；
- Esc 关闭并回原 view，保留当前匹配 selection；
- 默认单行 Find，Replace 可由展开入口和 Ctrl/Cmd+R 到达；
- Search 输入的 Enter/Escape 不被 window capture 抢走；
- Find 打开时隐藏正文浮动 selection toolbar；
- hyperlink modifier 清理避免 CodeMirror nested update；
- clipboard owner 使用 `contentDOM.contains`，旧请求在切到 Find 后继续失效；
- read-only buffer 禁用 Replace。

已通过：focused unit（45 项）、browser `TC-IDE-FINDFOCUS-01`（13.2s）、scoped typecheck、`qa-ui-auto audit --gate`，并成功构建 QA binary。参照包 SHA-256：`fa328fa968648123d8a3da67858bf7ab7208e690f8ff0177f9ed9f52444f5cb`。

## P3 必须补齐的证据

1. Windows native packaged WebView：使用真实目标窗口和匹配 fixture/settings，核对 source/case/runner/config/build identity；复用 binary 前检查 source identity，若代码有后续改动须重新运行 `native_build.py`。
2. 真实 Windows 键盘与 Microsoft Pinyin：验证 Ctrl/Cmd+F、中文 IME composition、确认、取消、焦点保持与 Esc 恢复；记录失败时是产品、runner、provider/accessibility 还是环境故障。
3. 验证 clipboard owner、连续 Find 操作、selection 保留、dirty/save/undo/recovery，不把 browser/stubs 结果外推为 native。
4. 若环境可用，补真实 provider/JDK/JDT LS 下的多 workspace/multi-pane owner 与定义导航回归；F0 本身不依赖 provider。
5. 独立 accessibility/keyboard path 和 200% zoom 检查，确认 Find 输入、tree、Replace 展开、结果导航仍可用。

此前 native 尝试的已知结果：

- `assert_not_visible` 不适配 native runner；隐藏 Replace row 的断言不能照搬该写法。
- native query 清空后仍显示 `1 / 2`，疑似 runner fill/focus 行为问题，需用受支持的真实键盘操作区分 runner 与产品。
- 手工 Microsoft Pinyin 输入产生中文“我的胳膊”后焦点丢失，因此 native/provider/accessibility 尚未通过；不能把这次结果写成 PASS。

恢复步骤：确认桌面可独占、目标窗口身份与焦点；按 `qa-ui-auto` 支持的当前端操作重跑最小 Find case；必要时先重新 build QA binary，再复核 source/artifact hash；保存原始日志和截图，更新 `qa-ui-auto-report/find-focus-20260914/evidence.json` 与任务板。只有所有 required native/provider/accessibility evidence 通过后，才能把 `ED-FINDFOCUS-001` 更新为 `done`。Windows 已验证后，macOS/Linux 仍记录为未验证及步骤。

交付时报告实际命令、平台、模式、构建/复用次数、耗时、功能/UI/交互结论、失败与 stale/skip/未验证项，并提供总需求矩阵场景 `REQ-01 / CW-SEARCH-001 / CW-SHELL-002` 的证据映射。
