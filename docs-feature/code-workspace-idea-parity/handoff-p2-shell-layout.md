# P2 开发并自验 — WP-SHELL-LAYOUT-01（当前前置未齐，暂不可执行开发）

此提示词可复制，但当前卡不在可领取队列。先继续 P1 补齐下文 BL-SL-01剩余定值并更新同一设计/任务板，之后用户明确启动 P2 才执行产品工作。不把复制此文视为本次 P1 已自动授权开发。没有自动启动其他 agent。

```text
你负责 Taomni Code Workspace REQ-03 首包 WP-SHELL-LAYOUT-01 的开发并自验。
工程：/data-raw-ssd/code-src/person/taomni，Windows/macOS/Linux三端兼容，当前交接平台Linux。
本提示词拟在P1前置解锁后由用户启动；若板仍deferred，则只报告前置未齐、继续已授权规划工作，不领取生产卡。

目标：通过必要布局/交互重构，使 CW-SHELL-001 的 F0 打开工作区与文件 → Project/editor/Problems-Run工具窗切换 → 折叠/重开/resize → 键盘返回editor → 恢复工具窗布局，与 IntelliJ IDEA 高度一致。当前布局不是保留约束；保留正确能力、数据、兼容和已确认行为。

【准确输入】
- 任务板：claudedocs/code-workspace-idea-parity-backlog-shell-layout.md
- 唯一ID：ED-SHELLLAYOUT-001（P1收尾deferred、无owner；领取前重新读取真实metadata）
- 设计：docs-feature/code-workspace-idea-parity/shell-layout-design.md#ed-shelllayout-001
- 图稿v2：docs-feature/code-workspace-idea-parity/shell-layout-wireframe.drawio / shell-layout-wireframe.png
- 参照：docs-feature/code-workspace-idea-parity/references/shell-layout-2026.2.2-linux.md
  REF-SHELL-LAYOUT-LINUX-20260914；以及其中引用的Tree已观测动作。
- 原件：qa-ui-auto-report/idea-reference/shell-layout/20260914-linux/
  hash清单：docs-feature/code-workspace-idea-parity/evidence/shell-layout-artifacts-20260914.json
  身份：docs-feature/code-workspace-idea-parity/evidence/shell-layout-plan-20260914.json
- 目标：IntelliJ IDEA Ultimate2026.2.2 / IU-262.10315.125。
  已知安装/data-raw-hdd/dev/idea-IU-253.30387.90/，product-info与当前进程必须复核。
  r2当前GUI已核Islands Dark、UI110%/Dialog16、Classic Light、XWin/英文；saved editor font为Source Code Pro16。
  历史lineHeight1.2未从当前Font页确认；Xft96、Cinnamon自动scale/text1.0已读，有效scale与density仍缺。不能把1400×1000直接当Taomni内区。
- F0：fixture-catalog.md与 .agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/project_tree.py::SEED_FILES。
  P1副本qa-ui-auto-report/idea-reference/shell-layout/20260914-linux/f0-shell-layout/，4种子最终hash与初始一致。
  example71字节SHA256 bbbab91a4e4ea594b1e2207721999dc375ac98c30c5960cfbbf1329a441aa01a。
- P1基线：docs/code-workspace-idea-audit-20260913 / 0694a03f839827402a628f6c7b2ccbb0c997dd0e，接手干净；P1有未提交文档/图稿diff，保留。
- 总需求/矩阵/source：同目录index.md、overall-audit-plan-20260913.md、capability-matrix.md、source-audit.md。
- Tree原卡：claudedocs/code-workspace-idea-parity-backlog-tree-open-focus.md / ED-TREEOPEN-001 done；
  docs-issue/code-workspace-tree-open-focus-design.md、最新metadata及后续修订优先于历史P1文字。
  Linux native只其子动作、visual incomparable，tab/leaf/workspace race和physical IME仍unrun。
- Find原卡：claudedocs/code-workspace-idea-parity-backlog-find-focus.md / ED-FINDFOCUS-001 implemented；
  docs-issue/code-workspace-find-focus-design.md。保护已有Find，不接管provider等旧gap、不改旧卡状态。

【当前真实前置，必须先解锁】
BL-SL-01：第二轮已补Project hide/reopen、展开bottom拖动并记忆高度、Problems Esc直接editor输入/undo、Run空态、真正Restore Current Layout、干净800×700和File菜单Esc、当前theme/UI font/zoom/keymap。剩余仅参考§6：current Font页/lineHeight/compact density/effective scale、Project和bottom真实min/max clamp及窄窗overflow展开；菜单/restore后直接输入undo的细节仍待观察。r2-23实际停留Keymap，不算Font采样。不能据800宽截图认定editorMin227，更不能用旧24%/192px定目标。
BL-SL-02已解除：用户明确“采用图稿v2的默认结构”，新workspace Project开/bottom关、旧snapshot按旧配置恢复，图稿尺寸颜色未获实测背书。无需再次问默认结构。
桌面第二轮21:22已归还；优先独立桌面，必须用当前桌面则约新集中时段，不能继承旧授权。
解锁BL-SL-01后同一ID由authoring修订ready并validate/list，保留失败记录；当前没有可直接领取ID，不另造卡掩盖前置。

【权限与执行】
由用户启动本P2后，允许本包产品、定向tests/case、必要QA构建/验证和自己领取卡的状态；不提交、推送、发布，不委派，不启动P3。
先读AGENTS.md、parity/task技能及task-lifecycle/evidence-policy、qa-ui-auto的regression-protection与efficient-verification；真实采样读idea-reference；native前读native-testing，新增YAML前读authoring/verb-catalog。

第一步：git branch/HEAD/status/diff；核上述metadata/spec/raw hash/caller变化。只有ready且depends_on全done才通过task_board.py --doc准确板 claim，owner按执行时真实身份生成；禁止手填或借旧卡owner。

【生产链、职责和决定】
MainLayout常驻所有workspace wrapper，仅display/visible切换 → CodeWorkspaceTab → useWorkspaceActionsController/WorkspaceActionHost → panels/store。
workspaceActionHost是唯一执行owner；Tab window listener只在visible时活动；surface/modal/terminal/CM completion和IME有优先级，不能加竞争全局listener。
修改优先 src/components/editor/CodeWorkspaceTab.tsx、src/components/editor/workspace/panels/BottomDock.tsx、src/stores/codeWorkspaceStore.ts、workspace/workspaceLayoutPersistence.ts。
可提取拟新增workspace/workspaceShellLayout.ts/WorkspaceShellChrome.tsx；必要FileTreePane、toolWindowRegistry、TabSwitcher和局部appearance roles由本卡负责。
MainLayout、ActionHost/controller、EditorGroup/CodeMirrorHost及document owner默认只读，扩改须记录实际caller理由与消费者验证。无预定Rust/IPC/backend改造。

- 保留layoutTreeV2/openFiles/document事务owner，不新建第二套layout store；chrome独立于editor leaf树。
- BottomDock当前13个panel全部mounted，保留数据生命周期；用registry同步rail、Switcher/Search状态和MRU。
- geometry逻辑px记录preferred、render时clamp，缩窄临时值不覆盖preferred；准确min/default/token必须引用解锁后的实测，不能用旧24%/192px反推目标。
- 新可选ShellChromeState并入旧v2的兼容读写，旧global bottom height仅一次fallback，不删除旧键/批量改其他workspace；缺字段legacy默认与新workspace默认分离。
- 恢复默认工具窗布局只改chrome：采用已确认S0（Project开/bottom关/right关），不Unsplit、不关file、不重开Host，不清运行数据；session Restore保持原路径。IDEA r2-18是当前命名布局（Project/bottom均关），不要冒充新workspace默认。
- r2-08 Problems高449px，r2-14 Run高323px，按工具记忆preferred高度；可选bottomHeightByTool并入shell字段，旧bottomHeightPx仅fallback，临时clamp不回写。
- 新activateToolWindow/returnToEditor/restoreToolWindowLayout通过现有Host注册，旧toggleProjectTree/showRunTasks等ID委派；所有入口用同snapshot/owner。
- focus intent冻结workspace/lifetime/leaf/file/mount/epoch/request；A→B→A、tab/leaf变化、点击/Find/menu、dispose使旧请求永久取消。不能只比当前又是A，不全局focus第一editor，不用reveal篡改选区。
- drag在pointercancel/visibility/dispose释放capture和listeners；迟到resize不能写B或回A后补写；layout/focus取消与file load commit分开。
- failed/cancelled/stale/conflict/unknown effect沿用原typed通道，不能写成成功；隐藏工具不调用Stop/Clear/kill/reload。

【保留行为 / 验收】
A1..A7及R1..R7全纳入，不削弱：
文件/目录单击仅选，文件双击/Enter正式打开，目录双击/Enter有效展开，箭头独立；正确ready leaf直接可输入，菜单Esc恢复、outside不抢；其他preview策略/全局默认不变。
Ctrl/Cmd+Enter分屏；同文件多view独立caret/selection/scroll、共享编辑/undo；非最后view关闭不释放文档；dirty Cancel零变化。
Find自动获焦、两匹配导航、Esc保留当前match selection、modifier-hover/清理；布局来回不复活旧Find/clipboard焦点请求。
先dirty再resize/hide/reset不隐式save；显式save/undo/恢复的buffer+disk hash正确，snapshot identity不补签旧定位。
Problems/Run有数据状态hide/switch/reopen不丢；late result只入原workspace，不能只用F0空态证明此项。
所有13个底部工具、Git/保存/设置/root/loose file/tree filter/refresh和全应用其他入口可达；不扩Git/Run后端测试。

【最小充分验证集合，按设计V选择】
1. V-SL-01复核真实owner/caller及最新修订，不以source存在判通过。
2. V-SL-02改前保留基线：CodeWorkspaceTab.test.tsx选ED-TREEOPEN-001、ED-AUDIT-009、project collapse、layout snapshot restore、ED-REPAIR-009；BottomDock.test.tsx、codeWorkspaceStore.test.ts、workspaceLayoutPersistence.test.ts、useWorkspaceActionsController.test.tsx、toolWindowRegistry.test.ts。
   新shell状态机定向测试：min/clamp/preferred、legacy/corrupt、取消drag、mount count；真实挂载测试Tree pending的tab/leaf/workspace往返、Find/共享undo/dirty cancel。实际缺陷才用red→green，新布局不要虚构基线失败。
3. V-SL-03新增TC-IDE-SHELLLAYOUT-01.testcase.yaml（拟id同名，当前未实施），F25.1/25.3/25.5按实际covers与controls维护。browser config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml；同F0连续流程和console/focus/selection/geometry，不mock掉owner接线。既有TC-IDE-C4-02和TC-IDE-FINDFOCUS-01按保留断言复用。
4. V-SL-04稳定source/tests后检查QA binary复用，必要一次build；Linux WebKitGTK/com.taomni.app.qa隔离data+fixture，集中主链、真实键/磁盘、两workspace、Run本地只输出marker任务的保留检查。不启动用户业务项目/未知任务。
   TC-IDE-TREEOPEN-01-project-tree-open-focus-native可复用树子动作，不能代替切换竞态。TC-IDE-C4-03是24tab restore/performance，默认不跑；只有改变restore queue/热路径才恢复预算验证。
5. V-SL-05同IDEA build/profile/DPI/client/fixture/state比较，测raw/CSS geometry并写容差理由，分别功能/UI/交互；compare_idea.py结构通过不等于matched，A1要求真实delta审阅和--require-match。
6. V-SL-06同轮检查键盘/visible focus/name-role-state/200%zoom/overflow，screen reader和physical IME分别记录；触及Host/composition时加当前端真实IME confirm/cancel，synthetic不证明物理IME。
7. V-SL-07最终union scoped typecheck一次；新增case/controls后一次qa audit gate。repo-wide build gate参考旧板ED-GATE-003，不重开或借历史通过。

Windows/WebView2、macOS/WKWebView均代码兼容且有同主链计划；当前Linux完成可交付本轮，另外两端明确unverified。browser不证明native；同一次native可覆盖多个AC/证据种类，不重建每张截图，不机械全量REQ-11/Find provider/Git/Run/语言服务/performance。

完成目标和保留行为后按准确板update/validate；自己的结果标自检，不能替代独立验收。本包引入相邻退化由本包修复，不能仅写implemented。报告实际source/diff、平台/mode/build次数、selected/pass/fail/skip和原件身份；更新同一总矩阵受影响场景派生摘要，不把卡done扩成REQ-03全部或三端matched。禁止自动启动下一角色。
```
