# Code Workspace IDEA 2026.2 对齐能力发布矩阵（ED-AUDIT-006）

Board: `claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md`（16/16 terminal，
15 done + 本卡）。本矩阵只汇总同分母可比样本，不从单卡 done 推导编辑器百分比对齐。

## 1. 源码与门禁身份

- HEAD（本矩阵基线）：`8cf2ff13` 起（含 005；006 提交后更新）。
- `pnpm build`：exit 0（仅预存 chunk 警告，无错误）。
- `qa_ui_auto audit --gate`：OK（orphans 0，covered 376/394；基线含本次目录扩张，见 §5）。
- `task_board.py validate`：OK，16 tasks。
- `status --gate --feature F25.5 --platform Linux`：已审阅（见 §4；tracker 侧多为 unverified，
  系本轮运行尚未纳入 tracker 评审，非证据缺失）。

## 2. 行为卡矩阵（Linux 当前平台；Windows/macOS 未验证）

| 卡 | 验收 | 生产实现 | 最终证据（种） | 结论/上限 |
|---|---|---|---|---|
| 001 | A1-A3 | 对比校验设施 `compare_idea.py` + schema | unit 24/24, document | done；设施卡 |
| 002 | A1-A3 | `workspaceVirtualSpace.ts` 等 overflow/undo | unit 92/92, typecheck, browser C8-01, native C8-02（含 wbpy）, waiver record | done `02ca53cb`；L2 |
| 003 | A1-A3 | find scope / replace model / ledger | unit 46/46, typecheck, browser D2-01, native D2-02/AUDIT-003（磁盘 sha 三方复算）, waiver record | done `c8082211`；L2 |
| 004 | A1-A3 | prepared-save freeze / writeback / receipt | unit 64/64+race 3/3, typecheck, browser C0-02, native C0-01（11 条 receipt 交叉验证）, waiver record | done `18e04ce4`；L2 |
| 005 | A1-A3 | 热路径不断言重写；undo 保留封顶（>512 KiB 保 50 条） | unit 64/64+owner 10/10, typecheck, performance 11/11 全绿（1 MiB p95≤21/150，5 MiB p95≤16/500，small p95≤11/50）, native C0-03 全绿 ×2（含 save/undo/sha）, waiver record | done `8cf2ff13`；L1（IDEA 无共同计时端点） |
| 007 | A1-A3 | `lspCompletion.ts` 单分发 accept/undo | unit 100/100, typecheck, browser C2-02, native C2-01+C2-03（真机 JDT LS，JDK 21 pin）, provider, waiver record | done `a1c6ae4e`；L2 |
| 008 | A1-A3 | canonical applyPlan / journal claim | unit 86/86+mounted 4/4, typecheck, browser, native AUDIT-008（真机双入口同 commit）, provider, waiver record | done `01970921`；L2 |
| 009 | A1-A3 | shared owner / tab policy / teardown | unit 88/88+mounted 2/2, typecheck, browser C4-01/C4-02, native AUDIT-009（重启恢复）, waiver record | done `e68920d2`；L2 |
| 010 | A1-A3 | planPaste（单光标 whole-block） | unit 97/97+ED-CLIP 3/3, typecheck, browser C3-01, native C3-02（denial 全绿）, waiver record | done `d68a1257`（+`98873dde` 修复）;L2 |
| 011 | A1-A3 | composing guards 全链 | unit 106/106, typecheck, native C3-02 IME（wbpy）, accessibility, waiver record | done `6dccde16`；L2 |
| 012 | A1-A3 | navigation history / reveal / pin-rerun | unit 51/51, typecheck, browser C6-01/C6-02, native C6-05（真机 reveal+back）, provider, waiver record | done `8bfc139a`；L2 |
| 013 | A1-A3 | restore 时间戳 + 24-tab fixture + C4-03 | unit 15/15, typecheck, browser C4-02, native 24/24（active p50 607ms p95 631ms；all p50 2886ms p95 2972ms）, performance aggregate, waiver record | done `68c1803f`；L2（无阻塞故零优化，spec-conditional） |
| 014 | A1-A3 | v2 journal 先行 + postcondition 阻断 + recovery 控制器 + 回声抑制 | unit 82/82+mounted 8/8, typecheck, browser C6-03, native AUDIT-014 全绿（真 rename+undo，seeded 恢复双 sha）, provider（JDT LS 1.61 真 rename；App.java 语法错拒 rename 系 server 侧）, waiver record | done `59f9857e`（接管 25h-stale 他人卡，有记录）;L2 |
| 015 | A1-A3 | execute 接线 + live discovery 唯一仲裁 + `source.sortMembers` | unit 29/29+mounted 3/3+contract, typecheck, browser C8-04, native AUDIT-015 全绿（preview/apply/undo/save/sha）, provider（1.61 #2169 sortMembers 真 edit）, waiver record | done `c86d6e5d`；L2（无需升级 provider，缺的是我方 kind） |
| 016 | A1-A3 | cleanup execute 接线（file/default 限定）+ live discovery | unit 37/37+mounted 3/3+Tab 134/134, typecheck, browser C8-04 双段, native AUDIT-016 fail-closed 全绿, provider 缺席双证（bundle 词表 + live 全量 listing 0 cleanup）, waiver record | done `090210a8`；L2 fail-closed（supported 分支止于 test-double，实质豁免有记录，可撤回） |

