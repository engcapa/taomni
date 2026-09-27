# ED-PARITY-007：Windows 历史补充参照与副作用 fixture

来源：`docs/code-workspace-idea-parity-ed007-astra-high-P1@c017800d` 中 `references/ed-parity-007-reference.md`。2026-09-27 用户要求在 cc 方案中吸收有效材料；本文件保留可重建输入、历史观察边界和测试用途。当前有效方案仍是[cc 设计](../extract-method-plan.md#ed-parity-007)的弹框命名、两步撤销，不采用该分支的待决 A/B 方案或单次事务目标。

**当前原件不可用**：Windows 原包 `qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/` 不在本次 Linux 工作区。本轮没有复核其 117 个工件，也没有重新采样。以下观测是该提交记录的历史事实，不能记为本轮 PASS、Linux 已观察或双侧 matched；P2 如使用截图比较，必须先转移原包并核 manifest/hash/窗口身份，缺文件记 reference-unavailable。Linux 主参照仍为 [REF-PARITY-007-LINUX-20260927](ed-parity-007-reference.md#observed)。

## 历史身份与可复用观察

原记录身份：`REF-PARITY-007-WIN-20260927`，IDEA Ultimate 2026.2.2 / IU-262.10315.125，Windows、Dark New UI，client 1384×984、DPI 96、JDK21；采样 2026-09-27 11:33:41–11:42:16 +08:00，结束后恢复 B0、关闭隔离工程并归还桌面。UI zoom/有效行高未测，不主张像素匹配。About 截图含个人字段，仅本地保留，不发布。

| 历史状态 | 原记录结果 / 工件名 | 本次用途与限制 |
|---|---|---|
| inline 命名 | `06-extract.png` 默认 getTotal，`15-name.png` 输入 calculateTotal 同步声明与调用 | 解释命名目标；cc modal 属已接受差异 |
| 更多选项 / 非法名 / 冲突 | `08-more.png` 只有 Signature Preview，无独立 diff；`10-invalid-enter.png` 的 1bad 禁用提交；`35-existing-submit.png` 名称 next 产生冲突 | 转为语义拒绝、修正重试的目标用例；本包不开发更多选项界面，不把截图存在当控件操作通过 |
| Esc 层级 | inline 首次 Esc 关建议，第二次回原文/selection；更多选项 Esc 整体取消（`29-inline-cancel.png`、`30-inline-cancel2.png`、`11-cancel.png`） | 说明 Linux 仅采首次 Esc 不足以推出“不存在完整取消”；跨平台不同上下文不互相代证 |
| 应用 / Run | `17-post.java`；`23-run-result.png` 为 stdout 13:1、exit 0 | 设计 E3 oracle；P2 必须独立执行 Taomni 产物 |
| Undo / Redo | `19-undo.java`=B0，`21-redo.java`=post；显式 Ctrl+S 后核 hash | 保留历史单次撤销观察；当前产品目标仍两步，不移植历史结果 |
| 空选区 | 第 8 行末尾可推断当前语句，`47-empty-extract.png` | 空选区不能一概拒绝；JDT 是否返回候选仍待实测，精确位置不可混用 |

原记录 B0 hash 为 `dcaf699d054aea32dd252b6d6bd168d1809d0ca29cd3d0663639e812aa2b990e`，IDEA calculateTotal post hash 为 `4d57af6f57979f0aa58c1b64774909e1d0781eeaab95cef4684fbbab2b2ba805`；后者只是历史身份，不是 JDT LS golden。原件 `00-open.png` 含其他桌面内容、`40-context.png` 实为 Shift+F10 Run，均不得拿来比较。未采 input Ctrl+Z、Tab 环路、鼠标 Cancel、参数操作、窄窗等，不推导成功。

<a id="semantic-fixture"></a>

## E3 副作用验证输入：可重建，产品结果待执行

保留 F2-EXTRACT-007 主例 E1/E2 不变，E3 放**另一个隔离 Maven root**，包路径 `src/main/java/parity007/ExtractSample.java`。字节 UTF-8 无 BOM、LF、结尾一个 LF：

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

以上全文应得到上述 B0 hash。选区为第 7 行第 9 列到第 8 行分号后，LSP UTF-16 零基 `[6:8,7:32)`，精确文本 `int doubled = next(base);\n        int total = doubled + 3;`，不选入 return。Maven/JDK21 元数据由 P2 的 `parity007_extract` fixture 生成；不以 IDEA module 识别冒充 Maven 导入成功。

预期由输入程序确定：提取方法接收 base，提供原 return 所需 total；next(base) 恰调用一次；每个新 JVM stdout 为 `13:1` 加平台行尾、exit 0。初值/默认名提取后/改名后/Undo/Redo 均按[设计 V4](../extract-method-plan.md#provider-probe)独立编译运行，正常化换行后精确比较。保留 source hash、javac/java 命令参数、版本、stdout/stderr/exit；不能用 code pattern、零诊断或 browser stub 替代语义执行。

拒绝/恢复变体：截断语句、跨方法边界、dirty `// pending`、外部 `// external`，拒绝时保留对应输入；E3 不扩大为跨类提取、record 折叠或新语义引擎。CRLF/BOM 与 Unicode/空格路径沿共享 writer/history 保留测试，不更改主例 hash。
