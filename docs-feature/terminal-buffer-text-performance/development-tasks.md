# TERM-TEXT-PERF 开发任务

日期：2026-10-15。状态：**设计交接完成，4个开发任务均未开始**。唯一行为与验收规范为[独立设计](../terminal-buffer-text-performance-design.md)，完整用例见[测试设计](../terminal-buffer-text-performance-design.md#test-cases)。这些任务不依赖GC crash恢复，不触碰当前白屏实例。

目标：普通production构建停止自动全缓冲区文本镜像；开发/QA保留原观察协议；ready、CWD/startup、复制/导出/分离/AI按需读取和正常scrollback保持。预期产品修改集中在TerminalPanel和编译配置，不新增后端、任务系统、依赖或用户设置。

## 1. 任务顺序和职责

| TASK | 职责 | 依赖 | 状态 |
|---|---|---|---|
| TASK-01 | 冻结独立基线、保留契约和最小测量输入 | 无GC依赖 | 待开发 |
| TASK-02 | 编译模式常量、调用点隔离与定向测试 | TASK-01的基线和契约 | 待开发 |
| TASK-03 | QA/按需消费者/production行为及打包回归 | TASK-02稳定 | 待开发 |
| TASK-04 | 三端原生性能、证据与独立交付 | P0基线、TASK-02稳定；交付前合并TASK-03结果 | 待开发 |

按依赖顺序实施即可，不要求并行agent或任务板操作。TASK-02拥有公共产品/配置改动，其他任务提供测试/证据；对TerminalPanel.test.tsx的重叠编辑按顺序交接。保留用户和其他执行者的改动，不回退整个文件来制造基线。

## 2. TASK-01：独立基线与行为保护

输入：设计§2消费者、§5测量方法和V-01至06；当前TerminalPanel、Vite/Vitest配置、qa-ui-auto隔离约定。职责主要为只读检查与测试/测量设计，不先改生产行为。

步骤：

1. 固定P0源码、相关未提交变更、二进制hash、平台/引擎/架构、frontend mode/Rust flags。当前用户运行的v0.4.38不是允许用来修改或杀renderer的测试实例。
2. 核对全部getBufferText调用：自动镜像是目标；copyAll/saveBufferToFile/分离/断开回调/Registry是保留消费者。核对default dev仍是既有browser CI入口。
3. 选现有mounted测试中迟到prompt、startup/CWD、StrictMode、正常输入；保留改前结果。新“生产无镜像”断言在旧行为应失败，其他保留行为应通过；没有执行则标待执行。
4. 在隔离checkout/测试账号保留可重建P0，不改当前工作树到旧提交。定义固定字节流/行数/尺寸/终端数量、预热和采样边界，先收集至少一组真实production大历史空闲/输出基线，供TASK-04配对使用。
5. 明确功能QA与性能production两类产物。现有native_build.py --release使用qa前端和debug_assertions，不能当作P0/P1生产性能证据；使用独立OS测试用户或核实隔离的生产前端构建。

产物：基线清单、保留行为结果、负载配方和原始采样，放`qa-ui-auto-report/terminal-buffer-text-performance/`专题目录。不在文档或报告中保存真实终端/邮件/凭据内容，负载使用生成的测试文本。

完成条件：P0可重建、消费者范围清楚、测试/测量区间明确。对应AC-01/03/04/05/07，V-01/04/06。基线缺失不得写成“已有问题”或“零退化”。

## 3. TASK-02：最小实现和定向测试

负责产品文件：

- `vite.config.ts`：在现有define中增加`__TAOMNI_TERMINAL_TEXT_MIRROR__`，读取command/mode/isPreview；其余QA常量和构建target保持。
- `src/vite-env.d.ts`：声明新常量，说明production关闭、QA/开发开启。
- `vitest.config.ts`：默认false，定向`--mode qa`为true；不顺带开启其他QA探针。
- `src/components/terminal/TerminalPanel.tsx`：仅隔离自动getBufferText及data-terminal-text写入；保持原业务回调、500ms定时器和清理。
- `src/components/terminal/TerminalPanel.test.tsx`：分离镜像/ready测试，覆盖两种编译模式及生产不扫描历史；必要时补充按需消费者断言。

步骤：

1. 落实设计§3.1模式真值表。普通build及非qa自定义build为false，qa build和开发服务器为true；preview使用其原构建结果。
2. 把文本函数的参数求值也包进常量分支，保证false时不生成字符串。不能先getBufferText再丢弃，也不能仅把DOM值设为空。
3. 不删除syncAutomationState、不移动安装逻辑/ready、不缓存或合并terminalAtIdlePrompt检查，不调整输出/渲染订阅、不触碰xterm历史容量。
4. V-01使用真实组件路径的buffer mock：触发onRender、output/write完成、500ms推进，断言历史未被观察路径读取且ready/input仍正常。测试正常提示行可读，不写成所有getLine必须0。
5. V-02保留QA完整文本、soft-wrap/Unicode/空行/错误文案；同一测试文件分别在default与qa mode定向运行。原镜像断言不得删掉，只转到开启镜像的模式。
6. 保留已有迟到SSH提示符、startup、CWD及StrictMode回归；对真实状态和写入顺序作断言，不只断言新常量值或mock调用次数。

迭代命令（仓库根目录，具体新测试名实现后填写，稳定后运行相关完整文件）：

```bash
pnpm exec vitest run src/components/terminal/TerminalPanel.test.tsx
pnpm exec vitest run src/components/terminal/TerminalPanel.test.tsx --mode qa
pnpm exec vitest run src/lib/terminal/terminalRegistry.test.ts
```

完成条件：AC-01/02/03/04/06/07对应V-01/02/04通过；生产自动镜像扫描已从执行路径移除，所有按需读取未受开关影响。不得引入新缓存、runtime开关、IPC、Worker或QA协议重构。

## 4. TASK-03：消费者、构建与真实行为回归

主要责任是验证稳定实现，默认无需修改QA driver/YAML。若测试证明存在必须适配的契约，先定位原因；不能为通过测试把production镜像重新打开。

1. 检查production/qa构建及开发服务器的真实define/产物。验证的对象是镜像分支；getBufferText保留给业务调用，不要求整个函数从bundle消失。运行类型检查，复用相同输入的原生frontend build日志。
2. 默认`pnpm dev`执行TC-022直接属性/eval回归，按需要复用TC-143/TC-144文本断言。选择现有YAML支持的mode；TC-022目前仅browser，不能标native通过。
3. QA native用TC-005、受授权的TC-006/TC-119及代表性TC-143/TC-144覆盖现有观察契约，检查真实命令输出/次数/CWD；读取选中/通过/跳过计数。
4. 在mirror=false的production模式隔离native做V-04的复制全文、文件导出、Registry读取、分离归位。内容超过500行并含首尾标记；验证剪贴板、文件、原session/PID及内容，不能全部依赖data-terminal-text。
5. production模式再确认ready/startup/CWD和失败重连的正常业务；自动化属性不存在不等于真实屏幕为空。无法自动观测时使用设计中明确的手工步骤和结果，不伪造QA身份记录。
6. 本feat无新的用户工作流，复用保留case并在PR说明实现重构原因；若实际新增/改case，则同步covers、CI policy/dependencies，选中范围运行，不重生成全工程目录或扩成全套smoke。

完成条件：AC-02/03/04/06/07的V-02/03/04/05有明确边界与证据；production与QA都正常，case/控件无漂移。当前端完成，其他端未具备设备时列具体待验证项，不冒充三端通过。

## 5. TASK-04：生产性能与独立交付

输入：P0基线、仅含本feat的P1、TASK-03功能结果。对应AC-05/06，V-06；不运行GC故障注入、不把72/96小时自然崩溃窗口作为本优化前置。

1. 按设计§5运行1/4/16终端普通负载、1/4大历史压力、隐藏已挂载终端和前台输入混合输出。统一实际历史数、宽高、渲染器、字节流、预热与环境。
2. P0/P1至少5轮交错，分开有分析器的机制样本与无分析器的交互样本。记录renderer/Rust CPU、RSS、吞吐、输入区间、帧/停顿、可用的分配数据；分析器不可用不编造GC次数。
3. Linux/WebKitGTK、macOS/WKWebView、Windows/WebView2各自报告。macOS架构分开记录，Windows使用既有x64发行目标；不因本feat增加平台API或最低系统限制。
4. 若出现可重复交互/吞吐退化，先修复本feat。仅降低CPU但带来输入变慢不可验收；无显著整体差异时如实报告已消除的扫描路径，不宣称固定提升比例。
5. 准备独立PR说明：生产冗余复制问题、编译期隔离结果、保留行为、模式/平台测试、实测收益和局限；不使用“修复GC crash”结论。可用主题`feat(terminal): isolate automatic buffer text mirroring from production`。
6. 回填设计/任务状态和证据路径。本feat可独立回退，无数据迁移；GC恢复仅引用结论，没有依赖等待。若两项已并入同一基线，性能比较保持另一项功能状态完全一致。

完成条件：目标与保留行为满足，当前端真实production性能有配对证据，三端兼容/实测状态准确。未完成的真机项与其原因明确记录；仅编译/文档检查通过不能标实施完成。

## 6. 实施后的交付记录

当前所有项目为待执行；完成后填写实际值而非删除未覆盖项：

- 源码与二进制：P0/P1提交、相关diff、hash、前端mode及镜像开关、Rust flags。
- 正常行为：V-01至05结果与保留case，原基线失败/未执行情况。
- 性能：每端负载、样本、波动、无退化判断和已测收益；没有测到的指标明确列出。
- 改动范围：实际产品/测试文件，是否产生新依赖/接口；超出本设计的小范围改动须说明必要性。
- 发布边界：独立feat状态、回退方式、与GC恢复无依赖；不改变当前用户故障实例。
