# REF-SHELL-LAYOUT-LINUX-20260914 — 两轮局部参照，仍有明确缺口

2026-09-14 19:48–19:53（Asia/Shanghai）新增真实 IDEA 操作；20:00 前后仅正常关闭本轮 fixture 窗口并停止桌面输入（精确关闭时刻未单独记）。此文以检查原图后的结果为准，文件名中的动作意图不等于已达成。关联 [设计](../shell-layout-design.md)、[工件清单](../evidence/shell-layout-artifacts-20260914.json)、[规划身份](../evidence/shell-layout-plan-20260914.json)。不是 Taomni 对齐证明。

## 1. 身份与环境

实际安装 `/data-raw-hdd/dev/idea-IU-253.30387.90/`，读取 product-info：IntelliJ IDEA、version=2026.2.2、buildNumber=262.10315.125、productCode=IU。当前进程 PID1983553 从该路径运行，未用目录旧数字推版本；未重采 About（同进程历史 r2 About 可复用）。Ubuntu24.04、Cinnamon/X11/:0。新项目窗口 XID119547235、input child119547241，客户区 (260,58,1400,1000)，窄窗 (260,58,800,700)。位置按 Xlib translate/geometry 与截图尺寸，wmctrl 的位置报告不同，未用其坐标裁图。

| 配置 | 本轮可证 / 边界 |
|---|---|
| UI font/zoom | 只读已保存 other.xml 的 NotRoamableUiSettings：Dialog、16、ideScale1.1、overrideLafFonts=true；不是本轮GUI核对。历史16-settings-ready截图同profile支持110% |
| tool stripe | 已保存ui.lnf.xml：SHOW_TOOL_WINDOW_NAMES=true、左右custom width50；新原图tool rail显示文字截断，不能无记录改成“默认icon-only” |
| editor font | editor-font.xml Source Code Pro16；colors.scheme.xml `_@user_Default`；line-height1.2/Classic Light名称、ligatures off来自历史Tree设置原图，未本轮GUI复核 |
| theme/keymap/locale | 新图深色shell/浅色editor、英文；Islands Dark/XWin是历史已观测设置，当前GUI未重核，不能当完整本轮visual profile |
| DPI/scale | 历史 Xft96、Cinnamon自动scale；本轮未重读当前DPI，缺口明确。1400×1000是客户区而非Taomni可比较内区；后者尚未采 |
| readiness | F0纯文本/Markdown source，无SDK/provider要求。README自动打开后等待8秒，图无加载spinner。右侧Augment在部分状态出现，属于既有插件，不作为新产品能力目标 |

历史Tree原件187条按清单重新校验：缺件0、hash不符0。其行高30px、选中/失焦背景、文件双击/Enter/分屏/菜单Esc只适用于原profile和动作。Find原卡状态及provider缺口不由这个参照改变。

## 2. Fixture、工具和授权

原始目录 `qa-ui-auto-report/idea-reference/shell-layout/20260914-linux/`，本机 ignored，不入Git。F0目录 `f0-shell-layout/`，通过导入 `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/project_tree.py::SEED_FILES` 重建，UTF-8/LF/no BOM；`.idea/` 元数据不计入四份种子。初始及收尾hash见 `fixture-manifest.json`、`final-fixture-hashes.json`，不是截图推测文件结果。

`capture.py` 从旧脚本复用，本轮仅在忽略目录扩了drag输入；用 `/usr/bin/python3` + Xlib/XTEST + Pillow。默认 `python` 没有Xlib，首次调用失败，未产生输入/截图；改用系统Python。打开新项目选择New Window、Trust Project，不勾选trust parent，不改用户全局设置。已知新fixture无可执行项目配置。OS输入为合成XTEST，非物理键盘/IME。

用户明确“现在可以”后输入，开始前已告知约12–15分钟；这次时段结束已归还，后续不得继承为永久桌面授权。每次输入前后guard核对active PID和未锁屏；guard只证明应用/窗口，不能证明Swing组件focus，所以需可见caret/真实文本落点，当前尚缺后者。没有自动解锁。

## 3. 原始步骤与实际结论

每个stem为同名PNG+JSON，JSON记实际action、before/after窗口/PID/input-focus、time/geometry；`13/14/23`外部wmctrl动作另记在session operations文件。先看原图再判定，失败命中不冒充成功。

