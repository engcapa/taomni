# ED-PARITY-007 IDEA 参照与 fixture

Reference ID：`REF-PARITY-007-LINUX-20260927`；状态 **partially-observed**。版本要求（用户 2026-09-27 修订）：IntelliJ IDEA Ultimate **2026 年任一发行版（2026.x）** 即可，不限定具体 build；本轮实采于本机 **2026.2.2 / IU-262.10315.125**。补采可用任一 2026.x，须记录实际 build 并分别存档；只对本卡生效，不回写其他卡。本文件是 P1 参照与补采 runbook，不是双侧 comparison record，不证明 Taomni 已对齐。

关联：[唯一板](../backlog.md) / [设计与测试用例](../extract-method-plan.md#test-cases) / [fixture catalog F2](fixture-catalog.md#f2)。

<a id="environment"></a>

## 1. 环境与时段

| 项 | 实际值 / 来源 |
|---|---|
| 安装 | 只读 `/data-raw-hdd/dev/idea-IU-253.30387.90/product-info.json`：2026.2.2 / 262.10315.125 / IU（目录名为旧数字，不据此推版本）；`bin/idea.sh <fixture>` 启动新实例 PID 2955819，启动前无其他 IDEA 进程 |
| 平台 | Ubuntu 24.04 / Cinnamon / X11 `:0`，屏幕 1920×1080；项目窗口客户区 (260,58,1400,1000)（Xlib translate/geometry） |
| 设置 | 用户配置 `IntelliJIdea2026.2`，未改任何设置：无 `keymap.xml` 覆盖 → 默认 keymap；`editor.xml` 无 in-place 覆盖 → 默认“在编辑器中”执行重构；editor-font.xml 为 Source Code Pro 16。主题/UI 缩放本轮未重读，沿用 [Linux Shell 参照](shell-layout-2026.2.2-linux.md)记录，只作核对入口，不签像素匹配 |
| 项目 SDK | `.idea/misc.xml` 指定 `zulu-21` → `/data/dev/jdk-21`，languageLevel JDK_21；显式 `.iml` module，无 Maven 导入 |
| 时段 | 用户授权 15 分钟（2026-09-27 约 11:43 +08:00 起）。首次输入 11:48:36（Trust Project），最后输入 11:55:08，实例退出 11:56:46；桌面已归还 |
| 输入工具 | 系统 `/usr/bin/python3` + python-xlib/XTEST + PIL（`cap.py`，每次输入前校验前台窗口标题含 `extract007`；无标题的 Trust/Exit 对话框用 `pidclick.py` 按 PID 校验）。ASCII 合成事件，不是物理键盘/IME |
| 清理 | 只关闭本轮窗口并在 Confirm Exit 选 Exit；fixture 为 `/tmp/taomni-idea-ref-007/extract007` 一次性副本，结束时处于未完成的 record 模板状态，未恢复，直接废弃 |

原件根：`qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-1143/`（不入库）。`manifest.json`（SHA-256 `98b0218f76960d81982f2530939c7b8714f329d6abeceb02bea7f471fccb5ace`）含 47 个原件 hash、身份与局限；`steps.jsonl` 为逐步 UTC、输入与前台标题；`*.hashes.txt` 为独立读盘。跨机器需取原包，摘要不能替代截图。

<a id="fixture"></a>

## 2. F2-EXTRACT-007 fixture

单个 Java 源文件，UTF-8 无 BOM、LF；生成器 `make_fixture.py`（原件根内）。IDEA 侧用显式 module（`extract007.iml`、`.idea/modules.xml`、`.idea/misc.xml`）；Taomni 侧由 P2 复制 in-repo `maven-single` 后**新增**同字节 `src/main/java/demo/ExtractTarget.java`（或按 maven 包路径放置，包名保持 `demo`），项目元文件不同，只比较该 Java 文件字节与行为。

`ExtractTarget.java` 初值 SHA-256 `3ffe60d1ca2f4973d8bd3e95575ea61aa483f1e299d9b31a67b41454e60d8c37`：

```java
package demo;

public class ExtractTarget {
    int total(int[] values) {
        int sum = 0;
        for (int v : values) {
            sum += v;
        }
        return sum * 2;
    }

    String range(int[] values) {
        int min = Integer.MAX_VALUE;
        int max = Integer.MIN_VALUE;
        for (int v : values) {
            min = Math.min(min, v);
            max = Math.max(max, v);
        }
        return min + ".." + max;
    }
}
```

- **E1 单输出（受支持）**：选中第 5–8 行整行（`int sum = 0;` 到 for 的 `}`，行首起，末尾含换行）。
- **E2 多输出（能力边界）**：选中第 13–18 行（`min`/`max` 声明与 for 循环）；循环后 `min`、`max` 都被读取。
- IDEA 结果字节（E1 命名 `sumOf` 并保存）：SHA-256 `20eeb0ca7c1b2e5d9c9bd45115a0079cb90000eea3fa299f1fca141538608383`，全文见原件 `05-after-enter-save.java`。行为不变：`total(new int[]{1,2,3}) == 12`。

<a id="observed"></a>

## 3. 实采状态（R1–R10）

| 状态 | 原件 | 真实观察 | 设计用途 / 边界 |
|---|---|---|---|
| R1 选区 | `02-selection-total` | 编辑器点第 5 行，Home、Shift+Down×4 选中 5–8 行 | 初态；`01-*` 为焦点未进入编辑器的诊断图，不作参照 |
| R2 Ctrl+Alt+M | `03-after-ctrl-alt-m` | **无候选选择器、无对话框**，直接提取：调用处变为 `int sum = getSum(values);`，原 `return sum * 2;` 保留；新方法 `private static int getSum(int[] values) { … return sum; }` 插在 `total` 之后并以绿色高亮；调用处名称处于就地模板（框选 + 齿轮图标），下方名称建议列表 `getSum` / `getInt`，底部提示 `Press Alt+Shift+O to show options popup` | DEC-02 直达、DEC-03 命名；IDEA 默认名来自启发式，Taomni 默认名由 provider 决定，不要求同名 |
| R3 输入名 | `04-typing-name` | 键入 `sumOf` 时调用处与声明处同步改名 | DEC-03：Taomni 用既有 Rename 路径同步两处 |
| R4 Enter | `05-after-enter`、`05-after-enter-save.*` | 模板结束，caret 回到调用语句行首（5:9），声明 `private static int sumOf(int[] values)` 显示 `1 usage`；Ctrl+S 后磁盘即为 IDEA 结果字节 | 最终程序结构；这里只证明 Ctrl+S 后的磁盘结果；没有测出自动保存时机，不能断言保存前永不落盘 |
| R5 一次撤销 | `06-after-undo1`、`07-after-undo2*` | 一次 Ctrl+Z 同时撤销提取与改名，画面与 R1 完全相同（图像 hash 相同 `925922d6…`）；第二次 Ctrl+Z 只改变选区/caret；`07` 时磁盘仍为已保存的提取后字节 | DEC-04：IDEA 为单步撤销，Taomni 两个历史项为用户已接受差异（当前 DEC-04）；本行历史观察不改 |
| R6 Esc（名称列表可见） | `08-esc-in-template` | 第一次 Esc 只关闭名称建议列表，模板仍在（`getSum` 框选），提取保留 | 只观察首次 Esc，不能推断不存在完整取消。Taomni 命名框 Esc 保留默认名为已接受产品决定，完整 Esc 语义比较保持 unverified |
| R7 模板中 Ctrl+Z | `09`、`12-undo-after-esc` | 模板仍活动时 Ctrl+Z 只让名称重新全选，未撤销提取 | Taomni 模态命名框不存在此状态，不比较 |
| R8 模板中再调用 | `10-multi-output` | 模板未结束时对另一选区按 Ctrl+Alt+M，红色气泡 `Extract Method is not finished yet.`，无新改动 | DEC-02 重入保护：Taomni 命名框打开时 Ctrl+Alt+M 被弹窗吞掉，不产生第二次提取 |
| R9 Enter 默认名 + 撤销 | `13-enter-default-name`、`14-undo-default` | Enter 接受 `getSum`；一次 Ctrl+Z 回到与 `07` 相同画面（图像 hash 相同 `c286aed4…`） | 默认名路径同样单步撤销 |
| R10 多输出 | `15-multi-output`、`16`、`17` | 选中 13–18 行 Ctrl+Alt+M **不是拒绝**：提示 `There are several output variables in the selected code block. The method can be extracted if we fold them into a new record.`，并先生成 `Result result = new Result(min, max);`、`return result.min() + ".." + result.max();` 与 `private record Result(int min, int max) {}`，名称 `Result` 处于模板；Esc 只关提示，Ctrl+Z 未退出模板；未继续到方法提取 | DEC-06：Taomni/JDT LS 无 record 折叠能力，记能力差距，不在本卡实现 |

<a id="capture-gaps"></a>

## 4. 未采状态与补采 runbook

未采：编辑器右键 Refactor 子菜单与 Refactor This（Ctrl+Alt+Shift+T）列表、Alt+Enter 是否列出 Extract Method、浮动工具栏、Alt+Shift+O 选项弹窗、重复片段替换提示、R10 完成后的方法签名、真正无法提取的选区（跨语句一半）文案、窄窗/缩放、Windows/macOS。设计对这些按 Taomni 现有契约或明确假设给出期望（见设计 DEC-02/06），不声称与 IDEA 相同。P2 若补采，新目录 `qa-ui-auto-report/idea-reference/ed-parity-007/<new-run>/`，不覆盖本轮原件：

1. 取得新的有效时段；只读确认未锁屏、前台窗口与 build；不自动解锁。
2. `/usr/bin/python3 make_fixture.py <new-root>` 重建 F2-EXTRACT-007，`bin/idea.sh <new-root>` 打开新实例，Trust Project（不勾选 parent）。
3. 选中 E1，右键编辑器，展开 Refactor 子菜单截图；Esc。按 Ctrl+Alt+Shift+T 截图列表；Esc。按 Alt+Enter 截图；Esc。
4. 选中第 6 行一半到第 7 行一半，Ctrl+Alt+M，记录拒绝文案（C1）。
5. 结束只关闭本轮窗口，写 manifest。

## 5. 本次静态修订与补充参照

2026-09-27 在 cc 分支原位完善设计，本次没有新桌面输入。Linux 原包 manifest SHA 与本文件记录一致，47 个列出工件 hash 已在本次复核；hash 一致只证明工件完整，不认证所有解释。R4 的保存时机、R6 的完整取消结论已收窄为实际观察边界，R5 的待决标签同步为已有用户决定。采样记录/manifest 原件不改写。

[Windows 历史补充与 E3 副作用 fixture](ed-parity-007-windows-reference.md)来自 astra 的 c017800d，原包当前缺失，明确 reference-unavailable；它提供取消层级的历史线索及可重建 13:1 输入，不与 Linux 观测合并。E1/E2 仍采用本页同字节 fixture；E3 在另一隔离 root 执行，所有 Taomni/JDT 产品结果仍 unrun。

补采完整取消时：新授权时段内 fresh E1→Ctrl+Alt+M→首次 Esc→确认建议列表与模板状态→焦点保持模板名称→再次 Esc，逐步保存原图/selection/文本；分别再走更多选项 Cancel（若在本次比较目标内）。不能将先切到另一选区/发生重入错误后的 Esc 当同一序列。保存前、等待自动保存后、显式保存后分别读盘，才可讨论保存时机；无这些观察保持 unverified。
