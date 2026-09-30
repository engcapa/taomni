# 参照采集与参考包（DBeaver / DbVisualizer）

以用户可观察的客户端行为为参照。安装文件和源码只解释规则与目录，不代替实测。实测、安装文件依据、源码依据、推断和 Taomni 适配分开记录。

## 复用优先

先查 `docs-feature/db-client-parity/references/` 里是否已有同一客户端、版本、平台、引擎和场景的参考包（`DBR-*` 为 DBeaver，`DBVIS-*` 为 DbVisualizer）。有效参照可被多张卡引用，只补缺失或失效的状态。版本或关键偏好变化时新建修订，保留旧版。

## 三种依据，按成本从低到高

1. **安装文件（不需要桌面）**
   - DbVisualizer：`lib/dbvis.jar` 内的 `dbvis-actions.xml` 定义全部菜单、工具栏和右键菜单（`action-list` 引用 `action`），`resources/profiles/<db>.xml` 定义对象树节点与对象视图页签，`resources/keymaps/*.xml` 是非默认键位方案，`resources/templates/` 是编辑器模板。
   - DBeaver：安装目录的 `plugins/*/plugin.xml` 定义命令、菜单和键绑定。开源部分以 `dbeaver/dbeaver` 对应 tag 为准，PRO 专有插件只以安装文件为准。
   - 解析产物放 `qa-ui-auto-report/<client>-reference/_install/`。这类依据证明“存在该入口、它的名称和层级”，不证明行为、默认值或当前平台的快捷键。
2. **不抢焦点的窗口采集**：对已运行的实例，用 `ShowWindow(SW_SHOWNOACTIVATE)` 还原窗口、`PrintWindow(PW_RENDERFULLCONTENT)` 截图，再用 Windows OCR（`Windows.Media.Ocr`，先放大 2 倍）得到带坐标的文本布局。结束后把窗口恢复成原来的状态（如最小化）。能证明布局分区、页签/工具栏文字和状态栏字段，不能证明交互。
3. **交互实测**：用 `scripts/desktop_ui.ps1`（activate / shot+OCR / click / keys / paste）。已知坑：
   - SendKeys 在 Java/Swing 中会丢 `:` `/` `.` 和数字，文本一律走剪贴板粘贴，粘贴前后保存并恢复用户剪贴板；用剪贴板读回（Ctrl+A、Ctrl+C）来核对输入。
   - DbVisualizer 的连接编辑器是属性表格：先单击值列，按 F2 进入编辑，再粘贴，最后按 Enter。
   - 弹出菜单和对话框是独立的顶层窗口：用进程窗口枚举找到它的位置，再截对应区域。蓝底白字的默认按钮 OCR 读不到，用像素颜色定位。
   - 每次输入前都校验前台窗口属于目标进程；用户切走焦点时立即停止，不补发。
   - 本机 Read 工具看不到截图，布局判断只依据 OCR 文本和坐标。
   - 本机中文输入法处于中文模式：用 SendKeys 发送单个字母会弹出候选窗（这也是字符丢失的原因），发出后要用 Esc 关掉。字母文本也走粘贴，`keys` 只用于控制键和组合键。
   - 进程的 MainWindowHandle 可能指向工具提示小窗；脚本按“面积最大且有标题的窗口”选主窗口，守卫逻辑用 `-Action title` 读取标题。
   - 单元格里的真实值（OCR 读不准的数字、NULL 等）用“选中单元格 + Ctrl+C”经剪贴板读回。
   - 同一组场景在两款客户端上各跑一次，分别使用 `dbv_parity_*` / `dbr_parity_*` 前缀，结束时统一检查共享库里没有残留。

   交互实测的环境要求：DBeaver 用隔离工作区（`-data <临时工作区>`）。DbVisualizer 按用户授权使用常驻实例，但只能在新开的标签里操作（规则见 [fixtures](fixtures.md#客户端安装与启动)）。两者都只连 fixture 库。焦点漂移的步骤作废重采。

## 隐私与现场保护

- 用户实例中打开的 SQL、连接名、结果数据属于用户数据：原始截图和 OCR 只放 gitignored 的 `qa-ui-auto-report/`，入库摘要只写结构（区域、控件、字段名），不写内容。
- 不读取客户端的用户配置目录（如 `~/.dbvis`、DBeaver 工作区）中的连接、历史或凭据。
- 用户已有的标签（可能有未保存内容）里不输入、不保存、不关闭；输入前确认活动标签是本次新开的标签（例如用窗口标题判断）。未获用户授权的实例只做窗口采集。

## 采集步骤（交互实测）

1. 从卡的 AC 提炼必要场景：正常路径，加本场景相关的取消、错误、事务回滚、断线或撤销。
2. 核对实际版本与 edition（About 或安装元数据：DBeaver 看 `.eclipseproduct`，DbVisualizer 看窗口标题或 Help → About）。
3. 连 [fixtures](fixtures.md) 中的真实服务，只建本次前缀对象，用可重建脚本保存 schema 与种子数据。
4. 记录 OS、缩放/DPR、主题、字体、locale、keymap 与实际快捷键。
5. 每个有意义的状态都保存原图并对应到步骤；同时记录焦点、选区、结果、日志和错误文本，以及用另一连接查询得到的数据库后置状态。
6. 做同一场景的两侧对照时，两款客户端使用同一 fixture 和同一动作序列。

## 参考包内容

原始产物放 `qa-ui-auto-report/<client>-reference/<run>/`，摘要放 `docs-feature/db-client-parity/references/<ID>-<slug>.md`。

| 项 | 记录 |
|---|---|
| 身份 | reference ID、客户端/版本/edition/许可状态、OS、采集时间、依据类型（安装文件 / 窗口采集 / 交互实测） |
| 环境 | 窗口尺寸/缩放、主题、字体、locale、keymap、相关偏好 |
| fixture | 引擎与版本、驱动版本、连接方式、建库/种子脚本与 hash（交互实测时） |
| 步骤与状态 | step ID、动作/按键/菜单、观察结果、原图链接 |
| 视觉 / 交互 / 数据效果 | 布局与控件状态；焦点、确认、取消、回滚；执行的 SQL 与后置查询 |
| 边界 | 已观测 / 仅安装文件 / 未观测 / 污染作废 / 推断；可复用范围 |

参考包是开发输入，不代表 Taomni 已对齐。`reference-comparison` 证据需要同一 fixture 与动作下的双侧观察。
