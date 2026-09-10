# Code Workspace 后续缺口卡（ED-AUDIT 收官矩阵 §7 落子）

<a id="ed-follow-001"></a>
## ED-FOLLOW-001 类 rename 的 server 侧 file-move 单次 undo 不还路径

- ED-FOLLOW-001-A1：复现类 rename（含文件移动）后单次 undo：buffer 内容还原，但磁盘文件未移回原路径（与 ED-AUDIT-014 v2 恢复链对接）。
- ED-FOLLOW-001-A2：实现 file-move 逆操作或明确拒绝语义（fail-closed + 用户可见提示），unit 覆盖回归。
- ED-FOLLOW-001-A3：native 用例验证 buffer+路径双还原（sha 双向复算），Windows/macOS 保持 unrun 不得泛化。

<a id="ed-follow-002"></a>
## ED-FOLLOW-002 native 跑单泄漏 jdtls 子进程

- ED-FOLLOW-002-A1：定位 native runner/QA 包在用例结束后未回收 jdtls 子进程的泄漏点（跑前需手工清理的现状）。
- ED-FOLLOW-002-A2：实现用例级 teardown 回收（runner 或 fixture 层），连续跑单后无残留进程。
- ED-FOLLOW-002-A3：回归验证：连续 3 次 provider 相关 native 用例后进程表干净，不引入新的用例 flake。

<a id="ed-follow-003"></a>
## ED-FOLLOW-003 C6-04 用例断言补强

- ED-FOLLOW-003-A1：审计 TC-IDE-C6-04 现有用例：仅按键截图、无行为断言的步骤清单。
- ED-FOLLOW-003-A2：补可判定的行为断言（至少覆盖其名义验收路径），browser/native 按实际能力分级。
- ED-FOLLOW-003-A3：`audit --gate` 与 control-coverage 保持全绿，不新增 orphan/shallow 回归（或如有新增一并解释）。

<a id="ed-follow-004"></a>
## ED-FOLLOW-004 GB 级保留下 renderer 未定位增长来源

- ED-FOLLOW-004-A1：在 ED-AUDIT-005 封顶（undo ledger ≤50 条、>512 KiB）之后，复现并量化残余 renderer 内存增长（当前调查中：与保留大小正相关，非 undo ledger）。
- ED-FOLLOW-004-A2：定位增长来源（decorations/inlay/gutter/mapping 缓存等候选），给出测量数据而非推测。
- ED-FOLLOW-004-A3：按定位结果修复或封顶，11/11 性能组保持全绿；若证实为上游/架构约束则降级为 documented limitation。
