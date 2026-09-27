# ED-PARITY-007 Extract Method 参照与补采合同

Reference ID：`REF-PARITY-007-WIN-20260927`。当前状态：**partial-observed（IDEA 主链已实采；剩余状态见 R7/G1）**。关联[设计](../java-extract-method-plan.md#ed-parity-007)、[用例设计与缺口](../java-extract-method-plan.md#test-cases)、[唯一任务板](../backlog.md)。Taomni/browser/native/provider 验证均未执行；没有双侧 matched 主张。

历史：2026-09-27 补采前本包为 not-observed、无桌面时段。随后用户明确“沿用本机 IDEA Ultimate 2026.2.2，可独占桌面 10 分钟补采”；本次采样为 **11:33:41–11:42:16 +08:00**（8 分 35 秒），结束后已归还桌面，时段不续期。以下 observations 只属于此次采样，不改写旧 PASS 或旧卡状态。

2026-09-27 后续用户指示将目标放宽为 **IDEA 2026 系列**，不限制 patch/build。上文及下表的 2026.2.2 / IU-262.10315.125 是已发生采样的身份，不能改标为另一版本；后续使用任一适用 2026.x，记录实际版本/edition/build 与差异，仅补受影响状态。此项不改变已结束的桌面时段或尚待决定的 DEC-02。

<a id="environment"></a>

## 1. 环境与复用判断

| 项目 | 本次事实 | 证据边界 |
|---|---|---|
| IDEA | Ultimate 2026.2.2 / **IU-262.10315.125**；`D:/Software/idea-2026.2.2.win/bin/idea64.exe` | 安装信息与本次 GUI About 一致；原始 About 含授权个人信息，仅本地保留，不转录或发布其个人字段 |
| 平台/窗口 | Windows；PID 29264；隔离 HWND 2297880；屏幕 1920×1080；外框 `(260,20,1660,1012)`，1400×992；client 1384×984；DPI 96 | 每步 JSON 记录前台窗口；截图含外框，不能把外框当 client；原用户窗口 HWND 3736344 未关闭 |
| 外观 | Dark New UI，英文菜单；配置 scheme `_@user_Dark`，DefaultFont Microsoft YaHei UI 18.0、secondary Microsoft YaHei | 字体来自现有 editor-font.xml，不冒充每个控件实测；UI zoom、有效 lineHeight、是否存在项目级字体覆盖未测，不主张逐像素 matched |
| Keymap | 菜单显示、实际按键均为 `Ctrl+Alt+M`；第二次在 inline 状态按同键进入 More options | keymap.xml 不存在不足以断言 keymap 名；Shift+F10 实际触发 Run，因此不将它当 context-menu 证据；右键菜单另有有效记录 |
| 工程/JDK | F2-EXTRACT-007，模块 source root 与 JDK21；`C:/Program Files/Java/jdk-21`；IDEA Run `13:1`、exit 0 | 未执行 Maven import；Load Maven Project 提示仍可见，不把模块识别/Run 称为 Maven 导入成功 |
| 本机 provider | `C:/Users/zhyha/AppData/Local/jdtls/plugins/org.eclipse.jdt.ls.core_1.61.0.202607142124.jar` | 静态身份；未启动/探测 JDT LS，不证明 Taomni 当前选择它 |
| provider SHA-256 | `6d5a198c3778b77052ec9eae9fce3a5136711da6b9b16234cf97023389a0a2f7` | 不继承历史另一 timestamp build 的结果 |
| 清理 | 11:42:16 +08:00 保存回 B0，仅关闭本轮隔离 project，IsWindow(2297880)=0 | 见 cleanup.json；未自动解锁、未修改全局 settings；任何后续桌面输入须有新的时段 |

本机不存在旧 005/006 的 `C:/Software/ideaIU-2026.2.3.win` 安装及其原件，因此未复用其 build/profile。早先曾误称本机版本为 2026.2.3，已依据实际安装更正；用户现已明确本卡沿用 2026.2.2。

[Rename 旧参照](refactor-rename-idea-2026.2.2.md)仅提供另一动作的历史合同，不能证明 Extract。旧 `ED-REF-001` 2026-09-15 Linux 记录不转为本卡的 PASS。IDEA Run 是本次参照操作，不是 Taomni 产品构建/测试。

<a id="fixture"></a>

## 2. F2-EXTRACT-007：确定的输入与程序语义

IDEA 参照隔离副本已准备于 `qa-ui-auto-report/idea-reference/ed-parity-007/fixture/parity007-extract/`；本轮已在 IDEA 打开、提取并 Run，最终恢复 B0 后关闭。生成器 `qa-ui-auto-report/idea-reference/ed-parity-007/prepare_reference.py`、`fixture-manifest.json` 均为被忽略的参考工件，**不是可执行产品测试**。P2 的 browser/native fixture 仍待实现。

源文件 `src/main/java/parity007/ExtractSample.java`，UTF-8 无 BOM、LF、结尾一个 LF：

```java
package parity007;

public class ExtractSample {
    private static int calls;

    public static int run(int base) {
        int doubled = next(base);
        int total = doubled + 3;
        return total;
    }

    private static int next(int value) {
        calls++;
        return value * 2;
    }

    public static void main(String[] args) {
        System.out.println(run(5) + ":" + calls);
    }
}
```

源文件 SHA-256：`dcaf699d054aea32dd252b6d6bd168d1809d0ca29cd3d0663639e812aa2b990e`。选区是第 7 行第 9 列至第 8 行分号之后；LSP UTF-16 零基 range `[6:8, 7:32)`。精确选中文字：`int doubled = next(base);\n        int total = doubled + 3;`；不得把末尾 `return total;` 选入。初态 clean、一个 editor view、无 Git、无外部依赖。

Maven 元数据（仅给 JDT LS 识别项目；本轮未执行 Maven）：

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>parity007</groupId><artifactId>extract-sample</artifactId><version>1.0</version>
  <properties><maven.compiler.release>21</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
</project>
```

`pom.xml` SHA-256：`997ee2470ecf6eb8e08aa801a1ad2d7f81a44d4c671d181e9d8c6d2dec01a342`。IDEA 隔离副本自带 module/source root/JDK 21 元数据，不改用户全局 SDK；若实采导入 Maven，须记录最终 import 状态，不能把静态 module 识别写成 Maven 导入成功。

确定的语义 oracle：新方法接收 `base`、返回选区算得的 `total`；调用点仍提供外层 `return total` 所需的值；`next(base)` 只调用一次；新进程输出应为 `13:1` 加平台行尾，其他成员无语义改动。IDEA 实际 Run 已输出 `13:1`、exit 0（R5）；Taomni/JDT LS 的产品验证未执行。IDEA 精确 post-image 见下节；provider 可使用不同格式/修饰符，但必须保留该语义，差异逐项记录。不能把 IDEA 生成字节伪装成 JDT LS 实际返回。

负向变体由每例独立复制：

- `empty-selection`：产品负例候选是 6:8 caret；IDEA 实采另在第 8 行末尾折叠选区，成功推断当前语句（R7）。两者不是相同位置，不能据此断言无选区一律拒绝；首包正例仍限定明确选区，推断能力是否纳入由 DEC-02 范围决定。
- `broken-selection`：截断第 7 行语句，或跨越 `run`/`next` 方法边界；拒绝时原文/磁盘/历史不变。
- `dirty`：打开后在文件末尾实际输入 `// pending\n`；取消保留这段未保存输入；是否允许提取 dirty 由最终 UI 合同确定，目前禁止偷偷保存以规避冲突。
- `stale`：请求挂起时编辑、切文件/工作区、关闭源 view 或重启 provider；旧响应不能应用到新上下文。
- `external-conflict`：预览后外部在文件末尾追加 `// external\n`；不得覆盖这份磁盘变化。
- 编码/平台回归：主例 LF；P2 可用同文本的 CRLF、Unicode/空格目录复验原生 preimage/replay，不能覆盖主例 hash。

<a id="provider-source"></a>

## 3. Provider 依据：可用实现与尚未证明的运行条件

2026-09-27 读取 Eclipse JDT LS `v1.61.0`：

- [RefactorProposalUtility.java](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.61.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/text/correction/RefactorProposalUtility.java)，`getExtractMethodProposal`：检查选区/initial conditions；生成唯一默认方法名；非 advanced 分支返回 `RefactoringCorrectionProposalCore`（edit）；advanced 分支返回 `java.action.applyRefactoring` / `extractMethod`。
- [GetRefactorEditHandler.java](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.61.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/GetRefactorEditHandler.java)，`getEditsForRefactor`：`extractMethod` 使用 range/SelectionInfo 计算重构；本次所读分支没有任意 `methodName` 输入字段。不能假造参数或把 client command 直接当 server command 执行。完成 edit 后，该 handler 还可能返回 `java.action.rename` 和 `{uri, offset, length}`；这是新文本中的重命名位置，并非提交前 methodName 参数，也不是把两个普通历史操作拼成一次提取的现成合同。

原始下载只存 `qa-ui-auto-report/idea-reference/ed-parity-007/source/`。本机 jar 的 `RefactorProposalUtility.class` 确认含 `getExtractMethodProposal`、`extractMethod`、`java.action.applyRefactoring`、`refactor.extract.function` 常量；tag 源码与本机 timestamp build 未证明逐字同源。

生产 `src-tauri/src/lsp.rs::lsp_initialization_options` 的 extended capabilities 只开启 `classFileContentsSupport`，未开启 advanced extract。所以首选调查现有 codeAction/resolve 的 **纯 WorkspaceEdit 路径**，不要先新增另一套语义引擎。实际动作 kind、edit、disabledReason、默认名、返回值、延迟和错误仍须后续真实 provider 记录；本轮权限不允许运行 provider fixture/产品测试。

历史 [JDT LS codeAction ADR](../../../claudedocs/adr-jdtls-code-action-unsupported.md)记录 2026-08-27 特定环境 provider hang；保留其失败，不推广为所有 1.61 均不支持，也不以本次源码阅读宣告它已修复。

<a id="capture-steps"></a>

## 4. 实采状态、原始工件与准确限制

原包：[run-20260927-113341 manifest](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/manifest.json)、[cleanup](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/cleanup.json)。工件不入库；每个动作的同名 `.json` 保存输入、UTC 时间、前后台 HWND/title、DPI，`.png` 保存当时外框截图。跨机器接手需要复制原包并校验 manifest，缺文件只能标 reference-unavailable。

| 状态 | 实际操作、可观察结果 | 原件（均在上述 run 下）/ AC |
|---|---|---|
| R0 环境 | GUI About 确認 2026.2.2 / IU-262.10315.125；JDK21 Run 证实此 fixture 可运行 | 53-about.png（本地含个人字段，不发布）；cleanup.json；A2 |
| R1 选区/入口 | 准确选择 `[6:8,7:32)`；Ctrl+Alt+M 进入 inline。编辑器右键→Refactor→Extract Method… 同样进入 inline，菜单项启用并显示快捷键 | [05-selection](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/05-selection.png)、[06-extract](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/06-extract.png)、[42-refactor-menu](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/42-refactor-menu.png)、43-menu-extract.png；A1/A2 |
| R2 内联命名 | 第一次立即临时显示调用与新方法，默认 `getTotal` 选中，建议 `getTotal/getInt`，新方法区域绿色；输入 `calculateTotal` 联动调用及声明；Enter 确认，回调用行 caret 7:9，不再选择名称 | 06-extract.png、14-extract.png、[15-name](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/15-name.png)、16-accept.png；A1/A2 |
| R2 更多选项 | inline 中 Alt+Shift+O 出现小菜单 More options Ctrl+Alt+M；再次 Ctrl+Alt+M 打开 Extract Method dialog。private/int/Name；Declare static 勾选且禁用；Parameters 为勾选的 int base；Signature Preview `private static int getTotal(int base)`；Refactor/Cancel | 07-options.png、[08-more](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/08-more.png)；dialog 外框 802×840；A1/A2 |
| R2 非法名 | Name 输入 `1bad`，Refactor 禁用；Enter 保留 dialog/输入，没有提交 | 09-invalid.png、[10-invalid-enter](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/10-invalid-enter.png)；A1/A3 |
| R2 同签名冲突 | Name=`next` 后 Enter 弹 Conflicts Detected，1 conflicts；Open in Find Window / Refactor Anyway / Cancel；Esc 返回 Extract dialog，再 Esc 取消提取 | 34-existing.png、[35-existing-submit](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/35-existing-submit.png)、36-conflict-cancel.png、37-dialog-cancel.png；**没有执行 Refactor Anyway**，不推断其后果；A1/A3 |
| R3 取消 | 更多选项 dialog 中 Esc 整体回原两条语句/原 selection；inline 首次 Esc 只关闭 suggestions，第二次 Esc 才回原文/selection；菜单入口亦双 Esc 回原文 | 11-cancel.png、12-cancel-save.png/12-cancel.java；28-extract.png、29-inline-cancel.png、30-inline-cancel2.png、31-inline-cancel.java；44/45-menu-cancel*.png；A3 |
| R4 预览 | 本次 UI **无独立文件变更 Preview 按钮**；inline 直接展示临时结果，More options 只有 Signature Preview。不能套用 Rename 的文件树预览作为 IDEA Extract 已观察状态 | 06/08；A2、DEC-02 的关键差异 |
| R5 应用/运行 | inline 输入 calculateTotal→Enter→Ctrl+S。精确 post 见下节；Ctrl+Shift+F10 由 IDEA Run，stdout `13:1`、Process finished with exit code 0 | [17-save](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/17-save.png)、[17-post.java](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/17-post.java)、[23-run-result](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/23-run-result.png)；A1/A2 |
| R6 撤销/重做 | 编辑器一次 Ctrl+Z 还原整体原文与两行 selection；未出现确认弹层；Ctrl+S 后 hash=B0。Ctrl+Shift+Z 恢复完整 post，保存后 hash=post；之后再次 Undo+Save 回 B0 | [18-undo](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/18-undo.png)、19-undo.java、20-redo.png、21-redo.java、26-reset-save.png；A3 |
| R7 空选区 | 在原两行 selection 按 Right，caret 折叠到第 8 行末尾；Ctrl+Alt+M 推断当前 `int total = doubled + 3;`，提取为 getTotal(doubled)，并非拒绝；双 Esc 后 Save 回 B0 | [46-empty](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/46-empty.png)、[47-empty-extract](../../../qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/47-empty-extract.png)、50-final.java；A1/A2 |
| R7 未采部分 | 不完整/跨方法 selection；命名输入内 Ctrl+Z；Tab/Shift+Tab 整轮焦点；Cancel 按钮鼠标路径；长路径/窄窗的 overflow；More options 参数/返回类型可编辑操作 | **unobserved**，不能从控件存在或正常路径推出结果；精确后续步骤见 G1 |
| R8 归还 | final.java=B0，只关闭 disposable project；原用户工程保持打开 | cleanup.json，采样结束 11:42:16 +08:00 |

`00-open.png` 包含当时其他桌面内容，**不作为有效目标窗口参照**。`40-context.png` 对应 Shift+F10 触发 Run，**不作为右键菜单证据**；有效菜单由 41/42/43 另证。没有录屏，截图不证明中间每个瞬时状态。

<a id="post-image"></a>

## 5. IDEA 原始生成字节与磁盘观察

`17-post.java` / `21-redo.java` SHA-256 均为 **`4d57af6f57979f0aa58c1b64774909e1d0781eeaab95cef4684fbbab2b2ba805`**：

```java
package parity007;

public class ExtractSample {
    private static int calls;

    public static int run(int base) {
        final var total = calculateTotal(base);
        return total;
    }

    private static int calculateTotal(final int base) {
        int doubled = next(base);
        int total = doubled + 3;
        return total;
    }

    private static int next(int value) {
        calls++;
        return value * 2;
    }

    public static void main(String[] args) {
        System.out.println(run(5) + ":" + calls);
    }
}
```

`06-disk.java`（inline 尚未确认时抽样）、`12-cancel.java`、`19-undo.java`、`31-inline-cancel.java`、`50-final.java` 均为 B0 hash。`06-disk` 为 B0 只证明该抽样点，不能据此宣称 IDEA 永不自动保存临时编辑；应用/撤销后的 hash 在显式 Ctrl+S 后采集，不能证明 Ctrl+S 前磁盘何时变化。保存、dirty 与 Taomni clean-buffer 自动保存需 V6/V7 分别比较。

<a id="gaps"></a>

## 6. 当前设计决定与补采缺口

- **BL-01 已解除**：用户明确沿用 2026.2.2 并授予本次时段，主链采样结束且归还。没有后续时段，不再输入。
- **BL-02 主链事实已补齐，目标取舍待 DEC-02**：真实 IDEA 是 inline 命名/临时结果及 signature dialog，当前 Taomni 是 provider 默认名加 canonical 文件 diff preview。A/B [对照图](../java-extract-method-options.png)及[可编辑源](../java-extract-method-options.drawio)只用于讨论，尚非接受差异。不能将选择 A 默认为同意。
- **BL-03 语义适配/范围**：默认 edit 路径没有自定义 methodName 输入；advanced `java.action.rename` 需要新文本中的语义位置。若保留 inline，P1 必须明确 transient document/session、didChange/rename、取消还原、一次历史和保存隔离的可行合同；超出首包则交 P0 增量核定，不由 P2 猜、不以正则/两次普通历史偷换。
- **G1 补采（选择 inline 目标时影响 A1/A2/A3、V1/V2/V6）**：在新的明确时段重建 B0，同样范围进入 inline→输入 calculateTotal→Ctrl+Z 记录局部撤销→Tab/Shift+Tab/Enter/Esc 的焦点；新一轮用鼠标点击 More options 的 Cancel，记录文本/selection/hash；非法/跨方法范围按快捷键观察准确反馈后取消。参数 checkbox、type 下拉、行移动各实际操作并取消，除非 P0 已明确不含可配置参数则只记录差异。保持 1384×984 client 作基线，再较窄窗口检查溢出。每步记录 PID/HWND/焦点/新时段；hash 回 B0 后归还。尚未获得新时段，不执行。
- **G2 精细视觉比较**：UI zoom、有效 lineHeight/project font override 未实测。对照不得给 pixel matched；P2 如需严格几何结论应在新时段确认这些影响像素的参数。不能把配置文件当 GUI 行高观测。

设计仍 `deferred / planning_required=true`，已知缺口从“未获授权/无参照”更新为“实际目标取舍与语义事务设计”。产品验证未执行，P2 不可立即领取。没有改选其他卡或新建替代板。