| stem | 实际动作 / 原图观察 | 可复用范围 |
|---|---|---|
| 00-before、01-new-window、02-trust | New Project选择新窗口、Trust Project、启动中spinner | 只作setup，00不是原用户窗口的初始布局截图 |
| 03-normal | F0 README source；Project x55..509、editor x518..1344；顶部toolbar约55高，左右rail各55，底部status y953..999；bottom closed | 正常空间层级。Project宽455/1400，不是“默认36%”固定值；用户profile可能携带默认布局 |
| 04-alt1 | Alt+1后Project根行从失焦选择变蓝；README仍开，bottom closed | 已打开但失焦工具通过Alt+1获焦；**没有**Project折叠/重开证据 |
| 05-bottom-collapse | click(1110,969)是未命中拟议bottom控制的动作；之后右侧Augment出现，原因未确认 | 非目标状态，不能说底部折叠或归因插件自动行为 |
| 06-problems-open | click(26,804)后Problems底部出现；File选中、空态“No problems in README.md”；蓝色Problems rail | Problems入口与空态；底部横跨Project/editor/right内区，侧rail外置 |
| 07-problems-esc | Escape后Problems仍可见，File/rail失焦；editor可见caret | 支持Esc不关闭该工具窗、focus外观改变；缺直接字符落点，未证明精确editor focus |
| 08-project-resize | drag(510,500→650,500)，Project边界约x647，editor起x655，右Augment仍开 | 真实Project resize使editor变窄；不能推广到bottom resize/最小边界 |
| 09-narrow-window | **实际F11**，客户区仍1400×1000，README gutter出现bookmark | 无效narrow步骤；不作尺寸参照，bookmark只在本轮隔离fixture |
| 10-bottom-collapse | click(26,804)，Problems body消失，editor/Project向下扩展 | 已激活Problems按钮再次点击收起 |
| 11-bottom-resize | **dock已收起**时drag(640,630→640,780)；Project根行获焦，bottom仍closed | 不是底部resize证据，需保持open后重采 |
| 12-bottom-reopen | click(26,804)，Problems重开、空态保留，高度与前图近似 | 收起/重开主路径；没有有数据case或精确height restore证明 |
| 13-narrow | wmctrl将客户区缩至800×700；Project、极窄editor、Augment、底部Problems均在；顶栏label/树文本截断、toolbar收缩 | 真实窄窗截图，可观察拥挤/溢出；右插件污染首包布局条件，未测最小值或声明此极窄editor是Taomni推荐 |
| 14-restored | wmctrl回1400×1000，各pane再次展开；Project横向scroll变化仍在 | **窗口大小恢复**，不是Restore Layout action |
| 15-menu | 汉堡菜单打开File菜单，覆盖Project/editor，有Settings/Open等可见项 | 真实菜单层级，不证明全菜单能力或edge flip |
| 16-window-menu | click(681,25)后菜单关闭，Problems仍显示 | 没有Window菜单截图；命中失败诊断 |
| 17-action-search、18-action-type | Ctrl+Shift+A；随后键入Restore Default Layout，18实际显示Actions搜索栏（输入为小写），结果尚未呈现 | Action Search打开/输入真实，**未选中或执行**Restore action，不作restore证明 |
| 19-action-esc | Escape关闭Actions，Problems选中/焦点外观恢复 | 弹层取消不移除底部；精确Swing focus仍欠直接输入观察 |
| 20-project-restore、21-problems-collapse、22-augment-close、23-final-restored | 拖Project边界回约x507、隐藏Problems与Augment、窗口保持1400×1000 | 人工整理本轮fixture，非IDEA默认布局恢复；并非像素级还原03（横向scroll/bookmark差异保留在fixture） |

局部色彩/几何不能自动成为global token。表中粗像素边界基于原图人工读取，最终比较需同profile/DPR并明确容差。原始PNG保持完整；contact-sheet.png仅缩略审阅，不替代原图。未向IDEA正文输入目标字符，dirty/undo/selection完整序列未采；磁盘四文件hash可证明收尾种子未变，不能证明未保存buffer。

## 4. 第一轮结束时的补采计划（历史，第二轮结果见下）

此包**不能解除首包ready前置**。只补缺口，无需重做P0：

1. 约一个可用桌面时段，打开本隔离F0；确认PID/window/锁屏；GUI核对theme/font/zoom/keymap/compact density并记录current DPI，关闭本包无关右插件。
2. README source + example，存正确editor selection；Project Alt+1获焦、再触发观察hide、rail reopen；每一步截图后再决定坐标。
3. 打开Problems，确认body可见后拖其顶部separator向上/下，记录前后真实边界；hide/reopen再测记忆。通过View/Tool Windows确定Run是否可显示，无配置不可用即如实记录，不臆造Run数据或执行任务。
4. 从工具Esc返回后直接输入单个ASCII、undo，截图并比对文本；菜单打开/Esc再做一次恢复。不仅用同一X input child证明焦点。
5. 通过可见菜单或Actions搜索**等待真实结果**，记录实际layout动作名/绑定；执行恢复并检查Project/bottom/selection/文件/leaf，不将wmctrl放大当Restore Layout。
6. 800×700无无关右pane状态，观察rail更多、tabs溢出、隐藏/disabled；必要再到真实最小窗边界，记录可实现几何，不从当前Taomni猜值。重置后对关键退出/恢复再做一遍。

