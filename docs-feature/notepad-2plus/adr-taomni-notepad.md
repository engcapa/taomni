# ADR: Taomni 接入 Notepad++ 功能

- 状态：提议（随设计文档 `docs-feature/notepad-2plus/taomni-notepad-design.md` v1.0 一起评审）
- 日期：2026-11-21（北京时间）
- 基线：main `44a9392d4`；Notepad++ v8.9.9.1（2026-11-11）；用户决策 89 支持 / 43 不支持 / 1 待定（`docs-feature/notepad-2plus/taomni-notepad-decisions.md`）

## 背景

Taomni 有两条 CodeMirror 6 编辑栈：通用查看器（`ViewerShell` → `TextEditor`，功能面窄）与 CodeWorkspace（`CodeMirrorHost`，功能面宽）。Notepad++ 的通用文本功能（89 项）需要一个落点，但 main 上没有任何插件运行时（`plugin_invoke` 0 命中，`module.json` / `modules.json` 全仓无文件），taoffice 的 7 个插件仍等 M0。

## 决策

1. **89 项全部放核心，不做插件、不等 M0。** 插件形态只在 `refactor/modules-arch` 分支上有代码，未合并进 main；本设计不因插件体系未落地而推迟文本功能。
2. **不换编辑器内核，继续用 CodeMirror 6。** 不引入 Scintilla（Notepad++ 的内核）或 Monaco；用户已决策“Scintilla 编辑命令集”不支持。
3. **主战场是通用查看器，工作区能力下放复用。** 新建共享层 `src/lib/notepad/`（纯 TS 文本变换 + CodeMirror 命令表），查看器与工作区共用同一份命令实现，不留两份排序/大小写/行操作。
4. **宏录命令，不录按键。** 可录命令白名单制（编辑/查找/视图命令可录，弹窗类不可录）；宏存 `macros.json` + SHA-256 校验，不用 Notepad++ 的 `shortcuts.xml`。
5. **会话用 JSON，不用 XML。** 会话文件建议 `.taomni-session.json`（待确认），带 `version` 字段以便将来迁移。
6. **文件对比用 `@codemirror/merge` MergeView 作唯一 diff 内核，废弃自研逐行比对。** Git Diff 已在用 MergeView；任意两文件对比统一到同一内核，上限 5 MB。
7. **大文件 P0 不改 5 MB 可编辑 / 20 MB 硬上限。** 不承诺 Notepad++ 的 2 GB；抬到 50 MB 是 P1 spike S-N3，实测后定。
8. **代码类 14 项不做（可点击链接除外）。** 工作区代码能力原样保留，只是不下放到查看器、不为 Notepad++ 另做一套。
9. **Windows 专有行为一律改写为跨平台口径。** UAC → 三平台提权、回收站 → 三平台 Trash、cmd/PowerShell → 按平台终端、文件关联/多实例/命令行参数等不做。

## 后果

- 正面：89 项可在核心里分 P0/P1/P2 落地，不依赖 M0；两条栈行为一致；宏、会话、备份有明确的存储格式。
- 负面：双视图/克隆与文档地图是 P1 里风险最高的，需先通过 spike S-N2/S-N1；查看器书签（F2 系列）与工作区书签（F11 系列）暂时是两套，是否统一待评审（设计 §14.1(e)）。
- 待确认：移至回收站（唯一待定项）、会话文件扩展名、行操作无选区时的作用范围、文件对比内核废弃自研比对、面板停靠口径——见设计 §14.1(a)–(h)。
