# REF-PARITY-002-WIN-20260916：保存、冲突退出与恢复

来源 [ED-PARITY-002 设计](../save-race-baseline-plan.md#ed-parity-002) / REQ-11 / CW-EDIT-003。本参考包包含真实 IDEA 操作，不包含 Taomni 产品运行。原件 hash 与文件字节记录见 [identity](../evidence/ed-parity-002-p1-identity.json)。

## 身份、环境和复用边界

2026-09-16 22:02–22:06:43 Asia/Shanghai，用户明确允许本轮独占 5 分钟；22:06:43 前已停止输入、关闭本轮 edit.txt 标签，回到原 `fixture – example.txt`。该时段结束，未来输入不能自动续用。操作工具：Python/pyautogui + Win32 前台窗口/PID 校验；没有锁屏或解锁操作，没有启动 Taomni/runner。

目标为正在运行的 `D:/Software/idea-2026.2.2.win/bin/idea64.exe`，PID 31516。`product-info.json` 当轮只读确认 version 2026.2.2、productCode IU、build 262.10315.125，即 IntelliJ IDEA Ultimate / IU-262.10315.125；授权状态没有单独采样，所用纯文本动作均可执行。复用原 fixture 工程窗口，本轮文件在独立报告目录，通过 IDEA launcher 打开文件；未改原 example.txt 或用户配置。

- Windows，屏幕 1920×1080；窗口外框 (119,70)–(1821,929)，截图 1702×859 原始像素；结束时 Win32 client rect 1686×851，GetDpiForWindow=96。DPI awareness 的返回值不等同有效 IDEA UI scale。
- 已观察：深色 New UI、英文标签，LF / UTF-8 / 4 spaces，IDEA 普通文本无 SDK/provider 要求。
- 已实测绑定：Ctrl+S 保存、Ctrl+Alt+Y 同步后出现外部冲突、Esc 退出、Enter 接受冲突弹窗当前默认 Load File System Changes、Ctrl+Z undo、Ctrl+F4 关闭当前文件。完整 keymap 名称尚未核实，不能从 Windows 推断整份 keymap。
- 字体设置文件仅作环境线索：`editor-font.xml` DefaultFont 配置 Microsoft YaHei UI / 18.0，未在 UI 中确认有效 editor scheme；UI 字体、有效 zoom/lineHeight、主题精确名称未核实。**不作为像素对齐参数**，不从文件推造真实观察。旧 Windows tree 参照也缺有效 scale，Linux profile 不能移植到这次 Windows。
- 本包不改布局；A2 可记录同 fixture 行为和状态角色，对精确尺寸/字体/像素结论保留未验证。后续真正改版或测量时再补相关 Settings 页面，不能直接认定差异接受。

<a id="fixture"></a>

## F1-SAVE-002 可重建输入

派生自 [F1/F5](fixture-catalog.md#f1)，每次复制到新隔离目录。`edit.txt`：UTF-8 无 BOM、LF，初始 caret 1:1 / selection 空，内容为下面三个文本行加最终 LF：

```text
alpha Alpha ALPHA
tree tree
line three
```

| 名称 | 字节定义 | 长度 | SHA-256 |
|---|---|---:|---|
| B0 | 上述正文，含尾 LF | 39 | `2b7edc22ece15ead9636ecf67c54fa5e48bb7c4325409a7651fda976073ae88d` |
| B1 | B0 后追加 ASCII S，无尾 LF | 40 | `77e11801e1006d4d36d0abb43cf57a9964954445acea8c6d017689796fa38172` |
| B2 | B1 后追加 ASCII X | 41 | `75699982db826f8191ba939313abc59ee80b767b1e2a51776a17f81585317900` |
| E1 | `EXTERNAL\n` | 9 | `c0cd94660e03e9ce34eccf2ebff469c2ee8b1d331e557ddfe9f473781f6c3ea9` |
| E2 | `EXTERNAL2\n` | 10 | `b3a7075e2a505acfe6bdd269373017ea279cbb953423cac0b3807f748ab63183` |
| E3 | `EXTERNAL3\n` | 10 | `2e3a9327efd33db88ae1f1d119dd6b0dcc3909bb87b41e9867029936338e9bff` |
| E3S | E3 后追加 S | 11 | `5f84e2263d0cd1ceb0907844d737106a0f3efa3db04c299b9814409eeeceb7cb` |

本机文件根：`qa-ui-auto-report/idea-reference/ed-parity-002/20260916/fixture/`。此目录最终内容为 E3S，不可当初始 seed 使用；按上表重建。P2 的 BOM/CRLF 变体由 B0 的 LF 转 CRLF，再编码为 UTF-8 前缀 EF BB BF；精确 expected bytes 在执行前独立生成/hash，不能从产品 receipt 反推预期。

<a id="observed"></a>

## 实际动作与原件

原件目录：[20260916](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/)。JSON 记录当时 host bytes/sha256、时间和前台标题；截图为原始窗口图，`08-sync.png` 是冲突窗口独立裁切，配套 `09-conflict-full.png` 保存完整窗口。所有产物在忽略目录；跨机器需复制本包 30 件 manifest 工件并逐 hash 验证，或补采；文档链接存在不等于原件已取得。

| 实际步骤 | 观察结果 | 原图（同名 JSON 若存在见 manifest） |
|---|---|---|
| R0 打开本轮 edit.txt | B0，editor caret 1:1，原窗口其他 tab 保留 | [02](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/02-open.png) |
| R1 Ctrl+End，输入 S，Ctrl+S | editor B1，caret 4:2；回读磁盘 B1。Save 没有可见阻塞对话框或焦点跳转 | [03](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/03-dirty-S.png) / [04](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/04-saved-S.png) |
| R2 输入 X，再 Ctrl+Z | 输入后 B2；undo 实际移除 S 和 X，回 B0，caret 4:1；磁盘仍 B1。这是已观察分组，不能写成“一次 undo 只去 X” | [05](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/05-dirty-X.png) / [06](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/06-undo-X.png) |
| R3 host 写 E1，等待 1.5 秒 | editor 仍 B0，无可见弹窗；不能据此断言 watcher 永不提示 | [07](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/07-external.png) |
| R4 Ctrl+Alt+Y | File Cache Conflict：memory/disk 均变化；Load File System Changes 默认蓝色焦点，其余为 Keep Memory Changes、Show Difference；磁盘仍 E1 | [08](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/08-sync.png) / [09](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/09-conflict-full.png) |
| R5 Esc | 弹窗消失，editor B0、caret 4:1、磁盘 E1；后续可继续输入。未验证“Esc 后直接 Save”的 IDEA 覆盖策略 | [10](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/10-esc.png) |
| 诊断 D1 再按 Ctrl+Alt+Y | 未出现预期重复弹窗，guard 在尝试后续输入前停止；不视为第二次通过，也没有污染输入。保留诊断 | [11](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/11-guard-stop.png) |
| R6 editor 输入 L，host 写 E2，再 Ctrl+Alt+Y / Esc | 第二次真实冲突；Esc 后 editor B0+L、caret 4:2，磁盘仍 E2，取消保留双方内容 | [12](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/12-conflict-second.png) / [13](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/13-esc-second.png) |
| R7 host 写 E3，再同步、Enter | 显式 Load File System Changes 后 editor E3、caret 2:1，磁盘 E3；这是用户接受加载，不是取消效果 | [14](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/14-load-disk.png) |
| R8 Ctrl+End 输入 S、Save；caret 左/右；输入 X、undo | 第二次保存磁盘 E3S；单字符 X 分成独立组，undo 后 editor E3S/caret 2:2，磁盘仍 E3S；无额外写盘断言仅限记录时点 bytes 不变 | [15](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/15-save-second.png) / [16](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/16-X-second.png) / [17](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/17-undo-second.png) |
| R9 Ctrl+F4 | 仅关闭本轮 edit.txt，回到原 example.txt；已停止桌面输入 | [18](../../../qa-ui-auto-report/idea-reference/ed-parity-002/20260916/18-return.png) |

视觉事实：深色 editor 保持布局；冲突弹窗位于中间、正文为路径/冲突解释，下方横排三个动作，默认按钮蓝底及焦点描边；Esc 回到 editor 原位置。长路径在此次 1702px 窗口下能展示；未采窄窗/overflow。没有从像素推断 dirty 数据、屏幕阅读器播报或保存中磁盘状态。

## 尚未观测及精确补采条件

- IDEA 内部 W0/W1/W2 的 writer/ack 时点、unknown IPC effect、写入失败/只读和跨 view 迟到：**未观测**；本轮普通 UI Save 不足以证明。Taomni 的 effect/recovery 合同另按设计 V2/V3 验证，不伪造 IDEA 同名状态。
- 当前 GUI 无可靠 in-flight 钩子，不能用快速连续按键声称 IDEA 竞争通过。要比较底层竞争，须另建可控存储或调试采样，并独立记录实际 write 时点；不能把 Taomni QA fault 模拟冒充 IDEA 实测。
- 精确像素对照缺有效主题名、UI/code 字体方案、zoom/lineHeight。若后续 UI 改版依赖这些参数：在新的可用桌面时段核对 Settings → Appearance、Editor → Font、Keymap，以及当前 zoom；保持本 fixture，再采相同窗口和弹窗。阻断的是 A2 的精确视觉 matched 结论，不是本卡已定义的数据保留目标。
- 需要扩展冲突“Esc 后直接保存”策略时：B0→B1 dirty→host E1→同步→Esc→Save，独立记录双方字节和焦点；当前 R5 之后没有执行这个步骤，不从设置/源码推断。
- IDEA 未采 Taomni 的 BOM/CRLF/unknown/error UI；相关保存保留契约继续 required，P2 不得靠本参考包替代 native 证据。本卡 A2 要如实列出这些边界；CW-EDIT-003 功能/视觉/交互整体仍待验证。

未请求或运行 IDEA 源码构建；配置读取只说明环境线索。本参考已足以定义当前补证包的可见正常/取消/恢复断言，不是完整 IDEA parity 证书。
