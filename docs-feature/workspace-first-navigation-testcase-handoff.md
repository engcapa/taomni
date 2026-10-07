# Workspace-first 导航测试用例交接

> 状态：计划/未执行。本文不表示产品代码已实现、case 已注册或测试已通过。
> 关联设计：`workspace-first-navigation-design.md`。
> 目标分支：`feat/workspace-first-navigation-cc-astra-max`。

## 1. 验证边界

- Browser 证明 React renderer、stub IPC、导航、Surface routing、scope label、DOM 状态、快捷键和响应式布局；不能证明 Tauri SQLite、真实 PTY、SFTP transfer、Mail sync、detached OS window、system clipboard、IME 或 native window behavior。
- Native 只用于明确需要 Tauri/Rust/磁盘/进程/窗口/OS 输入的断言；Windows 是本轮当前端，macOS/Linux 保留后续状态。
- 所有 case 应使用独立 `reset_db` 或专用 fixture；Workspace membership fixture 不应把真实凭据写入 YAML/报告。
- 新增 UI controls 后，同步更新 `qa-ui-auto-tests/feature-list.md`、`ci/policy.yaml`、`ci/dependencies.yaml`，并在批量更新后执行一次 audit/catalog 检查。
- 现有用例不因入口重构删除；更新 selector/路径时保留其业务结果、失败/取消/恢复断言。

## 2. 数据模型 fixture 契约（拟新增）

当前 testcase schema 已有 `reset_db`, `ssh_required`, `sftp_required`, `mail_server`, `workspace_root`, `git_diff_repo` 等 fixture，但没有 Workspace fixture。实现 agent 必须先增加一个小型、无凭据的 `workspace_membership` fixture（或等价命名），并注册到 schema/fixture registry；不能在 case 中假设未注册 fixture。

Fixture 最小数据：

```json
{
  "workspaces": [
    {
      "id": "qa-workspace-main",
      "name": "QA Main",
      "roots": [{"id":"qa-root","name":"fixture","path":"<workspace_root>","kind":"folder"}],
      "memberships": [
        {"sessionId":"qa-local-shell","role":"primary","order":0},
        {"sessionId":"qa-shared-ssh","role":"attached","order":1}
      ]
    },
    {
      "id": "qa-workspace-remote",
      "name": "QA Remote",
      "roots": [],
      "memberships": [{"sessionId":"qa-shared-ssh","role":"primary","order":0}]
    }
  ],
  "sessions": [
    {"id":"qa-local-shell","kind":"LocalShell","displayName":"QA local"},
    {"id":"qa-shared-ssh","kind":"SSH","displayName":"QA shared SSH"},
    {"id":"qa-mail","kind":"Mail","displayName":"QA mailbox"}
  ]
}
```

实际 fixture 必须使用现有 `SessionConfig`/SQLite/SSH/mail fixture schema，以上只描述关系，不是可直接运行的 YAML 值。凭据只能来自已有环境变量 fixture。

## 3. Acceptance → test mapping

