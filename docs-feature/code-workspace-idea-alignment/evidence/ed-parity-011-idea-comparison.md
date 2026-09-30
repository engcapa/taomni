# ED-PARITY-011 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11（[控件级复核 §2](../references/idea-control-audit-20260929.md#editor-surface)，`idea-03/04/21/29/30`）。
- Taomni：分支 `feat/ed-parity-011-editor-surface`，browser Chromium。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| 编辑区顶部条 | 无 | 常驻 file-status 行移除，改为右上浮动检查 widget（TC-011-01 R1）；语言服务降级改为编辑区右下气泡（CHROME-02 保留） | matched；read-only/编码条保留（IDEA 同样用编辑器通知条） |
| 检查 widget | `⚠1 ˄ ˅` / `Analyzing…` / ✓ | HighlightingWidget + LSP pill 浮于右上 | 结构 matched；图标样式 different（019） |
| breadcrumb | 状态栏导航栏，含类/方法 | Breadcrumbs 渲染进状态栏导航栏，Alt+Home 可进入（TC-011-01 R2、NAV-01） | matched |
| Go to File → Enter | 正式 tab，连开三次 3 个 tab | 同（TC-011-02） | matched |
| tab 类型图标/活动描边/错误波浪线 | 有 | 有（TC-011-01 R3、`data-has-errors`） | 结构 matched；图标集为字母徽标，different（accepted） |
| tab 溢出 | `˅` 下拉 | `˅` 下拉（原 testid） | matched |
| 默认折叠 import | 是 | 是（TC-011-03 R1、`importFold.test.ts`） | matched |
| 默认折叠单行方法体 | 是 | 未做（依赖 provider 结构，交 022） | different |
| 折叠标记 | hover/当前块 | gutter hover 显示 | 交互 matched（当前块常显未做） |
| 选区 AI 工具条 | 无此元素 | 只在拖选/Shift 扩选出现，位于选区下方（TC-011-03 R2） | different（DEC-ALIGN-08 待用户决定是否移除） |
| 字体/行高 profile | Source Code Pro 16 / 28px | 未统一 | unverified（019） |
