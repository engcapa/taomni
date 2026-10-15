# 终端全缓冲区文本镜像优化：独立性能 feat

日期：2026-10-15。设计状态：**实现及本地单元测试完成；browser/native用例已写但未执行，真实打包和性能未验收**。用户本轮要求仅做本地单元测试。实际基线/日志/缺项见[交付记录](terminal-buffer-text-performance/delivery.md)，开发任务见[任务清单](terminal-buffer-text-performance/development-tasks.md)，验收细节见[测试设计](#test-cases)。

## 1. 目标、来源和范围

生产版终端在定时、渲染及输出回调中反复遍历整个活动缓冲区，生成字符串并写入供自动化读取的DOM属性。缓冲区越大、终端越多，重复工作越多。本feat通过编译期隔离，消除生产构建的这条自动全量文本生成路径，保留开发/QA自动化及用户主动读取终端内容的能力。

用户明确要求将此优化独立于GC crash恢复管理。来源仅是[崩溃诊断中的源码线索](../docs-issue/webview-renderer-crash-recovery-design.md#31-发布版中的全量终端文本镜像)；**没有证据证明这些字符串分配导致了JSC原生堆损坏**。本feat独立实现、测试、发布、回退，不依赖renderer恢复，也不以自然GC crash消失作为完成条件。

调研基线：HEAD `a11c227c`，产品版本0.4.38；对应发布标签v0.4.38中也确认存在该镜像行为。当前未提交内容仅为本轮及前轮设计文档。部署目标为Linux/WebKitGTK、macOS/WKWebView、Windows/WebView2；当前环境为Linux Mint22.3/Ubuntu noble、X11。本轮只有源码/文档审计。

范围限于编译开关、TerminalPanel镜像调用点和相关测试。保持终端输入/输出、ready、startup/CWD集成、渲染器、按需复制/导出/AI读取、分离交接的现有语义；**本feat没有500行限制**，500行只属于另一份崩溃恢复设计。正常scrollback默认10000、配置最大200000的行为不变。

不引入新依赖、用户设置页、后端IPC、缓存副本、Worker、终端序列化、GC/JIT设置或自动化新协议。此处是内部性能路径调整，没有新的UI流程，因此不需要界面原型。

## 2. 已核实的调用与消费者

行号为调研基线定位辅助，实施时以符号为准。

| 位置 | 当前事实 | 设计含义 |
|---|---|---|
| `src/components/terminal/TerminalPanel.tsx:2733`，syncAutomationState | 先处理延迟CWD安装，随后getBufferText写data-terminal-text，再更新data-terminal-ready | 不能删除整个函数或把整个函数放入QA开关；业务顺序须保留 |
| 同文件约2757/2758/2761/2852行 | 初始调用、每500ms、onRender、输出xterm.write完成后均触发；startup/settling分支也调用 | 即使没有主动复制文本，仍有重复全缓冲扫描。已挂载的隐藏终端定时器也没有visible守卫 |
| 同文件约4445行，getBufferText | 遍历active buffer全部行，translateToString(true)，合并软换行，删除末尾空行，再join | 成本随缓冲数据增长；不是只读当前视口。重复字符串分配是源码事实，实际CPU/GC占比待测 |
| 同文件约4693行，terminalAtIdlePrompt | 读取光标所在逻辑行（可跨软换行），识别提示符；alternate buffer不算idle | 不等于全历史扫描，但也不能称为绝对O(1)。本次不改变其算法或调用时机 |
| 同文件约3108行，snapshotPromptBuffer；startup/CWD分支 | 启动命令结束和隐藏集成安装有独立状态/时序判断 | 不合并这些检查、取消500ms业务轮询或提前ready来追求更多性能收益 |
| 同文件约1323/1520行 | copyAll、saveBufferToFile按用户操作读取全文 | 保留完整内容与现有文本格式，不能改为只复制可见区/500行 |
| 同文件约717/3023行；`src/layouts/MainLayout.tsx:1355` | collectReattachState、断开时分离状态回调、分离窗口交接读取文本 | 事件驱动的必要快照，保持行为，不受镜像开关控制 |
| 同文件约3862行；`src/lib/terminal/terminalRegistry.ts` | 注册getBufferText/getLastLines供消费者按需读取，Map不参与每块输出React更新 | 保留API、注册/注销及返回语义；不能改成读取可能不存在的DOM属性 |
| `src/components/chat/ChatDrawer.tsx:502` | @terminal上下文使用getLastLines | AI读取现有按需能力继续有效，不为镜像维护第二个文本缓存 |
| `src/lib/terminalProfile.ts:57/169` | scrollback默认10000，允许100至200000 | 默认、大缓冲和多终端均纳入测量，不通过降低历史上限实现优化 |
| `vite.config.ts:21`、`src/vite-env.d.ts`、`vitest.config.ts` | 已使用编译期常量隔离QA能力；Vite与Vitest分别配置 | 沿用惯例增加一个常量，不使用运行时URL/DOM/localStorage开关 |

自动镜像当前还承担以下测试契约；这些消费者读取canvas渲染无法直接提供的文本：

| 消费者 | 使用方式 | 本次处理 |
|---|---|---|
| `.agents/skills/qa-ui-auto/scripts/tauri_webdriver.py:1257` | text()优先读取data-terminal-text | QA原生构建继续提供该属性；无需改driver协议 |
| `qa_ui_auto/steps/assertions.py:93/130`、`steps/keyboard.py:136` | assert_text/assert_pattern、terminal_input验证使用该属性 | 默认开发服务器和QA构建保留，不删断言 |
| TC-022（F4.4） | 直接用属性选择器和eval_readonly统计宏输出次数 | 原case无需迁移到新接口 |
| TC-143（F3.1/F4.2/F4.7/F2.2） | 直接assert_attribute验证read-only没有写入命令 | 原case保持 |
| TC-144（F3.1/F2.2/F4.7） | 属性包含SSH disconnected后执行重连 | 失败提示也必须继续更新QA镜像 |
| `TerminalPanel.test.tsx:424` | 当前合并测试“mirrors rendered terminal text and idle-prompt readiness” | 拆分镜像与ready断言，分别覆盖生产关闭/QA开启；保留其验证意图 |

默认browser CI在`ci_execute.py`通过`pnpm dev`启动，没有自动指定`--mode qa`。因此只使用`mode === "qa"`会破坏现有browser测试；设计显式覆盖开发服务器。

## 3. 推荐实现

### 3.1 编译期模式契约

已实现常量名：`__TAOMNI_TERMINAL_TEXT_MIRROR__`。名称不带QA，是因为开发服务器也启用。常量在编译时注入，普通release没有动态打开入口。

Vite配置函数读取`command/mode/isPreview`，取值规则为：`mode === "qa" || (command === "serve" && !isPreview)`。此规则只是设计表达，实施沿当前Vite类型写法。不要用“非production模式均开启”或仅依赖`NODE_ENV`，避免自定义release mode误开启。

| 执行环境 | 值 | 行为 |
|---|---|---|
| 普通`pnpm build`、`pnpm tauri build` | false | 无自动全缓冲文本镜像，所有正常终端业务继续 |
| build使用非qa自定义mode，包括development | false | 编译产物默认走生产优化路径 |
| `vite build --mode qa`，现有QA native overlay | true | 保留现有镜像更新与DOM属性契约 |
| `pnpm dev`、`pnpm tauri dev`的Vite服务器 | true | 保留现有browser/native开发调试与自动化能力 |
| `vite preview` | 以已经构建的产物为准 | preview不重新打开已编译掉的镜像；配置本身不以serve误判启用 |
| Vitest默认mode | false | 主组件测试覆盖生产行为 |
| 本feat的Vitest `--mode qa` | true | 同一实现覆盖镜像契约；其他已有QA常量保持其现有测试配置 |

需要修改`vite.config.ts`、`src/vite-env.d.ts`、`vitest.config.ts`。Vitest配置可改为按mode返回，使新常量在两次定向运行中分别为false/true；不要通过`vi.stubGlobal`试图改变已经编译成字面量的常量。

### 3.2 最小调用点调整

仅把`panel.setAttribute("data-terminal-text", getBufferText(term))`及其参数求值放入常量为true的分支。关键是**生产构建不调用getBufferText**；仅跳过setAttribute、降低写DOM频率或先计算字符串再判断都不满足目标。

保持前后的CWD安装、ready判断及顺序；保留原500ms定时器、onRender/output/startup回调和dispose逻辑。需要说明业务与QA混在一起时，加准确注释即可；不为本feat重排所有调用、重命名大批符号、提取庞大终端状态服务或改变setViewportVersion。

生产中正常挂载的panel不再维护data-terminal-text；不以空字符串代替，不维护shadow DOM、全量缓存或定时“补偿”读取。QA/开发中仍用同一个getBufferText及既有触发点，保留软换行合并、空行处理和失败提示更新。镜像开关只控制调试文本观察，不控制data-terminal-ready、连接状态、真实画面或终端注册。

### 3.3 按需全文读取保持

copyAll、saveBufferToFile、窗口分离/归位、终端断开状态通知、TerminalRegistry全文/尾部读取继续从xterm读取。UI有明确请求时的全量开销仍存在，这是本次保留能力；验收“零自动镜像扫描”不等于整个应用永远不扫描缓冲区。

不改变getBufferText/getLastBufferLines实现或返回类型，不新增IPC/存储格式。全屏TUI、Unicode/ANSI、IME、输出日志、搜索与WebGL由原路径处理。尤其不把异常恢复方案的检查点、尾部缓存或500行预算带入本feat。

## 4. 决策与验收

| DEC | 结论与理由 | 状态/来源 |
|---|---|---|
| DEC-01 | 作为独立性能feat，单独交付与回退；GC恢复无前置依赖 | 用户明确要求 |
| DEC-02 | 保持正常业务、历史容量、三端兼容，改动尽量局部，性能不可退化 | 沿用用户已确定的性能与小范围原则 |
| DEC-03 | 编译期关闭生产镜像，QA/开发保留原协议；暂不实现按需QA新API或增量镜像 | agent自决：直接属性选择器/eval消费者较多，模式隔离改动最少且无需迁移它们 |
| DEC-04 | 常量只包住文本生成和属性写入，业务timer/ready/CWD不改 | agent自决：调用链包含真实startup/CWD依赖，减少相邻回归 |
| DEC-05 | 不宣称降低某一固定比例CPU/内存或修复GC crash；独立基线/候选配对测量 | 证据约束；没有当前性能数据 |

没有新的UI或组件选型取舍需要用户答复。下列为不变的验收要求；当前实现与本地测试状态见交付记录，不能由单元通过推导原生或性能通过。

| AC | 场景与结果 |
|---|---|
| AC-01 | 生产构建、无用户主动读取/生命周期快照时，定时/onRender/output/startup观察路径不生成全缓冲文本，不写data-terminal-text；稳定大历史不导致此观察路径周期遍历全历史 |
| AC-02 | 默认开发服务器与QA构建继续更新完整data-terminal-text，已有assert_text、terminal_input、直接属性选择器/eval仍观察到真实输出、断开及重试提示 |
| AC-03 | 两种构建中ready、慢启动、MOTD/空屏、半输入命令、startup一次执行及CWD安装/settling顺序保持；alternate buffer不误判idle |
| AC-04 | 复制全文、保存到文件、分离/归位、断开交接、Registry/AI按需读取保持内容与生命周期；超过500行的既有内容不被截断 |
| AC-05 | 相同源码基线仅加入本feat后，生产输入/帧/吞吐无可重复退化；长历史自动文本扫描消失，并报告CPU/分配变化及实际测量分辨率，不编造速度收益 |
| AC-06 | mode/command矩阵正确，生产与QA打包可区分；三端使用同一前端策略，无新平台API/依赖/最低版本要求；缺少实测的平台标未验证 |
| AC-07 | 正常创建、隐藏/切回、StrictMode开发挂载、断开重连、dispose保持，不多建会话/订阅/timer，不因优化关闭后台 |

## 5. 性能测量：独立两组对照

基线P0=实施本feat之前的固定源码；候选P1=P0仅加本feat。GC恢复变更不混入P1，或两组都处于完全相同的恢复功能状态。两项功能日后同时发布时可补集成测量，但不能相互抵消性能退化。

QA/development镜像仍开启，因此它们的耗时**不能证明生产优化收益**。性能组必须是普通production前端加真实release Rust flags。现有`native_build.py --release`强制debug_assertions且其QA overlay构建`--mode qa`，只用于功能测试；不能直接用于本feat的优化结论。

| 负载 | 操作、指标及边界 |
|---|---|
| 1/4/16个终端，1000/10000行已填充历史 | 固定80×24及160×50；停止输出后测60秒，再持续输出60秒。记录renderer CPU、帧/事件循环停顿、字符串分配及RSS；确认定时路径没有全历史读取 |
| 1/4终端，大历史压力 | 200000是配置上限，不要求16个全满；先验证硬件容量，再填到约定实际行数，记录填充数/bytes。测试隐藏但已挂载panel与可见panel |
| 交互与混合输出 | 一个前台交互终端、其他终端输出；测输入反馈p50/p95/p99、吞吐与帧分布。原生PTY完成计数与画面标记联合判断，不能只测invoke返回或PTY生产速度 |
| TUI/ANSI/软换行/Unicode | 固定交互记录或可控程序，无损输出；用户复制/导出时允许一次按需读取，分别记录该动作耗时，不能与自动镜像计数混淆 |
| 稳态与释放 | 关闭/重开固定数量终端，观察资源回收；无需renderer故障注入或96小时GC复现。仅观察到异常增长时增加较长采样 |

每组同机、同引擎、同渲染器、相同scrollback、相同输入字节流，固定预热后至少5轮交错运行，报告原始数据和配对差值/波动。不同平台单独得出结论。自动全文观察调用应为0；ready对光标逻辑行的读取仍允许，不能误判为优化失败或把它算成全文。

性能验收不设置“允许退化2%”之类额度。发现可重复的输入/吞吐/帧下降则定位；样本不足标未验证。CPU或RSS没有显著变化不等于功能失败，但只能报告已消除冗余路径及测量范围，不能声称未证实的收益。

分析器观测与正式时序测量分开：带CPU/分配分析器的匹配样本验证机制，无分析器的匹配样本验证交互。WebView不提供某种分配/GC计数时记录缺项，不能用RSS差值直接推导分配次数或GC次数。输入到画面采用可用的原生/外部采样；若只能测keydown到渲染回调，准确标成该区间，不冒充OS到显示器延迟。

## 6. 测试设计

<a id="test-cases"></a>

V-01/02及V-04的本地单元部分已通过，V-03的配置函数矩阵已通过；
所有browser/native、实际构建及V-06仍未执行。按用户本轮要求已补充
[可执行TC-TERM-TEXT-001与完整browser/native手工用例](../qa-ui-auto-tests/native/runbooks/terminal-buffer-text-performance.md)，并同步covers/CI policy/dependencies；保留既有case、控件及QA协议，不新增大套件或生产观察接口。

### V-01：生产关闭镜像、业务仍可用（AC-01/03/07）

落点：现有`src/components/terminal/TerminalPanel.test.tsx`新增定向场景，Vitest默认mode常量false。先在P0保留能暴露额外扫描的失败依据，再验证P1。

前置：mock有正常非折行提示符的10000行buffer，早期历史行各带读取记录，PTY已连接；不调用copy/export/分离/Registry全文。依次触发一次onRender、一次真实输出回调中的xterm.write完成、推进500ms timer。断言早期历史未被观察路径读取、data-terminal-text不存在；提示符ready按实际安装/settling状态更新、输出继续写入。不要禁止所有getLine，因为ready应读光标行。

继续沿现有测试验证迟到prompt、startup一次写入后CWD安装、alternate buffer及StrictMode；调用unmount后原timer和listener正常释放。仅断言“if条件为false”或函数调用次数不足以证明业务保留。

### V-02：QA及开发文本观察不变（AC-02/03/06）

同一组件文件以Vitest `--mode qa`运行，常量true。保留原镜像测试含义：多行、软换行、Unicode、末尾空行、空buffer、失败/断开文案在既有触发点更新；ready与文本独立断言。测试文件可按编译常量选择该模式专属场景，报告实际执行数，不把未选择场景当通过。

默认`pnpm dev`跑TC-022的直接属性/eval路径，TC-143/TC-144可在同一选定构建批次复用，验证没有误关开发镜像。QA原生构建保留同属性；不修改driver为读空字符串，也不降低原断言。

### V-03：构建模式与产物（AC-01/02/06）

构建普通production与qa两种前端，校验新define值及产物的镜像调用分支。`getBufferText`因为复制/导出仍应存在，不能以整个函数是否被tree-shake作为通过条件；也不能只搜索源码常量声明。验证普通build与自定义非qa build为false，默认dev与qa为true，preview沿已构建产物。

前端browser构建可能使用Tauri stubs，只证明模式/调用点，不能替代原生结果。最终原生P1必须记录production前端与release flags；常规QA二进制另记录mode=qa，不能混用。

### V-04：按需消费者与正常生命周期（AC-03/04/07）

用超过500行且含唯一首/尾标记、软换行和Unicode的测试输出：主动复制全文，核对剪贴板内容；Save to file核对文件首/尾；通过Registry读取全文/尾部，核对条数及内容；分离再归位核对原session/PID及显示内容；关闭分离终端时按现有契约处理。此处只验证原有分离能力，不要求完整VT状态恢复。

优先扩充现有TerminalPanel/terminalRegistry定向测试，接着在production模式隔离native上做一次含剪贴板/文件/窗口的操作批次。不能全部只在mirror=true的QA构建中测；选择有意义的已有用例，缺少原生自动化的步骤按本段手工记录。AI文本读取验证Registry/ChatDrawer数据即可，无需发送真实AI请求。

### V-05：原生ready与自动化消费者（AC-02/03/06/07）

选用已有TC-005本地终端、TC-006 Quick SSH、TC-119保存startup、TC-143显示/只读、TC-144断开重连；按当前YAML modes运行，不把TC-022的browser结果称为native。可控SSH fixture需明确opt-in及独立凭据；不使用用户当前shell/SSH做探针。检查真实输出、startup标记恰好一次、CWD正确、断开后新输入可用。

QA二进制覆盖其自动化契约；production原生另做本地shell和受授权SSH的ready/startup/CWD定向复核，可手工或使用已有生产兼容观测方式，不能因为DOM文本属性关闭就判定正常终端无输出。

### V-06：三端生产性能（AC-05/06）

执行§5。Linux测本机WebKitGTK/X11，按可用环境补Wayland兼容；macOS测WKWebView，Intel/ARM分别报告；Windows测现有x64产物/WebView2，保留cmd/PowerShell正常输入。无OS API变更，不为本feat引入新平台实现或提高构建目标（现有ES2020/Safari16保持）。

应用使用隔离QA身份加production前端的独立测试配置，或独立OS测试用户；核对实际app-data/凭据/目录。不要直接套用会强制qa前端的现有overlay做性能构建；不要伪造QA provenance文件让runner接受不匹配产物。生产等同release无法使用debug-only路径覆盖时使用独立OS用户；Windows不能仅设置APPDATA假定隔离。

报告每端二进制hash、frontend mode/镜像常量、Rust flags、系统/引擎/架构、负载、原始性能和未覆盖项。当前设计阶段三端均未验证；后续当前端完成可交付该轮结果，但不能据此声称三端性能已通过。

### 可用命令与检查边界

后续实现后，在仓库根目录运行：

```bash
pnpm exec vitest run src/components/terminal/TerminalPanel.test.tsx src/lib/terminal/terminalRegistry.test.ts
pnpm exec vitest run src/components/terminal/TerminalPanel.test.tsx --mode qa
pnpm build
pnpm build --mode qa
```

两种前端build会覆盖dist，需记录产物身份并在实际原生构建前核对模式，不拿最后一次QA dist冒充生产产物。只在稳定输入上按配置各构建一次，原生build已完成同一frontend检查时复用日志。纯前端变更不要求全量Rust测试或cargo fmt；原生功能/性能测量仍因真实PTY/WebView/OS边界而需要。

已有QA case可用`PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode browser --filter TC-022 --require-pass`；执行前核对本checkout的Vite、有效SSH配置与授权。native按实际case modes及隔离配置运行；长构建/服务用现有background_job工具，不在当前用户实例上操作。

## 7. 任务与验收追踪

详细职责、依赖和完成条件见[开发任务](terminal-buffer-text-performance/development-tasks.md)。独立命名空间为TERM-TEXT-PERF；以下TASK编号属于本feat，不与GC设计同号任务混用。

| AC | 方案 | TASK | V |
|---|---|---|---|
| AC-01 | 编译模式与调用点 | TASK-01/02/03 | V-01/03 |
| AC-02 | 开发/QA兼容 | TASK-01/02/03 | V-02/05 |
| AC-03 | 保留业务时序 | TASK-01/02/03 | V-01/02/04/05 |
| AC-04 | 按需消费者 | TASK-01/02/03 | V-04 |
| AC-05 | 独立生产对照 | TASK-01/04 | V-06 |
| AC-06 | 模式矩阵、三端 | TASK-02/03/04 | V-02/03/05/06 |
| AC-07 | 原生命周期 | TASK-01/02/03 | V-01/04/05 |

## 8. 发布与边界

可使用独立PR主题`feat(terminal): isolate automatic buffer text mirroring from production`。发布说明描述消除生产自动文本镜像的冗余工作，附实际测得收益；不写“修复JSC GC crash”。无数据迁移或新配置；回退仅撤回本feat代码与测试适配，不修改另一份恢复机制。

GC恢复原TASK-07仅保留“已移交”记录和本设计链接，不再作为其前置、性能基线或必做工作。GC恢复以实施恢复前/后的固定基线比较；两组文本镜像优化状态相同即可，执行顺序无依赖。

剩余局限：QA/development为了兼容原协议仍存在镜像开销；用户主动复制大历史等操作仍可能耗时；其他输出日志/搜索/渲染分配不在此feat内。发现独立热点只记证据，不扩张当前改动。所有性能数字和测试通过状态须在后续执行后回填。