| AC | New V | Browser cases | Native cases | Retained cases that must be updated/verified |
|---|---|---|---|---|
| AC-01 default Work/no business tabs | V-WS-01 | TC-WS-001 | TC-WS-NATIVE-003 | TC-001, TC-MAIN-RAIL-01/02/04, TC-IDE-SHELLLAYOUT-01 |
| AC-02 workspace switch | V-WS-02 | TC-WS-001 | TC-WS-NATIVE-001 | TC-WELCOME-RS-01/02, TC-IDE-CW-LAYOUT-01 |
| AC-03 shared canonical Session | V-WS-03 | TC-WS-002/003 | TC-WS-NATIVE-001/004 | TC-013, TC-036, TC-053, TC-SESSION-TREE-01/02 |
| AC-04 Session kind filter/open | V-WS-04 | TC-WS-002 | TC-WS-NATIVE-003 | TC-037, TC-038, TC-004, TC-111/112/107, DB scaffolds |
| AC-05 Workspace surfaces/Git/Mail | V-WS-05 | TC-WS-001/005/006 | TC-WS-NATIVE-002 | TC-GIT-DIFF-01, TC-MAIL-UNIFIED-01, all Mail functional cases, IDE workspace/Git cases |
| AC-06 Global tools | V-WS-06 | TC-WS-004 | TC-WS-NATIVE-003 | TC-SHOT-001..036/N*, TC-MFA-001..012/101..108, TC-auto-F-Servers-1, TC-auto-F-Sockscap-1, TC-AI-003/004 |
| AC-07 scoped tools/pickers | V-WS-07 | TC-WS-004/005 | TC-WS-NATIVE-002 | TC-009/026/029/043/048, DB/SFTP/Mail/Tao cases |
| AC-08 SessionTree retention | V-WS-08 | TC-WS-002 | TC-WS-NATIVE-001 | TC-013, TC-036, TC-037, TC-053/054, TC-auto-F-Sidebar-1, TC-SESSION-TREE-01/02 |
| AC-09 collapse/restore | V-WS-09 | TC-WS-001/008 | TC-WS-NATIVE-003 | TC-MAIN-RAIL-01/02/04, TC-IDE-PARITY-024-01/02, TC-IDE-PARITY-027-01/02/03 |
| AC-10 Tao scope isolation | V-WS-10 | TC-WS-005 | TC-WS-NATIVE-002 | TC-AI-001/002, TC-NOTES-001..007, relevant ChatDrawer tests |
| AC-11 restart/stale refs | V-WS-11 | TC-WS-006 | TC-WS-NATIVE-001/004 | TC-WELCOME-RS-03/04/N-01/N-04, TC-IDE-C5-01, editor view-state restore |
| AC-12 global header/commands | V-WS-12 | TC-WS-007 | TC-WS-NATIVE-003 | TC-035, TC-103, TC-auto-F1-9, TC-MAIN-RAIL-02, native menu/window cases |
| AC-13 responsive layout | V-WS-13 | TC-WS-008 | TC-WS-NATIVE-003 | TC-MAIN-RAIL-02, TC-IDE-SHELLLAYOUT-01, TC-IDE-CW-LAYOUT-01 |
| AC-14 prototype integrity | V-WS-14 | TC-WS-PROTOTYPE-001 | N/A (prototype only) | None; prototype is separate from product cases |

## 4. New browser cases (draft specifications)

These are handoff specifications. P2 must author executable YAML with schema-supported verbs, exact testids and registered IDs after implementation controls exist. IDs are reserved/proposed, not currently registered.

### V-WS-01 / TC-WS-001 — Workspaces default and surface strip

- `covers`: new Workspace navigation feature ID (to be assigned in `feature-list.md`); retain F1.2/F1.3/F1.6 where controls overlap.
- `modes`: `[browser]`; `fixtures`: `[reset_db, workspace_membership]` after fixture is registered.
- Actions: open app; assert Work selected, Workspace navigator visible, no top-level `[data-testid="tab-bar"]` business Terminal/Git/Code Workspace controls; select `QA Main`; assert header `Workspace · QA Main`, Overview/Files/Preview/Tao/Changes/Mail surface controls; select Changes then Overview; assert active workspace remains and no duplicate Session rows.
- Boundary: empty state with zero workspaces must show create/select Workspace, not fabricate a Welcome Workspace.
- Assertions: active surface, scope badges, no horizontal overflow at default desktop viewport; screenshot for manual layout review.

### V-WS-02 / TC-WS-002 — Canonical Sessions and references

- `modes`: `[browser]`; `fixtures`: `[reset_db, workspace_membership]`.
- Actions: select Sessions rail; assert canonical section has one `qa-shared-ssh`; apply Remote/Terminal/Mail kind filters; search; expand membership references; open canonical Session; switch back Work; open reference and assert same Session ID/identity; Remove reference and assert canonical row remains.
- Retained actions: folder expand/collapse, multi-select, right-click menu, duplicate/edit/delete, search no-match.
- Failure: canonical delete with memberships opens reference-count confirmation and cancellation keeps row.

### V-WS-03 — TC-WS-003 shared Session across Workspaces

- `modes`: `[browser]`; `fixtures`: `[reset_db, workspace_membership]`.
- Actions: select QA Main and Remote Workspaces; open same SSH membership from each; assert session identity chip remains same and no second canonical Session row; remove one membership; assert other Workspace remains usable.
- Negative: attempt duplicate membership; assert no duplicate row and stable ordering.

### V-WS-04 — TC-WS-004 scope-labelled tools

- `modes`: `[browser]`; `fixtures`: `[reset_db, workspace_membership]`.
- Actions: Tools rail → global tools; open Screenshot/MFA/Network/LAN/servers; assert `global` scope and active Workspace membership unchanged. Open Git/Files/Preview as Workspace tools; open SFTP/Terminal/Mail as Session tools; with no context assert scope picker instead of implicit assignment.
- Retain each tool's existing functional case; this case only proves new routing/scope semantics.