收尾只关闭自己的fixture窗口，核四文件hash，明确归还。新图稿和任何合法reference/JSON验证都不等于Taomni实现、native通过或视觉matched。当前Windows/macOS均未新采。

## 5. 第二轮补采修订（2026-09-14 21:12–21:22）

用户再次明确“现在可以补采”后启动。新 F0 窗口 XID119551018/input119551024、同 PID1983553，客户区1400×1000；Settings对话框119553299/input119553305、1125×843。21:21:48关闭本轮窗口，随后窗口列表确认仅原Tree窗口保留；21:22明确归还，后续只有文件/配置只读与文档操作。`r2-session-operations.json`补记wmctrl动作。第一轮原件/失败记录不改写；以下结果取代第一轮对应“未采”结论。

以下每个stem均链接同一原始目录的同名PNG+JSON；跨机须取得整个[hash清单](../evidence/shell-layout-artifacts-20260914.json)指定原件并核验，不从摘要签发通过。

| stem | 实际步骤与观察 | 上限 |
|---|---|---|
| r2-01-project-dialog / r2-02-new-window / r2-03-initial | New Window打开同F0，README source、Project展开，bottom与Augment body关闭 | r2-00前置guard因非IDEA前台失败，未输入，不计采样 |
| r2-04-project-focus / r2-05-project-hide / r2-06-project-reopen | Alt+1使Project获焦，再Alt+1隐藏，再Alt+1恢复；边界恢复到x506、editor起x515 | 支持已显示失焦→focus、已focus→hide、已隐藏→show/focus；不是两轮重复稳定性测试 |
| r2-07-problems / r2-08-bottom-resize | rail(26,804)开Problems；在真实展开状态drag(700,626→700,500)，body顶从630到504 | bottom高从323到449（均含标题），真实resize，不是第一轮11的误命中 |
| r2-09-bottom-hide / r2-10-bottom-reopen | 同rail隐藏、再重开，body顶仍504；File tab/空态保留 | 证实高度记忆；空态不证明运行输出/非空问题列表保留 |
| r2-11-escape / r2-12-focus-probe / r2-13-undo | Problems获焦后Esc，dock仍开；直接输入z落在README首字符前，Ctrl+Z撤回 | 直接落点证实editor focus；撤销后截图选中标题字样，没有记录完整selection offsets，不能声称精确选区恢复通过 |
| r2-14-run | Alt+4打开Run；rail出现Run蓝色入口，空态“To run your code…”；body顶630 | 没有执行代码。Run使用约323高，和刚才Problems449不同；不能把IDEA说成所有工具共享同一高度 |
| r2-15-action-search / r2-16-restore-search / r2-17-restore-results | Ctrl+Shift+A，输入restore layout；等待后唯一选中Restore Current Layout，路径Window / Tool Window Layouts，Shift+F12 | r2-16仍是异步中间结果，不能立即按Enter命中Remote Servers |
| r2-18-restore-invoke | 在r2-17可见结果上Enter，Project及Run均隐藏，README仍打开、正文与标题选择外观保留 | 真正restore action；恢复的是当前命名布局，非“IDEA新工作区默认一定隐藏Project”；不证明dirty、多leaf或磁盘语义 |
| r2-19-settings / r2-20-appearance / r2-21-keymap | Settings加载完成后：Islands Dark、Classic Light、110%、custom Dialog16，different tool window background未选；XWin | 当前GUI证据替代历史对应项；未修改设置 |
| r2-22-editor-expand / r2-23-font / r2-24-cancel-settings | 展开Editor后点击Font；r2-23仍显示Keymap，随后Cancel | Font页未采成功，不因stem叫font便当通过；不曾Apply |
| r2-25-project / r2-26-problems / r2-27-narrow | 重新开Project/Problems，wmctrl800×700，无Augment body；Project仍约455宽，editor约227宽，Problems顶330 | 干净的目标pane组合；toolbar/tab标签截断，Problems仅File/Project Errors可见并出现下拉箭头；未打开该overflow列表、未触达真正min clamp |
| r2-28-menu / r2-29-menu-escape | 窄窗汉堡打开File菜单，Esc关闭 | 真实菜单取消；未以随后输入证明精确opener组件焦点，沿用用户保留合同与Tree历史证据，改后必须验证 |
| r2-30-restored-window / r2-31-hide-bottom | wmctrl回1400×1000，隐藏Problems，关闭本轮窗口 | 大小恢复/人工整理与r2-18的Restore Current Layout严格区分 |

