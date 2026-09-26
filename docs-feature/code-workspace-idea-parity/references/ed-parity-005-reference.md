# ED-PARITY-005 参照核对与缺失状态补采

Reference ID：`REF-PARITY-005-WIN-20260925`；状态 **partially-observed**。用户本轮已确定目标为 Ultimate **2026.2.3 / IU-262.10968.63**；必要类型/方法接受、live template导航、字体/缩放及边缘状态已补采；用户已决定保留provider snippet差异，P1目标已定。仍有执行期双侧证据未完成。不是 Taomni 双侧比较通过。

关联：[唯一板](../backlog.md) / [设计及测试用例](../java-basic-completion-plan.md#test-cases) / [F2 catalog](fixture-catalog.md#f2)。P1 起初只读核对；用户答复后在 2026-09-25 10:46:45–10:56:45 +08:00 的十分钟时段内操作隔离 IDEA 项目。没有启动/测试 Taomni，没有运行 JDT LS。新窗口关闭后核对无本卡窗口残留；桌面已归还，时段不续期。

<a id="observed"></a>

## 本轮有效实采与排除项

原件根：`qa-ui-auto-report/idea-reference/ed-parity-005/run-20260925-024645/`；其中 `manifest.json` 保存逐原件 SHA-256、身份及局限，`steps.jsonl` 保存 UTC 时间、输入、foreground HWND/title/rect。工具为 PIL ImageGrab（原图1366×768）+ Win32键盘；每批输入前检查IDEA前台，逐张视觉后验排除输入污染。窗口rect `(10,20,1356,700)`；深色New UI可见，Windows keymap沿前次记录核对其Ctrl+Space/Undo实际动作；该轮有效字体/缩放当时未确认，后续实采见下节。**截屏区域含桌面背景，只分享必要原件，34/35含意外系统弹窗，不作为参考。**

| 原件 | 真实观察 | 结论边界 |
|---|---|---|
| `04-open.png`、`33-sdk.png` | 完整语法Main.java；GUI显示zulu-22 Azul Zulu22.0.1、language21 | 显式IDEA module可用；没有执行Maven导入/构建 |
| `07-basic.png`、`08-selected-doc.png` | StringUti显式Basic后3项：StringUtils、已废弃StringEscapeUtils、RandomStringUtils，均显示org.apache.commons.lang3；Ctrl+Q详情在列表左侧 | 同固定库的类型目标已实采，不能泛化候选完整性；列表约28px行距仅本图像素，不是跨DPI设计token |
| `09-accept.png`、`09-accepted.java.txt` | Enter接受；新增单一lang3 import及StringUtils正文；caret在identifier后、分号前 | 精确T1以文本原件为准；显式Ctrl+S后独立读文件 |
| `10-undo.png`、`10-undo.java.txt` | 一次Ctrl+Z同时撤回正文补全和import，回StringUti及caret | 类型一次Undo已观察；不是Taomni结果 |
| `11-reopen.png`、`12-tab-accept.png`、`13-tab-undo.png`、`14-cancel.png` | 同prefix重开，Tab接受、Undo、重开Esc保留prefix | 仅词末插入状态；词中Enter/Tab差异、鼠标接受未采 |
| `24-method-basic.png`、`25-string-overload.png` | append重载列表、选择append(String str)；显示返回StringBuilder，Ctrl+Q说明 | 该轮缩进因Smart Home替换发生变化，精确输入不能冒充原B0 |
| `26-method-accept.png`、`26-method-accepted.java.txt` | 接受得到append()，caret在括号内，不是自动填str | 不能据此认定Taomni/JDT LS snippet默认值相同 |
| `27-tab.png`、`28-undo-method.png`、`29-method-undo-accept.png`、`29-method-preimage.java.txt` | Tab之后第一Undo仍为append()；第二Undo才回appen | 此轮Tab进入了可撤销变化，不能当纯snippet导航PASS |
| `30-method-reopen.png`、`31-accept-round2.png`、`32-immediate-undo.png` | 重开接受后立即Undo回appen | 支持方法接受本身单次Undo，未证明完整placeholder生命周期 |

有效样本T0/T1与缩进不同的N0/N1均保留，不修图或改文本制造匹配。15–19受IME污染，20起切换本窗口English layout后重建；原输入layout在结束前恢复。34–35的Ctrl+Alt+S触发HP系统窗口，随后font误入fixture editor；系统窗口关闭、输入Undo。设置最终经Search Actions打开，但39–46没有到达Editor Font，不能拿Data Editor字体当代码字体。只取消/关闭Settings，没有Apply。未采mouse/完整snippet Tab/ShiftTab/窄窗底缘。

<a id="followup-observed"></a>

## 第二时段补采与最终参照合同

用户再次授权十分钟，执行窗口为 **2026-09-25 11:17:01–11:27:01 +08:00**；原件根 `qa-ui-auto-report/idea-reference/ed-parity-005/run-20260925-031701/`，`manifest.json` 保存逐文件hash、环境与排除项；`steps.jsonl` 保存每步UTC/window/input。时段已结束，键鼠守卫拒绝了过期操作；随后仅向本轮拥有的fixture HWND发送WM_CLOSE完成清理，核对窗口已消失，没有关闭用户工程。

| 原件 | 实际观察 / 最终设计依据 |
|---|---|
| 06-editor-font、07-appearance | GUI明确 Editor Font=Source Code Pro 16.0、line height 1.2、ligatures off；Islands Dark、editor scheme Dark；UI Zoom 100%、Microsoft YaHei UI 14。Win32窗口DPI=96，屏幕1366×768。没有Apply设置 |
| 17-mid、18-mid-enter.java.txt、19-mid-undo、20-mid-tab.java.txt、21-mid-tab-undo | 精确输入Tmid为T0把StringUti改成StringUtiSuffix，caret位于StringUti后。Enter→StringUtilsSuffix；Tab→StringUtils；各新增单一import；各一次Undo恢复Tmid。两入口的替换范围不同 |
| 22/23、25-mouse-accept、26-mouse.java.txt、27-mouse-undo | 单击候选仅选中；快速双击接受，结果为StringUtilsSuffix+import，与Enter一致；一次Undo回Tmid。27后Ctrl+A仅为下一轮重置 |
| 28-method-clean、29-method-list、30-method.java.txt | 清洁N0无额外缩进；选择append(String str)，Enter后精确N1为N0的appen替换为append()，caret在括号内。30图中灰色“seed”和Tab to complete是inline建议，实际文件没有参数 |
| 31-method-tab.java.txt、32-method-shifttab.java.txt | Tab实际提交inline的"seed"；Shift+Tab执行行反缩进。它们是独立编辑，不能用来宣称方法snippet导航已匹配；本卡不实现IDEA inline/full-line能力 |
| 35-template-list、36-template.java.txt、37-template-tab、38-template-shifttab、39-template-end、40-template-undo、41-template-second-undo | fori经Basic候选接受为循环；首选区i，Tab到空上界，Shift+Tab回i，Tab两次到循环体。末尾完成自动删去空上界前空格，第一次Undo恢复格式化，第二次回首字段选择，仍未回fori。区分纯字段导航和模板完成格式化，不能宣称整个序列只一次Undo |
| 44-edge-list、47-screen-edge | 950×390窗口两位置，列表靠caret，docs在列表左侧；弹层可越出IDEA主窗口而留在屏幕内。47右端贴屏幕边界，未横向越屏，docs未覆盖选中行。浏览器目标为WebView viewport内可达，不要求DOM越出宿主窗 |

输入污染：09–11从Settings返回后焦点仍在项目，粘贴创建隔离root/Main.java，OFF/no suggestions不是目标源码结果。13–17明确点击src路径tab及editor再重置，后续结果来自正确src/main/java/parity005/Main.java。只影响本轮隔离副本。用户答复导致焦点切离时守卫拒绝输入；45重新确认后才继续。工具使用临时剪贴板粘贴并恢复可读格式，没有打印剪贴板内容。

**用户已定适配**（本轮答复）：保留provider原始snippet默认值及占位符，不增加Java参数清空；与IDEA append()明确记为接受差异。IDEA live template只作导航形态参照，不伪装成JDT LS报文；Taomni仍保留既有一次原子接受、纯导航不加history合同，且不引入IDEA模板结束时的自动格式化步骤。IDEA类型词中Enter/Tab/双击按本次实测对齐。当前没有Taomni侧结果，不签matched。

L0重建：B0的sample方法体改为单行 `        fori`（无分号）；L1见36-template.java.txt，为 `for (int i = 0; i < ; i++) {` 加空循环体，初选i。仅用于参照导航，**不要求Taomni新增fori模板**；Taomni保留测试仍用B-005及已有模板。

N1确定为IDEA append()；Taomni真实provider验证在相同N0捕获固定append(String str)原始item/resolve报文，以其insertTextFormat、snippet语法展开作为协议预期，接受文本必须严格等于该展开与全部additional edits的一次事务结果，不得按渲染结果倒填预期。格式2必须按字段顺序导航/反向/退出并一次Undo；若真实provider不提供任何可用snippet，不以普通文本冒充native snippet通过，保留该AC未验证并报告provider能力边界。browser B-005保证snippet引擎完整确定性覆盖，不能代替此真实provider要求。

## 1. 环境身份与复用边界

| 项 | 已知来源 | 本卡结论 |
|---|---|---|
| 原 F2 目标 | catalog：IDEA Ultimate 2026.2.2 / IU-262.10315.125 | 保留历史合同；本卡已由用户明确改用2026.2.3，不回写其他卡 |
| 安装及运行进程 | 本轮只读 `C:/Software/ideaIU-2026.2.3.win/product-info.json`：IU、2026.2.3、262.10968.63；idea64 PID 24408、主窗口title `demo-sms` | 安装身份与本卡已确认目标一致；不授权操作用户工程 |
| 2026-09-24 环境 | [ED-PARITY-004](ed-parity-004-reference.md)：Windows、深色New UI、Windows keymap、1870×982；上一卡的用户裁决仅针对004 | 能作为核对入口，不继承其操作时段，不反向修改其记录；字体/有效缩放和当前项目SDK仍需本场景核对 |
| JDT LS安装 | 本轮只读 `%LOCALAPPDATA%/jdtls/plugins/org.eclipse.jdt.ls.core_1.61.0.202607142124.jar` 存在 | 不是已启动版本证明；P2记录实际命令、core hash、Java运行版本及workspace generation |
| 外部库缓存 | `%USERPROFILE%/.m2/repository/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar` 存在 | 不是IDEA/JDT LS已导入证明；记录实际classpath及jar hash后才ready |
| F2-NAV-001 | [001参照](ed-parity-001-reference.md)，Linux导航两类工程 | 不含本卡类型import或snippet，不能扩张为Completion参照 |

本轮用户已明确答复“采用已安装的2026.2.3”“现在可独占10分钟”。目标只影响本卡；上述时段已结束。下表中的原F2目标及上一卡环境为历史来源，不覆盖本轮裁决。

## 2. 既有忽略目录工件的只读核对

发现 `qa-ui-auto-report/idea-reference/ed-parity-005/20260925/` 已有同日08:16–08:42（本机文件时间）采样脚本、maven副本与图片；这些不是本轮生成。工作区没有同卡设计/owner变动，未发现运行中的同卡采样脚本；不能据此推断其历史授权或把残件owner/状态复制到卡。

实际查看原件 `25-completion-popup.png`：图像方向异常，画面为带裸prefix和语法标记的编辑器，**没有可见候选弹层**。文件名不能证明弹层已采。
实际查看 `21-project-structure.png`：图像方向异常，显示Project Structure/SDK选择；只能说明残件中的设置画面，不能证明当前项目classpath、index或import已ready。

两图均没有配套的完整manifest/操作日志/accept后文本/Undo字节；不作为R1–R4有效目标。保留原图不旋转覆盖，不修改脚本或副本，不从capture脚本注释推断执行成功。获取：在原采样宿主读取上述忽略路径，跨机器需原件及独立身份清单；路径存在不代表任何新采样PASS。

<a id="fixture"></a>

## 3. F2-COMP-005 精确重建规格（IDEA局部实采，Taomni未执行）

这是catalog F2的本卡缩小变体。IDEA与Taomni分别复制到未来报告根 `qa-ui-auto-report/ed-parity-005/fixtures/idea/` 和 `.../taomni/`，另建B workspace同字节副本；不修改已有seed或用户demo-sms工程。

全部文件 UTF-8无BOM、LF、块末一LF。每次P2创建时记录每文件SHA-256与artifact manifest；哈希必须从真实生成字节计算。P1后来按此字节创建了隔离IDEA工程，并附加.idea/misc.xml、modules.xml及parity005.iml显式绑定zulu-22和本地commons-lang3 jar；未执行Maven导入。初始源码/pom与下文一致，方法轮实际缩进变体以原件为准。不借旧seed中 `if(false)` 内裸token“可编译”注释作为事实——不可达块仍须满足Java语法。

`pom.xml`：

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>parity005</groupId>
  <artifactId>completion</artifactId>
  <version>1.0</version>
  <properties>
    <maven.compiler.source>21</maven.compiler.source>
    <maven.compiler.target>21</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-lang3</artifactId>
      <version>3.12.0</version>
    </dependency>
  </dependencies>
</project>
```

`src/main/java/parity005/Main.java`：

```java
package parity005;

public class Main {
    void sample() {
        Object typeProbe = null;
        new StringBuilder().append("seed");
    }
}
```

B0工程导入时保持上述完整语法；不执行Maven build。确认Project SDK支持source21、IDEA Java插件与index/import ready、JDT LS运行JDK满足其实际版本要求（不把IDE自带JBR当Project SDK）。只在工作缓冲操作下面前缀，语法暂缺是本次输入步骤，不是import失败fixture。

- **类型接受前image T0**：只将 `Object typeProbe = null;` 改为 `Object typeProbe = StringUti;`，caret在`StringUti`后、`;`前，selection空；显式Basic。目标选择带完整包名 `org.apache.commons.lang3.StringUtils` 的类型。排除JDK内部同名项，不能选第一行猜来源。
- **类型接受目标 T1**：primary变成 `Object typeProbe = StringUtils;`，单一 `import org.apache.commons.lang3.StringUtils;`；这是补全事务fixture，类型名作为表达式不要求编译成功。记录真实provider额外空行/插入range，IDEA完整postimage已由原件锁定；P2仍须以真实provider报文及文本核对A1；一次Undo恢复精确T0，不回退此前人为prefix编辑。
- **snippet接受前image N0**：独立还原B0，再将 `append("seed")` 整段替换为 `appen`，caret在prefix后、`;`前。选择 `StringBuilder.append(String str)` 相应真实item，记录raw参数名、insertTextFormat、完整snippet与placeholder。**IDEA接受为append()、caret在括号内；用户已决定Taomni保留provider原始snippet**。目标candidate固定append(String str)，协议展开预期及provider不支持时的验收上限见第二时段合同，不得静默删snippet AC。
- 每轮Esc/Undo后比较全文和caret/selection；native显式Save再读host bytes，不能用截图证明磁盘。IDEA自动保存与Taomni显式Save分别记录，不强行相等。

### B-005：browser可控provider响应（不是IDEA参照）

基础 `Main.java` 与B0相同，provider只在fixture绑定root中工作。浏览器accept精确输入B1：

```java
package parity005;

public class Main {
    void sample() {
        Stri;
    }
}
```

主range为0-based LSP `(4,8)..(4,12)`，即`Stri`；候选 label `StringBuilder`，kind 7，raw identity固定 `parity005-combined-1`；primary newText为 `StringBuilder(${1:"x"}, ${2:1})$0`、insertTextFormat=2；additional edit在 `(1,0)..(1,0)` 插入 `import java.lang.StringBuilder;\n`。这个显式java.lang import和构造参数仅用于原子事务/位移测试，不声称可编译Java或真实JDT LS答复。

完整B2：

```java
package parity005;
import java.lang.StringBuilder;

public class Main {
    void sample() {
        StringBuilder("x", 1);
    }
}
```

首选区为引号内外完整 `"x"`（LSP snippet占位定义），第二为 `1`，最终caret在`)`之后、`;`之前。prefix+import单dispatch；立即Undo全文回B1、selection回prefix末端。追加两个不同raw identity/label的候选用于上下/鼠标选择，P2在fixture中固定排序和精确postimage，不按运行输出倒填期望。

故障配置：同raw item初始无additionalTextEdits，resolve按case返回上述完整item/null/error/timeout/held；invalid分别给primary越界或additional覆盖primary。恢复重新返回完整item。fixture阶段门控是测试设施，必须覆盖真实renderer请求/返回路径，不能直调commit。nativefault proxy使用同协议模式但独立标注受控provider，不冒充真实JDT LS。

<a id="capture-gaps"></a>

## 4. 采样覆盖与后续复现步骤

G1：**已解除**，本卡目标IU-262.10968.63；不重写P0/其他卡原版本。
G2：**P1目标已解除**。第二时段补齐必要导航/词中接受/mouse/字体/缩放及窄窗屏幕边缘参照，snippet差异已获用户裁决。表中步骤保留为P2双侧比较runbook；未采的重复/极端布局不得算当前PASS，但期望已由实采与可用性合同明确，不再要求P2决定产品目标。原始部分采样记录保持原日期与局限。

取得本轮时段后：先只读确认未锁屏、目标进程/build、foreground HWND/title与焦点；不要自动解锁。新建本卡隔离工程窗口，不在demo-sms输入或替换个人config；打开Project SDK/import信息，确认commons-lang3实际classpath及index ready。核对/复用有效Windows keymap/深色设置；在About及Editor Font/zoom记录实际值，无需用户填写参数表。UI路径读不到时标具体缺项，不用配置文件推断有效字体。

| 状态 | 实际操作和记录 | 对应AC/V |
|---|---|---|
| R0-ready | 打开B0，记录project SDK/language21、Java插件、library、import/index就绪及editor全图，caret/selection/dirty | A1/A2 V5/V6 |
| R1-list | T0，Ctrl+Space；记录完整相关候选集合、包名/kind与默认选中，重复一次记录变化；拍全图及crop（crop另标） | A1/A2 V1/V6 |
| R2-selected-doc | Up/Down选StringUtils、打开/等待doc，滚动与鼠标回选；记录focus、list/docs矩形、label/detail完整性 | A2 V2/V6 |
| R3-accepted | 重置T0分别Enter/Tab/鼠标接受；保存真实全文、import range、caret/selection；N0选固定append重载，记录N1全文及各Tab/ShiftTab/$0状态 | A1/A2/A3 V2/V5/V6 |
| R4-undo | 每种接受立即Undo、Redo、Undo；另轮纯snippet导航后Undo；导出每步完整文本，区分IDEA自动save | A3 V2/V5/V6 |
| R5-cancel | 重置T0，打开popup→Esc→重开；记录零提交及焦点；不把Taomni fault gate硬套IDEA | A2/A3 V3/V6 |
| R6-edge | 窄窗及caret右/底部，打开list/docs，滚动与接受/取消；记录实际翻转、overflow、行高与颜色角色 | A2 V2/V6 |

正常/取消/Undo各重置复跑一轮确认。新原件目录用 `qa-ui-auto-report/idea-reference/ed-parity-005/<new-run>/`，不要覆盖今早目录；保存manifest（时间、工具、build/profile/fixture/hash、steps、焦点、结果与局限），把目标差异逐项写回设计。采样结束还原本次fixture、关闭本次窗口并归还桌面，不清用户缓存、不关闭用户项目。

词中Enter/Tab结论已实采；未观察的完整候选集或其他布局不签匹配；P2待实现设施与P1待定目标分开。这个文件是准确补采runbook，不是双侧comparison record，也不证明Taomni已对齐。
