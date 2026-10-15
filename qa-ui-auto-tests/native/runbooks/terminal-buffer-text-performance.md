# 终端全文镜像：browser/native 保留行为与生产性能用例

日期：2026-10-15。**所有本文 browser/native/构建/性能用例均未执行**。
本轮按用户要求仅执行本地单元测试；本文是后续执行规范，不是通过证据。
设计：[AC 与 V](../../../docs-feature/terminal-buffer-text-performance-design.md#test-cases)；
交付：[本轮记录](../../../docs-feature/terminal-buffer-text-performance/delivery.md)。

## 1. 适用层与隔离

- browser 自动用例：默认 `pnpm dev`，mirror=true；SSH 使用明确授权的可控
  POSIX fixture（UTF-8 locale、`printf`、正常提示符）。验证渲染器/属性/交互，
  不证明原生剪贴板、磁盘、进程或窗口。代理可用性须在执行前验证。
- QA native：独立 `com.taomni.app.qa` 身份、独立数据/配置/缓存、可丢弃会话；
  记录 frontend=qa、binary hash、Rust flags。验证原协议及真实 PTY/WebView。
- production native：普通 production frontend、mirror=false、真实 release flags，
  **独立 OS 测试账号**及可丢弃目录。核实 app-data/凭据隔离再启动。
  不操作用户当前 v0.4.38/白屏实例，不复用个人 shell/SSH，不重命名生产程序。
  `native_build.py --release` 仍是 QA 前端与 debug_assertions，不能代替性能构建。
- Linux/WebKitGTK、Windows x64/WebView2、macOS/WKWebView 各自记结果；
  macOS Intel/ARM 分开。Linux X11/Wayland分开；没有设备/分析器记 unrun/缺项。
- 所有凭据仅来自本地授权配置与环境，报告不保留真实会话/邮件/终端内容。
  结束后关闭自建终端、停止fixture、删除测试账号中的临时目录；不清除用户数据。

## 2. 固定功能数据

使用 TC-TERM-TEXT-001 step 11 的 POSIX 命令生成：
唯一首标记 `MIRROR-BEGIN-中文🙂`、620 条 `MIRROR-ROW-0000` 至 `0619`、
内部空行、`MIRROR-WRAP-` 加 120 个 0、ANSI 红色 Unicode 尾标记。
scrollback 至少10000，列宽固定80，再以160列复核；不改变产品默认值。
Shell echo、提示符、CWD 安装输出不是数据行，统计必须用锚定正则。

Windows本地 PowerShell（UTF-8控制台）等价生成：

```powershell
[Console]::WriteLine("MIRROR-BEGIN-中文🙂")
0..619 | ForEach-Object { [Console]::WriteLine(("MIRROR-ROW-{0:D4}" -f $_)) }
[Console]::WriteLine("")
[Console]::WriteLine("MIRROR-WRAP-" + ("0" * 120))
[Console]::WriteLine([char]27 + "[31mMIRROR-END-中文🙂" + [char]27 + "[0m")
```

Unicode/ANSI在PowerShell或cmd不支持时分别记录引擎/shell边界，不能删掉断言
写成通过；Windows cmd正常输入另以 `echo MIRROR-CMD-INPUT` 验证独立输出行。

## 3. browser 与 QA native 可执行用例

以下均**已存在或本轮已编写、未执行**。执行者只选择表中适用 mode；
每个报告须有 selected/pass/fail/skip、source/case/runner/build/config身份。

| ID / AC/V | Mode | 步骤及关键结果 | 依赖与边界 |
|---|---|---|---|
| TC-TERM-TEXT-001 / AC-02/03/04/06、V-02/05 | browser, native QA | Quick SSH认证→ready→固定620行→锚定首/尾/内部空行/软换行/Unicode→直接属性eval恰好620行→再次输入→新行存在且旧首标记恰好一次 | reset_db、ssh_required；验证完整镜像而非OS导出 |
| TC-022 / AC-02、V-02 | **仅browser** | 录制宏、停止、真实Ctrl+Space回放；直接属性/eval独立输出恰好1→2次 | 可控SSH；保持既有快捷键，不改为native通过 |
| TC-143 / AC-02/07、V-05 | browser, native QA | 打开显示/事件菜单；readonly输入不产生被禁命令；解除后正常输入，菜单状态准确 | SSH；沿原case断言，不放宽只读负例 |
| TC-144 / AC-02/03/07、V-05 | browser, native QA | 断开→观察SSH disconnected→Enter重连→再次输出；不向旧session写Enter | SSH；截图与文本分开审核 |
| TC-005 / AC-03/07、V-05 | **仅native QA** | welcome本地终端→真实键盘echo→独立结果行 | 本地进程/PTY，不能从browser stub推导 |
| TC-006 / AC-02/03、V-05 | browser, native QA | Quick SSH认证→真实ready→printf结果行 | SSH；认证cancel另见N-03 |
| TC-119 / AC-03、V-05 | **仅native QA** | 保存startup→打开保存会话→startup独立标记恰好一次→后续正常输入 | SSH；startup与CWD顺序深测见N-02 |

未来执行命令模板（**本轮未运行**）：

```bash
export PYTHONPATH=.agents/skills/qa-ui-auto/scripts
# <browser-config>须指向本checkout的默认dev服务器；SSH凭据经环境注入
python -m qa_ui_auto run --config <browser-config> --mode browser \
  --filter TC-TERM-TEXT-001 --require-pass
# <native-config>须匹配隔离QA构建，不能用生产身份伪造QA provenance
python -m qa_ui_auto run --config <native-config> --mode native \
  --filter TC-TERM-TEXT-001 --require-pass
```

保留case逐个按同一模板替换filter并遵循其modes；长构建/服务按skill的
background_job脱离启动，native顺序独占。新case的policy及dependencies已注册，
无新增fixture/verb/control；`verification`列明结果步号，静态审核不代表执行通过。

## 4. production / QA 原生手工用例

当前runner依赖QA文本属性，生产不维护该属性；以下明确为**手工native**，
不得通过修改driver、stub、额外镜像或伪造身份获得“通过”。
每条先在production执行，再在QA复核保留行为；对比中区分这两类构建。
所有可观察输出以真实画面、操作结果及只读Registry观察交叉核对。

### N-01：全文消费者与取消/连续操作（AC-01/04/07，V-01/04）

1. 以固定数据填充本地终端；滚回首行确认首标记可见、尾标记及输入光标正常，
   初次mounted空buffer不误报ready。空buffer Copy All显示`Nothing to copy`
   且不覆盖剪贴板；Save to file产生既有空文本下载，不伪造缓冲内容。
2. 只读检查pane：production无`data-terminal-text`，QA有完整文本；
   `data-terminal-ready`与真实提示符一致。观察属性不存在不等于真实画面为空。
3. 右键菜单 **Copy All**，从独立OS程序读取剪贴板：首尾、620条行、内部空行、
   合并长行、Unicode完整，无ANSI控制字节；与Registry全文逐字符比较
   （只允许导出端约定的换行标准化）。不能只比较substring。
4. 右键 **Save to file** 保存到测试目录，再在终端聚焦时按 **Ctrl+Shift+S**
   保存第二份。独立读两个文件，内容及编码正确；记录hash/行数/字节数；
   空字符串不是丢失内容的替代品。本实现用Blob/anchor下载，不新增保存对话框；
   平台若提供下载确认，取消后不产生新文件、不清历史，随后重试成功；
   无确认界面的平台明确记该分支不适用及实际下载行为。
   在外部可编辑输入框按相同快捷键，不误触终端导出。
5. 新输出后再次Copy All/导出，全文包含新增结果且旧首标记仍恰好一次。
   readonly不禁止复制/导出，断开后原内容仍可按需读取。
   在隔离账号拒绝一次剪贴板写入，检查失败反馈且缓冲不丢失，恢复权限后
   重试成功；导出以实际文件为准，状态提示不能替代磁盘成功证据。
6. 按需只读观察当前tab的Registry `getBufferText()`及`getLastLines(10)`：
   全文>500行，尾部符合现有物理行切片/软换行/末尾空行语义。
   本接口不会凭DOM文本读取；观察调用自身允许一次全文扫描。
7. 打开tab绑定Chat（`tab-chat-toggle`），选择`@terminal:last-10`，
   检查终端上下文预览与对应Registry尾部一致；**不发送真实AI请求**。
   关闭/重开tab后对应Registry项消失/重新注册，不残留旧tab内容。

剪贴板独立读取：Linux X11 `xclip -selection clipboard -o`（Wayland另用
`wl-paste`）、macOS `pbpaste`、Windows `Get-Clipboard -Raw`；
工具不可用时记缺项，不能用renderer返回值替代真实OS边界。

### N-02：ready/startup/CWD顺序（AC-03/07，V-01/05）

1. 可控测试shell分别呈现：初始空屏、持续MOTD、延迟idle prompt（>5秒）、
   半输入命令。期间ready不得提前true，startup/CWD安装不得写入MOTD/半输入。
2. 保存startup为输出唯一标记并sleep 2秒后返回的命令，打开SSH：
   提示符出现后startup恰好一次；运行中ready=false；结束后才安装CWD集成。
   记录实际stdin写入顺序/可控fixture日志，不仅统计属性或mock次数。
3. CWD初始为fixture工作目录，依次`cd`到A/B/A，目录栏及业务状态准确；
   原startup标记不重复。输出回调先于xterm提交提示符时，迟到prompt后
   500ms轮询仍能完成安装及settling，不以“立即ready”跳过过程。
4. 打开`vi`等alternate-buffer TUI，ready不得当成idle；正常输入、退出、
   ANSI颜色及Unicode保留；退出后正常ready及CWD继续更新。
5. Linux/macOS本地shell、授权POSIX SSH、Windows PowerShell/cmd分别记录。
   并非所有shell都支持同一CWD安装脚本；按该shell既有能力记录边界。

### N-03：失败/cancel/重连（AC-02/03/07，V-02/05）

1. 取消SSH认证：终端不创建有效session，不残留ready；重新连接可成功。
2. 可控fixture拒绝一次认证/连接，真实画面保留错误及retry文案；
   QA属性包含同文案，production仍无全文属性但画面可用。
3. 连接后令fixture正常exit：ready消失，断开交接快照保留>500行首尾；
   Enter重连失败时，不向旧session发送Enter、不重建xterm画面；
   恢复fixture后再次Enter连接成功，输入产生新的独立结果。
4. 关闭连接中的tab：迟到输出/连接完成不得注册已关闭tab或泄漏进程/订阅。
   连续重连两次，唯一startup每个新session执行一次而非每次render执行。

### N-04：分离/归位与生命周期（AC-04/07，V-04）

1. 固定数据终端记录tabId、backend sessionId和真实shell PID
   （POSIX `echo $$`，PowerShell `$PID`，cmd用OS进程树核实）。
2. 通过`terminal-detach`分离、`detached-reattach`归位；
   核对同session/PID、首尾、可继续输入、主/分离窗口各自状态及焦点。
   消费快照按需生成，不能依赖production不存在的文本属性。
3. 再分离并关闭分离窗口，核对现有关闭/保留契约及真实进程是否按约关闭；
   不要求额外完整VT恢复，不为本feat改变既有分离语义。
4. 切换隐藏已挂载终端后等待>1秒再切回：背景输出仍在、ready/CWD
   正常更新、不创建新session；关闭tab后无继续轮询/监听。
5. 默认dev的StrictMode打开SSH只创建一次session，不额外close；
   用单元测试支持开发重放，真实窗口/session边界仍须步骤1–4。

### N-05：正常scrollback/搜索/输入（AC-01/03/04/07，V-01/04）

1. 默认scrollback=10000输出12000行：保留最近10000条历史加视口的既有
   xterm语义；不出现本feat造成的500行截断。首标记若自然滚出上限不算bug。
2. 设置scrollback=200000，输出约定实际行数并记录容量；不擅自降上限。
3. Ctrl+Shift+F搜索保留范围内唯一标记，前后匹配/取消/关闭，选中Copy；
   不替换手动选择。调整列宽80→160→80，搜索坐标/软换行合并正确。
4. 输入Unicode/IME、粘贴、选择复制和TUI持续可用；搜索/主动全文操作允许
   读取历史，不能把这些调用计入“自动镜像扫描”。

## 5. 构建产物用例 C-01（AC-01/02/06，V-03）

**本轮只测配置函数单元矩阵，以下实际构建未执行。**

1. 分别构建production、qa及非qa自定义mode（development/staging），
   记录源码hash、完整构建命令、dist hash/保存路径，避免最后的QA dist覆盖
   production身份。普通及自定义build mirror=false，QA=true。
2. 默认dev镜像=true；production产物preview不重新打开镜像；
   QA产物preview仍保留已编译协议（serve配置不会重新编译现有bundle）。
3. 检查实际bundle镜像调用分支：生产已移除，QA仍有；
   getBufferText因主动消费者仍存在，不要求整个函数被tree-shake。
4. 在N-01/N-02复核真实release产物与QA产物，不把browser stub包称为Tauri包。
   保持ES2020/Safari16、原Rust配置、OS最低版本，无新增平台API。

## 6. PERF-01：配对生产测量（AC-05/06，V-06）

**待执行，没有P0/P1真实样本，不宣称收益或零退化。**

| 子用例 | 固定输入和操作 | 必须报告 |
|---|---|---|
| PERF-01a | 1/4/16终端，各1000/10000行，80×24和160×50；停输出60秒，再持续输出60秒 | 实际buffer行数/bytes、renderer/Rust CPU、RSS、吞吐、帧/停顿 |
| PERF-01b | 1/4终端，200000上限；依硬件约定实际填充数；同数量隐藏已挂载panel对照 | 不以默认10000冒充大历史；隐藏也不得周期全文扫描 |
| PERF-01c | 前台交互+其余后台输出，固定ASCII与Unicode输入和ANSI流 | 输入区间p50/p95/p99、帧/吞吐；结合PTY完成计数与画面，不能只测invoke |
| PERF-01d | 同一buffer主动Copy All/Save，软换行/Unicode/TUI；然后关闭/重开固定数量 | 主动动作耗时单列，不算自动镜像；释放后RSS/进程/订阅状态 |

测量配方：仅生成测试文本。固定ASCII行 `PERF-{i:08d}` 后补0至79列，
CRLF结束（每条81字节），固定80×24/160×50；填充后**实际**buffer行数
与wrap/视口结果必须记录。预热30秒，输出阶段固定每终端1000条/秒、
同样的批次大小100条和相同字节文件/hash；若平台无法维持速率，不临时
降低候选负载，只报告实际完成量并重新统一两组输入。
长历史填充与稳定采样分段，不把填充耗时算入空闲60秒。

P0为交付记录的固定源码，P1仅加入本feat（其他GC恢复功能状态相同）；
不回退当前工作树，通过隔离checkout/测试账号重建。至少5轮交错
P0/P1，再P1/P0，记录顺序及配对差值/波动。同OS/引擎/架构/渲染器、
scrollback、窗口尺寸、终端数、机器负载、字节流、预热一致。

机制样本用可用分析器定位自动全历史读取/分配：P1应无自动镜像扫描，
提示符逻辑行读取仍允许。正式交互样本不用分析器，记录测量区间；
没有OS→画面外部采样只能写keydown→render，不冒充显示器延迟。
WebView缺少GC/分配计数时写缺项，不从RSS推算。

按Linux/WebKitGTK、macOS Intel/ARM WKWebView、Windows x64/WebView2各自
保留binary hash、frontend mode、Rust flags、OS/引擎/架构、原始CSV与分析报告。
可重复输入/帧/吞吐退化不得验收；CPU/RSS无显著差异如实报告，
只允许结论“移除了冗余扫描路径”，不宣称固定百分比或修复GC crash。

## 7. 状态与证据模板

每条记录：`ID | AC/V | build/frontend mode | OS/engine/arch | steps/assertions |
selected/pass/fail/skip/unrun | actual source/case/config/runner/hash |
report path | visual verdict | native boundary | missing metrics/reason`。
原始数据放 `qa-ui-auto-report/terminal-buffer-text-performance/<platform>/<case>/`。
计划、静态schema/audit、截图存在均不是功能/视觉/native通过。
本文当前状态：browser=unrun、QA native=unrun、production native=unrun、
所有平台性能=unrun；执行责任为后续获得授权的验证执行者。