### V-WS-05 — TC-WS-005 Surface lifecycle and keep-mounted projection

- `modes`: `[browser]` for renderer lifecycle plus `[native]` companion for real resources; `fixtures`: `[reset_db, workspace_membership, ssh_required, sftp_required]` where available.
- Browser: switch Terminal → Files → Changes → Tao → Mail; assert active Surface changes while runtime host remains represented, close Surface and assert canonical Session remains.
- Native companion: run PTY/SFTP/DB/Mail/VNC/RDP appropriate selected subset; switch Workspace/Surface; assert output/transfer/query/sync state survives and explicit Surface close does not disconnect another instance.

### V-WS-06 — TC-WS-006 restart/stale membership

- Browser: seed versioned fixture with one missing Session; reload; assert unavailable reference with Retry/Remove Reference, no auto-connect, retry remains unavailable until Session appears, then resolves.
- Native: isolated `NEWMOB_DATA_DIR`/QA app data; create membership, close/restart Tauri, assert durable Workspace/membership/navigation; corrupt/old revision path must show recovery error and preserve canonical Session.

### V-WS-07 — TC-WS-007 header/Command Center

- Browser: assert global Search/New/Theme/More labels; press actual Ctrl+K; search Workspace, Session, Global Tool and Surface; select result and assert route; New opens Workspace creation by default and offers Session creation; narrow width moves overflow without duplicate top-level business tabs.
- Retain TC-035/TC-103 command routing and native menu cases; update only expected destination.

### V-WS-08 — TC-WS-008 responsive layout

- Browser viewports 1440×900, 980×800, 400×700.
- Assert Rail remains available; navigator can collapse/restore; main canvas width remains positive; right pane can close/overflow; no `document.documentElement.scrollWidth > clientWidth`; surface strip scrolls within its own container; focus returns to invoking control.

### V-WS-09 — TC-WS-PROTOTYPE-001

- Browser-only against `/docs-feature/ui-layout-refactor-prototype.html`; no product fixture.
- Assert UTF-8 visible text, no `console.error`, no favicon 404, no `.top-tab`/business top tabs, Work/Sessions/Tools views, workspace/session/reference content, every visible button either changes view/state or shows honest toast, Hide keeps canvas width, Theme/Command Center/Surface actions work.
- Current status after prototype commit: unrun; previous manual browser checks are not a passing case receipt.

## 5. New native cases (draft specifications)

### V-WS-NATIVE-001 — Persistence/restart

- `modes: [native]`, `native_platforms: [Windows, macOS, Linux]` (follow-up execution per platform), `fixtures: [reset_db, workspace_root, workspace_membership]` after registration.
- Use isolated QA app data; create/rename Workspace, add shared Session memberships, close/relaunch; inspect visible UI and durable database effect; assert revision/migration and stale references.
- Browser does not replace this because the assertion is Tauri SQLite/IPC persistence and restart.

### V-WS-NATIVE-002 — Resource lifecycle

- `modes: [native]`, selected platform fixtures by resource; run sequentially to avoid PTY/DB/Mail interference.
- Assert Surface switch/close/detach/reattach for local/SSH terminal, SFTP transfer, DB query, Mail sync, VNC/RDP where platform fixture exists; assert no duplicate Mail sync worker and no credential duplication.
- Keep existing dedicated resource cases as gates; this case only adds cross-scope lifecycle assertions.

### V-WS-NATIVE-003 — Current-platform rail/header/IPC smoke

- Windows first; native platforms retained for later. Assert Tauri WebView2 UI, global/native menu routing, shortcut/window control boundary, Rail/navigator collapse and Workspace surface switching, no blank canvas after hidden host reveal.
- `native_build.py --check` before one stable QA build; no build per case.

### V-WS-NATIVE-004 — Detached membership/reattach

- Use existing detached handoff/claim flows for terminal/SFTP/RDP/VNC/database; extend payload with `surfaceId`, `workspaceId`, `sessionRef`; close detached window and assert reattach targets original Surface scope without duplicate canonical Session/membership.
- Browser only verifies BroadcastChannel stub; native proves OS window close/reattach.

## 6. Retained case update matrix

