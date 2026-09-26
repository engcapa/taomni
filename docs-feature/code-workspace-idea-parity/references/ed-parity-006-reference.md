# ED-PARITY-006 IDEA 参照与 fixture

Reference ID：`REF-PARITY-006-WIN-20260926`；状态 **partially-observed**。目标由用户 2026-09-26 确定为 IntelliJ IDEA Ultimate **2026.2.3 / IU-262.10968.63**（只对本卡生效，不回写 P0 原 2026.2.2 目标或其他卡）。本文件是 P1 参照与补采 runbook，不是双侧 comparison record，不证明 Taomni 已对齐。

关联：[唯一板](../backlog.md) / [设计与测试用例](../project-replace-exclude-plan.md#test-cases) / [fixture catalog F1/F5](fixture-catalog.md#f1)。

<a id="environment"></a>

## 1. 环境与时段

| 项 | 实际值 / 来源 |
|---|---|
| 安装与进程 | 只读 `C:/Software/ideaIU-2026.2.3.win/product-info.json`：IU / 2026.2.3 / 262.10968.63；idea64 PID 24408（用户 `demo-sms` 工程最小化，未操作） |
| 平台 | Windows 11，屏幕 1920×1080，采集进程 per-monitor DPI aware；深色 New UI；Windows 默认 keymap（本轮实际按下 Ctrl+Shift+F、Ctrl+Shift+R、Delete、Ctrl+Z、Esc、Enter、Ctrl+S） |
| 字体 / 缩放 | 本轮**未重读**。ED-PARITY-005 同安装 2026-09-25 实读 Source Code Pro 16 / line height 1.2、UI Zoom 100%、Microsoft YaHei UI 14；只作核对入口，不签像素匹配 |
| 时段 | 用户授权 15 分钟。20:52:30 首次时段在任何输入前因桌面锁定（LogonUI、截屏失败）作废；用户恢复后重计 **2026-09-26 20:57:21–21:12:21 +08:00**，实际 21:09:23 结束并归还桌面 |
| 工具 | `cap.py`：PIL 全屏截图 + Win32 输入；每批输入前校验前台为 IDEA 进程且标题不含 `demo-sms`；复用 ED-PARITY-005 的 `idecap.py` 键表 |
| 清理 | 仅向本轮 `parity006-replace` 窗口 HWND 发送 WM_CLOSE，确认窗口消失；fixture 最终字节已由 Undo+Save 恢复为初值；未改 IDE 设置、未关闭用户工程 |

原件根：`qa-ui-auto-report/idea-reference/ed-parity-006/run-20260926-205230/`（不入库）。`manifest.json` 含 40 个原件 SHA-256、身份与局限；`steps.jsonl` 为每步 UTC、输入、前台 HWND/title/rect；`*.hashes.txt` 是每个关键点独立读取的磁盘字节。跨机器需取原包，摘要不能替代截图。

<a id="fixture"></a>

## 2. F1-REPL-006 fixture（双侧同字节）

F1 的本卡缩小变体。全部 UTF-8 无 BOM、LF；生成器 `make_fixture.py`（原件根内）。P2 的 browser/native fixture 必须写同样字节并独立计算 hash。

| 相对路径 | 内容 | SHA-256 |
|---|---|---|
| `src/a.txt` | `alpha token one\nbeta token two\n` | `873a6cda893e92a63dd175780098d330d1097c8094bc47270519f0ffba2ffdf0` |
| `src/b.txt` | `gamma token three\n` | `f3d30aaf5d933f1843b9601dbd472c4980396c2e07896dd76ee86cf250b7bf6b` |
| `src/c.md` | `token in markdown\n` | `579e85d4aa9eeb523c0ce75281c16d5aa92e63db351ee392134b2a9a27ba3fd8` |
| `other/d.txt` | `token outside scope\n` | `f7c026fadd1f6bdca980a0b35ad5a861b41aaa8a313656efed401a7adf8883b6` |

查询 `token`（大小写不敏感、非 whole word、非 regex），替换 `coin`。结果集合：

- Directory=`src`、无 mask：4 matches / 3 files（`c.md:1`、`a.txt:1`、`a.txt:2`、`b.txt:1`），`other/d.txt` 被目录范围排除。
- Directory=`src` + File mask `*.txt`：**3 matches / 2 files**（`a.txt:1`、`a.txt:2`、`b.txt:1`），`c.md` 被 mask 排除。
- 排除 `a.txt:2` 后提交集合 2 occurrences / 2 files。提交后期望字节：

| 路径 | 内容 | SHA-256 |
|---|---|---|
| `src/a.txt` | `alpha coin one\nbeta token two\n` | `9f74ac3fdce327b28f07af9b9353c6ba719e48794de155cd893df4545e1b6e76` |
| `src/b.txt` | `gamma coin three\n` | `570f58d60eb06a6ada1d3057635302bdbf99ebe13ff7ab75c8b92d1701f58a62` |
| `src/c.md`、`other/d.txt` | 不变 | 同初值 |

外部修改变体 `src/b.txt` → `gamma token changed\n`（P2 用 `host_write_file` 在预览打开后写入；hash 由 P2 实算）。本轮 IDEA **未采**此变体。

<a id="observed"></a>

## 3. 实采状态（R1–R7）

| 状态 | 原件 | 真实观察 | 设计用途 / 边界 |
|---|---|---|---|
| R1 scope | `02-src`、`04-query` | 树选中 `src` 后 Ctrl+Shift+F 打开 Find in Files popup，Directory 自动为选中目录；输入 token 得 4 matches in 3 files，d.txt 不在列表 | DEC-01；Taomni 的 Directory 输入为 Find in Directory 入口预置，入口形态不同 |
| R2 mask | `08-mask-result` | 勾选 File mask 并输入 `*.txt` 后 header 为 3 matches in 2 files，c.md 消失；预览区显示 a.txt 全文并高亮当前命中 | DEC-01 |
| R3 replace mode | `10b`、`13-preview` | popup 内 Ctrl+Shift+R 切到 Replace in Files，出现 Replace 输入行、底栏 Open in Find Window / Replace All / Replace（Replace 为主按钮）；键入 coin 后预览区**不显示替换后文本**，仍显示原文高亮 | DEC-03；Taomni 冻结预览对照为有意保留的附加信息 |
| R4 find window | `15-find-window` | Open in Find Window 打开底部 Find 工具窗 tab “Replace Occurrences of 'token' with 'coin'”；树 Unclassified→project→src→文件→行，文件节点显示 N results；右侧预览；底栏 Replace All / Replace | DEC-02 |
| R5 exclude | `17b` | 选中 `2 beta token two` 按 Delete：行变删除线灰显，仍保留在树中，文件计数仍为 2 results，选择自动移到下一条 `gamma token three` | DEC-02 |
| R6 confirm/cancel | `19-confirm`、`20-after-cancel.hashes.txt` | Replace All 弹模态 “Replace All / Replace 2 occurrences of 'token' across 2 files with 'coin'?” 主按钮 Replace、次按钮 Cancel；Esc 关闭后四文件字节全部等于初值 | DEC-03/DEC-04、A3 Cancel 零 commit |
| R7 commit | `23-after-replace`、`23-after-replace.hashes.txt` | Enter 确认；约 1.3 s 后独立读盘即为期望提交字节；树里已替换行移除，只留删除线的排除行（1 result） | DEC-05；IDEA 写盘触发机制未识别，不作为 Taomni 保存语义依据 |
| R8 undo | `25-undo-state`、`26-after-undo-nosave.hashes.txt`、`27-after-undo-save.hashes.txt` | Find 窗口焦点下 Ctrl+Z 弹模态 “Undo / Undo Replace?” OK/Cancel；OK 后磁盘仍为替换后字节，Ctrl+S 后恢复为初值（两文件一次恢复） | DEC-06；Taomni 撤销直接写盘保留为已接受差异（DEC-07） |

<a id="capture-gaps"></a>

## 4. 未采状态与补采 runbook

未采：外部修改冲突、打开且 dirty 的文件、部分写入失败、编辑器焦点内的 Ctrl+Z、Redo 确认、结果树右键菜单文字、Tab 焦点序、窄窗/缩放。设计对这些状态按 Taomni 现有契约或明确假设给出期望（见设计 DEC-06/DEC-08），不声称与 IDEA 相同；P2 若补采，按下列步骤，新目录 `qa-ui-auto-report/idea-reference/ed-parity-006/<new-run>/`，不覆盖本轮原件。

1. 取得新的有效时段；只读确认未锁屏、前台窗口与 build；不自动解锁。
2. `python make_fixture.py make <new-root>` 重建 F1-REPL-006，用 `idea64.exe <new-root>` 打开隔离窗口，不在 `demo-sms` 输入。
3. 复现 R1–R5 到排除后状态；在 Replace All 前由另一进程把 `src/b.txt` 改为外部修改变体，记录 IDEA 提示与磁盘 hash（C1）。
4. 打开 `src/a.txt` 键入未保存字符后再 Replace All，记录 dirty 文件的处理（C2）。
5. 提交后把焦点放入编辑器按 Ctrl+Z，再在 Find 窗口按 Ctrl+Shift+Z，分别记录是否确认（C3/C4）。
6. 右键结果行，记录 Exclude/Restore 菜单文字（C5）。
7. 结束时 Undo+Save 或重建 fixture，只关闭本轮窗口，写 manifest。