## 3. 平台格

- Linux（当前）：上表所有 native/provider 均为本机真机证据（打包 QA + 真实桌面/X11，
  JDT LS 1.61.0，JDK Zulu 21.0.4）。
- Windows：未验证（所有卡证据 unrun 保留）。
- macOS：未验证（同上；krb5 stage 等按 AGENTS 执行，未执行）。

## 4. 范围评审（status --gate F25.5/Linux，已审阅）

- 52 cases 列入；tracker 侧 20 native unverified、2 stale、28 browser unverified、
  1 stale、1 failed（C0-03 的某次 flake 运行）。
- 判定：unverified/stale 系本轮运行尚未纳入 tracker 评审流程，不代表证据缺失
  （各卡 record.json 均链到通过的 summary/receipt/sha）；failed 为 005 已归档的
  环境 flake（同卡另有两次全绿）。
- release-evidence：不宣称 release-ready，未跑 `--release-evidence`。

## 5. 基线 ratchet 记录（本次）

- `coverage-baseline.json`：376/394 required，52 shallow，0 orphans。
- 13 orphans → 0：补真实 controls（F25.5 tree-dir/view-tree/new-java-class×2/
  conflict-dialog×2；F25.1 debug-subtab），testid 均在生产侧核实存在。
- shallow 44 → 52：其中 7 为他卡 display-only 用例覆盖（本卡未动其行为），
  1 为新增 display 容器；有意接受，后续 delta 仍被门禁捕获。

## 6. 豁免登记

1. IDEA 真机对比豁免（2026-09-09，维护者）：全行为卡适用；record 一律
   `incomparable` + not-run 理由，不宣称 parity。
2. 016 实质豁免（2026-09-10，维护者 unit+browser 条）：supported 分支止于
   test-double；撤回即回 `implemented`。
3. 005 干预决议（2026-09-10 interview）：做 undo 封顶后关 done；残余 renderer
   增长另有来源（调查中，不阻塞）。
4. 014 接管（2026-09-09，维护者）：25h-stale 他人 `in_progress` 外科式转移，
   历史保留，无其他人改动被触碰。

## 7. 未吸收的相邻缺口（后续卡候选，非本板）

- 类 rename 的 server 侧 file-move 的 undo 逆操作缺失（buffer 还原但文件未移回）。
- native 运行泄漏 jdtls 子进程（跑前需手工清理）。
- renderer 在 GB 级保留下仍有未定位的增长来源（undo ledger 已封顶）。
- C6-04 用例几乎无断言（仅按键截图），证明力弱。
- `02ca53cb` 提交信息笔误（C3-01 应为 C8-01），证据 JSON 正确，按不改历史保留。
