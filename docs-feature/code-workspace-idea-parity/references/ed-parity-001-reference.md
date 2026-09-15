# ED-PARITY-001 参照复用、fixture 与待补采状态

关联[本卡设计/AC/V](../find-provider-accessibility-plan.md#ed-parity-001)、[唯一任务板](../backlog.md)、[F0/F2 catalog](fixture-catalog.md)。2026-09-15 首段为 P1 只读核对；用户随后授权桌面采样，真实增量见 §5，早先缺口保留为当时记录。本文件不是 Taomni comparison PASS。

## 1. 已有参照与身份

| 材料 | 已有有效范围 | 本次核对/限制 |
|---|---|---|
| [REF-FIND-FOCUS-20260914](find-focus-2026.2.2.md) | Windows / IDEA Ultimate 2026.2.2 IU-262.10315.125，2026-09-14 两轮 F0 Find/tree/Enter/Shift+Enter/Esc；Islands Dark、100%、Microsoft YaHei UI18、JetBrains Mono18/1.2、Windows-zhyhang | 摘要可复用功能合同；`qa-ui-auto-report/idea-reference/find-focus/20260914/reference-transfer.zip` 本机不存在，不能签像素/操作原件已核验。参照摘要记录的原 zip 预期 SHA 为 `fa328fa968648123d8aa3da67858bf7ab7208e690f8ff0177f9ed9f52444f5cb`；旧板某条 notes 少一个 a，不作校验值 |
| [Linux Tree 参照](project-tree-open-focus-linux-2026.2.2.md) | 同目标 build；Ubuntu24.04/Cinnamon/X11，Islands Dark、110%、Dialog16、Classic Light、Source Code Pro16/1.2、XWin；树到 editor 与多 view 输入/undo | 本机 `qa-ui-auto-report/idea-reference/tree-open-focus/20260914-linux/` 存在；不包含 Find/provider 主链，不能替代 R1–R7 |
| [Linux Shell 参照](shell-layout-2026.2.2-linux.md) | r2 当前主题/UI字体/keymap；r3-04..07 GUI 字体16.0/1.2/无 ligatures；保留原采样日期 | 可作为 profile 核对来源，避免重新询问整份设置；不继承 shell ready/done 或某个旧桌面时段 |

首段只读环境事实（不是执行 readiness；后续实际输入见 §5）：

- 安装 `/data-raw-hdd/dev/idea-IU-253.30387.90` 的 product-info 实际为 `IntelliJ IDEA / 2026.2.2 / 262.10315.125 / IU`，SHA256 `49f4876c2e28c1e78132a6d1eadfc81185f3390b9c9736d1d5220257d9e73298`。目录旧版本名不是实际版本。
- 进程列表存在此路径 IDEA，PID 1983553；wmctrl 当时显示 fixture 窗口 `0x0720004c`。这些只是当时定位，不能硬编码为未来输入目标。DISPLAY=:0、X11；该首段未激活窗口、未检查或操作锁屏、未输入；当时桌面时段尚未答复。后续授权及完成情况见 §5。
- `/data/dev/jdk-25/release`：Zulu25.32+21-CA，Java25.0.2+10-LTS；`/data/dev/jdk-21/release` 也存在。`~/.local/share/jdtls/plugins/org.eclipse.jdt.ls.core_1.61.0.202607102111.jar` manifest 为同版本；安装不等于当前生产 session ready。未来固定运行 JDK 21+，记录实际命令/版本，不能用 IDEA JBR 代替 Taomni provider JVM 身份。
- `/usr/bin/orca` 存在；未启动、未确认 AT-SPI/播报可用。IME 和 screen-reader 的实际输入/播报仍未验证，不从安装推断可用。
- Windows P3 `qa-ui-auto-report/find-focus-20260914/evidence.json` 本机不存在；引用[旧卡记录](../../../claudedocs/code-workspace-idea-parity-backlog-find-focus.md)时明确是历史摘要，非当前原件复验。

<a id="fixture"></a>
## 2. 精确 fixture（设计字节；本次 IDEA 已创建隔离副本）

F0 复用 [catalog F0](fixture-catalog.md#f0) 四文件；example 字节严格为 `Project tree example\nThe editor buffer should survive tree navigation.\n`，UTF-8/LF/无 BOM，71 bytes。两处 tree 为 `[8,12)`、`[54,58)`；本次静态计算纠正旧文字偏移，不改历史截图观察。

**F2-NAV-001** 是 catalog F2 已允许的两类最小 Java 变体，仅用于本卡。将以下三个文件写到未来报告目录 `qa-ui-auto-report/ed-parity-001/fixtures/f2-nav-001/` 的隔离副本，IDEA/Taomni 各自 copy，禁用源码 seed 修改。代码块内容末尾都包含一个 LF；不添加空行、BOM 或 CRLF。不执行 Maven build；IDEA import/index 与 JDT LS ready 必须分别实际观察。项目 source/target11，运行 provider JDK21+；无外部 dependency，不用已有 completion 裸 token 样例充当无语法错误工程。

`pom.xml`：

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>parity</groupId>
  <artifactId>find-nav</artifactId>
  <version>1.0</version>
  <properties>
    <maven.compiler.source>11</maven.compiler.source>
    <maven.compiler.target>11</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
</project>
```

`src/main/java/parity/Main.java`：

```java
package parity;

public class Main {
  public static void main(String[] args) {
    System.out.println(Helper.greet());
  }
  // greet is a text-only Find match.
}
```

`src/main/java/parity/Helper.java`：

```java
package parity;

public class Helper {
  public static String greet() {
    return "hello";
  }
}
```

初态：Main.java clean、caret1:1/空选区、Find 关闭、provider 已 ready，记录 workspace/view 身份和 history 起点。`greet` 的 Find 范围与 definition 位置由下方静态字节核对表固定；点击的是 Main 的方法调用 token，唯一预期目标是 Helper 的方法声明。LSP 返回的完整 range 以真实 provider 响应记录，不能先编造 selectionRange。注释同名词只用于区分 Find 匹配，不能把它当语义定义目标。

<a id="capture"></a>
## 3. 最少补采 R1–R7（最初计划；实际完成项见 §5）

缺少状态是 A2/V2 的 ready 阻塞。先取得本轮约5分钟独占桌面时段；Java import 若未就绪不靠固定 sleep 伪装 ready，可先采 F0，记录剩余状态。时段结束或用户输入交错即停；锁屏不自动解锁。每次输入前确认未锁屏、PID/窗口路径/前台与 editor 或 Find 的焦点，输入后记录一致性；失败/漂移片段只作诊断。

| 步骤 | 前置与输入 | 必须采集的结果 |
|---|---|---|
| R1 | 只在本包隔离工程；核对 product-info 与运行实例、客户区/DPI、主题/缩放/字体/keymap 与历史 Linux profile；设置不变则复用原件，不 Apply 个人设置 | 实际有效 profile、fixture manifest/hash、入口/正文初态；Java 插件/项目 SDK/source level、import/index ready 单独记录 |
| R2 | F0 正文1:1 → Ctrl+F → Ctrl+A 清 query → tree | 当前/其他 match 角色、输入焦点、1/2、选区/状态栏，完整原图及动作 metadata；不先照搬 Windows 像素 |
| R3 | Enter → Shift+Enter → Esc；Ctrl+F 重开 → Esc | 2/2→1/2、同 view 当前 selection、正文焦点、关闭后的空间恢复、无正文变化；query 重开是否保留 |
| R4 | Java Main.java1:1 → Find greet → Enter 到注释 → Shift+Enter 回调用 → Esc | 两匹配分别位置、回调用选区/焦点；普通 Find 不依赖 provider 的事实与 Java 语义准备分开 |
| R5 | 当前 keymap 的定义 modifier 悬停调用，release，再按 modifier 点击调用；Back | 下划线/指针与 release 清理；Helper.java 方法声明处 caret/selection，Back 返回 Main 调用位置；IDEA 使用 Java 分析器，不声称 JDT LS 是 IDEA provider |
| R6 | hover 中 Ctrl+F、Esc，再 hover；100%基准/200%（仅隔离设置可恢复时）的键盘可达性 | 旧 decoration 清理/新 hover 可用；面板焦点、More/Replace/关闭可达。200% 是 Taomni accessibility 必验，IDEA 未能采不冒充逐像素要求；记录实际 zoom 来源，禁止改个人配置后不恢复 |
| R7 | 退出本轮弹层；检查 dirty/正文与三个 Java/F0种子 hash；归还桌面 | 起止时间、目标窗口最终状态、未执行步骤、污染/失败、恢复结果；任何意外写入先保留工件再只恢复本包副本 |

原件未来放 `qa-ui-auto-report/idea-reference/ed-parity-001/<实际run>/`，记录 PNG/JSON/manifest 的相对路径和 SHA256；摘要回填本文件真实动作/结果。不得创建目录就声称采样完成，不把上表当实际结果。跨机器取得 Windows 原 zip 时按原 manifest 验证；本机 Linux 仍只补未覆盖的场景，避免跨平台像素直接比较。

错误/取消/迟到/Save/Undo 的 Taomni 断言见[设计 S3–S6](../find-provider-accessibility-plan.md#5-连续场景与本卡验收)；IDEA 的未采分支不标 matched。没有 IntelliJ 源码/帮助文档替代真实观测，没有新图稿或模拟截图。

## 4. 静态字节核对（非运行结果）

| 文件 | UTF-8 bytes | SHA256 |
|---|---:|---|
| `pom.xml` | 399 | `a59f86b30e7800d0d366b45f9d507a0936a19ce9654d8c63b93c858f92cece91` |
| `src/main/java/parity/Main.java` | 164 | `0270e743c3d59fff2ab7b6e12df53903b4b06c84ac16620630a349290fdc3e2e` |
| `src/main/java/parity/Helper.java` | 98 | `7bc3ce1f635936cec3852c16463b72d832f5adb181cd6dc840f6e6ec0b84c511` |

Main.java 的 greet：[110,115) / LSP (4,30)；[129,134) / LSP (6,5)。ASCII fixture 的字节偏移与 UTF-16 偏移相同，范围右端不含。

Helper.java 的 greet：[62,67) / LSP (3,23)。ASCII fixture 的字节偏移与 UTF-16 偏移相同，范围右端不含。

<a id="observed"></a>
## 5. REF-PARITY-001-LINUX-20260915：本轮真实采样

用户在本会话明确让出桌面，第一段实际采样 12:58:21–13:04:02（Asia/Shanghai），随后归还；审阅发现 hover 被 selection 遮住，再获用户明确授权，第二段 13:08:01–13:09:42，结束已再次归还。两段之外没有输入。所有 XTEST 输入前检查 IDEA PID/foreground 与 Cinnamon ScreenSaver=false；未解锁、未向其他 app 输入。使用系统 `/usr/bin/python3`、python-xlib/XTEST、Pillow；r2 用 XFixes 独立获取系统 cursor 图和 hotspot/serial，未把 cursor 拼进原始窗口图。

运行实例 PID1983553、安装路径及 product-info 同 §1 的 IU-262.10315.125。复用现有 F0 fixture 窗口采到主链；另从 IDE launcher 打开本轮 F2-NAV-001 的新窗口，明确只 Trust 本包项目，未勾选信任父目录。仅打开/导入隔离 Maven 项目，没有运行 Java build/test。原 F0 窗口未关闭，F2 新窗口最后停在 Main.java、Find关闭、Ctrl已释放；两份 Java 与 pom/F0 seed 磁盘 hash 前后一致。

原始目录：`qa-ui-auto-report/idea-reference/ed-parity-001/20260915-linux/`。截图 `00..45`（22失败无截图）和 `r2-00..11` 各有同名动作JSON。`manifest.json` 与入库[工件清单](../evidence/ed-parity-001-reference-artifacts.json)记录原件SHA256；跨机器按清单从本机取得对应工件并逐项核验，不靠聊天图片复验。`review-sheet.png` / `r2-review.png` 为派生缩略/裁剪审阅图，不是原图。`settings-readonly.json`、`fixture-manifest.json`、`final-hashes.json`、`f0-source-hash.json`、`measurements.json` 是独立只读观察/计算资料。

### 实际环境与上限

- F0 客户区1920×1044，屏幕坐标(0,36)；F2客户区1400×1000，坐标(260,58)，均来自X geometry；不把这些当CSS客户区。当前只读设置Dialog16、ideScale1.1、Source Code Pro16、`_@user_Default`与已有效Linux Tree/Shell原件相符，复用 Islands Dark/Classic Light/line-height1.2、XWin原记录；本轮未重开设置页，不刷新旧GUI采样日期。初始Find灰黑带、蓝focus框、当前蓝选区/其他黄匹配与这些参照一致。当前代码实测行基线间距约28原始px。
- 项目pom明确source/target11；IDEA自动导入并有Java分析。Main打开初段仍显示Analyzing，34及后续显示绿色分析勾，36/43两次正确解析到项目内Helper方法，40/44返回源调用。日志记录该项目退出dumb mode，用作佐证，不以日志代替UI动作。**未取得该新项目实际分配的SDK版本**（misc.xml未持久化对应值），不能把机器已注册JDK或IDEA JBR称为项目JDK。本包只比较已实测项目内方法导航，不声称编译、标准库或外部classpath就绪；P2须记录真实JDT LS运行JDK21+及项目source11，不要求IDEA/LS使用相同分析器。
- IDEA将Main方法折叠为一行且水平滚动，行号仍跳过折叠部分，文件字节未改变。本文不将折叠显示当格式化结果或要求Taomni复制折叠策略；比较Find/hover/目标定位时匹配token位置与pane区域，整体Java正文像素不作等价要求。必要时后续补展开态仅用于全正文视觉比较，当前卡没有新增折叠能力目标。

### 已执行动作与观察

| 原件 stem | 真实动作与结果 | 覆盖与边界 |
|---|---|---|
| 01–05 | F0 Enter打开→Ctrl+Home→Ctrl+F→Ctrl+A→tree | Find输入获焦，1/2；第一处tree当前选区、第二处黄色匹配；单行面板位于pane tabs下 |
| 06–10 | Enter→Shift+Enter→Esc→Ctrl+F→Esc | 2/2（状态栏2:38/4 chars）→1/2（1:13/4 chars），Esc同editor保留当前选区；重开query全选，关闭归还面板空间 |
| 11–16、24–26 | 新窗口打开/Trust单项目/Load Maven Project；Go to File main.java后Enter、Ctrl+Home | 到达真实Main；导入提示及IDE error提示原样记录，见诊断边界；不是新产品缺陷 |
| 27–32 | Main Find greet→Enter→Shift+Enter→Esc | 1/2调用→2/2注释→1/2调用；Find继续持焦；Esc返回调用5字符选区，状态栏5:36 |
| 33–36 | 鼠标移调用；按Ctrl、松开；Ctrl+click | 36打开Helper.java，caret4:24位于greet声明；34选区遮挡且无cursor采集，**不作为hover样式成功证据** |
| 37–40 | Ctrl+Alt+Left（未返回）；Helper重开Find/Esc；Alt+Left | XWin实际Back为Alt+Left，40回Main调用位置5:33，保留五字符selection。37失败键位不写通过，38/39是Helper上的Find，不冒充Main重复 |
| 41–44 | Main Ctrl+F/Esc→Ctrl+click调用→Alt+Left | 第二轮真实Main→Helper声明4:24→Main调用5:33，结果同首轮 |
| r2-01..05 | Right收起选区→鼠标移开→按住Ctrl→移回greet→松Ctrl | 04蓝色greet下划线及XFixes手形pointer；05下划线清除、恢复I-beam。括号配对背景不是搜索选区；原图与cursor独立保存 |
| r2-06..10 | 再Ctrl-hover→保持Ctrl按f→松Ctrl→Esc | 新hover仍有效；Find打开后蓝link清除，input focus框与1/2；Esc正文caret恢复、cursor为I-beam，未见旧hover复活 |

### 局部视觉目标

05原图的pane为x≈688..1865，tab下缘y≈103；Find带y≈104..161，约58px高；输入focus外框x≈741..1160、y≈111..154，约419×43px。关闭后正文第一行基线从约179移至119，空间恢复约60px；测量不确定度±2px，详见measurements。蓝选区样点RGB(89,116,171)，其他match样点RGB(255,255,0)，仅指本profile。P2比较相同pane/字体/缩放后，按这些局部值评估；不硬编码为跨平台全局token，不把±2测量误差当默认验收容差。hover目标是可辨链接角色与release/Find及时清理，系统手形与I-beam的原始cursor图提供状态证据。

### 诊断、未采项与结论

首个`python`缺Xlib，改用现有系统python3，无安装依赖；22输入器不支持`.`，停在查询框、未写正文，修正临时采样脚本后23/24明确全选并重输；r2一次误写不存在采样脚本路径返回exit2，没有输入，随后04/05完成并释放Ctrl。上述为采样设施错误，不是IDEA或Taomni问题。

15原图出现IDE error通知，具体根因未确认，保留原图与局部日志；没有关闭/忽略产品失败来制造通过。后续目标内Java解析/reveal/back结果可直接观察，但不能把整个IDE环境称为无异常。初段Analyzing不当最终ready；成功导航和绿色勾只支持这个项目内声明查询上限。

200% zoom、IDEA Replace几何、真实物理IME、屏幕阅读器播报未执行；它们不在本轮新IDEA主链参照中冒充matched。用户明确“沿用原AC；播报保留未验证边界”。Taomni的keyboard/ARIA/zoom/IME与readonly/Replace/shared undo仍按设计全部保留，在P2执行，未删除已知要求。

**本卡必需的Find→modifier→定义→Back目标参照已就绪，可用于P1 author ready；没有签发Taomni功能/UI/交互通过。** 全部新卡产品验收仍未执行，当前端provider/IME/QA binary readiness仍由P2正式领取后核验。无需为本包再盘点整个IDEA或获取旧Windows zip。