P2 must inspect actual YAML and update paths/assertions in a single batch, then re-run selected cases. The following case groups are not all reimplemented as new Workspace cases; they remain their own business coverage:

- Canonical Session/SessionTree: `TC-013`, `TC-036`, `TC-037`, `TC-053`, `TC-054`, `TC-SESSION-TREE-01`, `TC-SESSION-TREE-02`, `TC-auto-F-Sidebar-1`.
- Welcome/recent/restore: `TC-038`, `TC-041`, `TC-055`, `TC-062`, `TC-auto-F1-6-welcome-cards`, `TC-auto-F1-6-welcome-recent-sessions`, `TC-WELCOME-RS-01..04`, `TC-WELCOME-RS-N-01/-03/-04`.
- Existing tab/surface compatibility: `TC-042`, `TC-061`, `TC-108`, `TC-auto-F1-5-tab-details-overlay`, `TC-auto-F1-5-tab-drag-reorder`, `TC-auto-F1-5-tab-launch-menu`, `TC-auto-F1-5-tab-rename`, `TC-110-terminal-split-smoke`, `TC-102-multiexec-bar`, `TC-auto-F-Detach-1-terminal-detach`.
- Header/rail/commands: `TC-001`, `TC-035`, `TC-103`, `TC-auto-F1-9-ribbon`, `TC-MAIN-RAIL-01..04`, `TC-IDE-SHELLLAYOUT-01/02`, `TC-IDE-PARITY-024-01/02/03`, `TC-IDE-PARITY-027-01/02/03`.
- Code/Git/Files/Workspace: `TC-GIT-DIFF-01`, `TC-IDE-PARITY-010-01..04`, `TC-IDE-PARITY-018-01/02`, `TC-IDE-CW-LAYOUT-01`, `TC-IDE-CW-UI-01`, plus all `TC-IDE-*` cases whose entry path currently depends on Code Workspace/ToolWindowRail. Their editor/build/LSP assertions remain unchanged.
- SFTP/remote/resource: `TC-009`, `TC-011`, `TC-026`, `TC-029`, `TC-043`, `TC-048`, `TC-145`, `TC-004`, `TC-107`, `TC-111`, `TC-112`, and related SSH/RDP/VNC/DB lifecycle cases.
- Tao/AI/Notes: `TC-AI-001..004`, `TC-NOTES-001..007`, `TC-auto-F-AI-2-*`; only navigation/scope selectors change, tool/message/provider assertions remain.
- Mail: `TC-MAIL-UNIFIED-01` and all `TC-MAIL-*` functional cases; Mail account/session and Unified Mail entry expectations change, sync/compose/search/folder/attachment/provider assertions remain.
- Global screenshot/MFA/tools: all `TC-SHOT-*`, `TC-SHOT-N*`, `TC-MFA-*`, `TC-auto-F-Servers-1`, `TC-auto-F-Sockscap-1`, backup/vault cases; only global Tools entry/routing changes.

For each selected retained case, record old selector → new selector, preserved assertion, intended new behavior, mode, and report identity in the design/PR matrix. If a case is unaffected after `diff_impact`, explicitly record it as retained/no selector change rather than duplicating it.

## 7. Catalog registration and handoff checklist

- Add a new feature block for Workspace-first navigation in `qa-ui-auto-tests/feature-list.md` with controls for main rail, workspace navigator, Sessions canonical/reference rows, kind filters, scope badges, Surface strip, unavailable reference actions, Workspace header, and global tool rows. Do not reuse the editor `ToolWindowRail` feature ID for the new Main Rail.
- Add the new exact IDs to `qa-ui-auto-tests/ci/policy.yaml`; add ordering edges in `qa-ui-auto-tests/ci/dependencies.yaml` only where a case requires fixture/setup or a retained case must precede it. The current dependencies file is sparse; do not invent broad dependencies.
- Register any new fixture (e.g. `workspace_membership`) in the fixture implementation, registry, and `testcase.schema.json`; do not place unregistered fixture names in YAML.
- Generate/validate `references/testid-catalog.md` only after controls are actually implemented. Planning IDs and selectors remain marked proposed.
- New YAML must use only schema-supported verbs; `verification.review` stays `pending` until P2 reviews semantics; every unexecuted case is `unrun`.
- Run after implementation, not during this design-only handoff: `python -m qa_ui_auto audit --gate`, exact `ci plan`, focused browser IDs with `--require-pass`, one stable native build, then sequential native IDs. Browser results never certify native.