当前只读配置补核见`r2-current-settings-readonly.json`：Xft.dpi96、Cinnamon scaling-factor=0（自动，不等于实效1）、text scale1.0；editor-font仍Source Code Pro16。`ui.lnf.xml`仍左右工具rail自定义50、显示名称。lineHeight1.2来自历史GUI，当前XML无显式值不能证明当前effective值；compact density、JBR/monitor有效scale仍缺。四份F0磁盘hash第二轮收尾均与seed相同（`r2-final-fixture-hashes.json`）。没有把磁盘一致等同未保存buffer/dirty全过程证明。

## 6. 已测几何和剩余最小补采

本表是当前profile下的原始客户区像素，人工边界读数约±2px；该±2只表达取点不确定性，不是Taomni验收容差。没有DPR/zoom换算前不得直接写成CSS px默认值。

| 状态 / 来源 | raw px可用测量 |
|---|---|
| r2-03 / r2-07 / r2-08 | toolbar高55；左右rail各55；内区x55..1345；status顶953；Project x55..507约452；Project/editor gap约8；editor tab strip y55..103约48；Problems header约50 |
| r2-07 →08→10 | bottom上边630→504→504；下边953；高度323→449→449；Project/editor随bottom占用一起变矮 |
| r2-14 | Run上边630、下边953，高323；工具个体高度与Problems存在差异 |
| r2-27 | 800×700，内区x55..745；status顶653；Project右边510、editor左边518；bottom顶330，header底380；editor窄至约227px，正文横向滚动、tab收缩，不能据此称227是最小值 |

已解决：Project hide/reopen、底部真实resize及记忆、Problems Esc直接editor输入/undo、Run空态、真正Restore Current Layout、干净窄窗、File菜单Esc、当前主题/UI字体/zoom/keymap与Xft读取。

## 7. 第三轮补采与前置解锁（2026-09-14 21:51–22:18）

用户明确授权集中时段（“使用方案B，先补采，然后再实现，我把桌面和idea的控制权交给你”）。临时窗口119555048，同PID1983553，F0 种子保持一致（`r3-final-fixture-hashes.json`），22:18:48已关闭临时窗口并归还桌面，仅保留原用户窗口。

| stem | 实际步骤与观察 | 结论 / 测量定值 |
|---|---|---|
| r3-04..07-font-page | Settings搜索Font，等待页面标题确为`Editor > Font` | 真实GUI确认：Font `Source Code Pro`，Size `16.0`，Line height `1.2`，Enable ligatures 未勾选；确认生效值 |
| r3-15-drag-project-min | 拖动Project边界至最左x=60 | Project面板完全折叠收起至左侧rail（min width = 0，折叠状态） |
| r3-20..26-drag-project-max | 拖动Project边界至x=1100、1250、1308 | Project最大可扩展至x=1308（内区1345），保留约37px最小editor行号边栏/切片，不完全覆盖右rail |
| r3-29-drag-bottom-max | 拖动Problems separator向上至顶端 | Problems向上最大可拖至y=104（高849px），上方保留55px顶部toolbar与48px editor tab strip |
| r3-30-drag-bottom-min | 拖动Problems separator向下至底端 | Problems向下最小可拖至y=904（高49px），正好只露出约50px的标题栏header（min clamp = 标题栏高度） |
| r3-32..42-narrow-overflow | 800×700下展开Problems（顶y=350），点击x=649, y=377的下拉箭头 | 弹出overflow下拉菜单，依次显示隐藏tab：`Vulnerable Dependencies`、`Qodana`、`Security Analysis`；按Escape正常关闭下拉菜单 |
| r3-44..48-menu-direct-input | 打开汉堡菜单，按Escape关闭，直接按键盘`z`，再按Ctrl+Z | 无需点击editor，字符`z`直接输入至README.md（`# przject-tree-e2e`），Ctrl+Z撤回成功，证实菜单Esc后精确editor焦点保持 |
| r3-49..51-restore-direct-input | 按Shift+F12执行Restore Current Layout，直接按键盘`z`，再按Ctrl+Z | 无需点击editor，字符`z`直接输入至README.md，Ctrl+Z撤回成功，证实Restore Layout后精确editor焦点恢复 |

**结论：BL-SL-01 剩余参照定值已全部补齐，BL-SL-01 已完全解锁！**
任务板卡 `ED-SHELLLAYOUT-001` 可以由 authoring 修订为 `ready` 并正式进入 P2 领取与实施。

