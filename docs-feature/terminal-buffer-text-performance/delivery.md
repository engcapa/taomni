# 终端全文镜像优化：开发交付记录

日期：2026-10-15。**实现与本地单元测试完成；browser/native用例已编写但未执行，
实际打包及三端性能尚未验收。** 用户本轮明确要求只运行本地单元测试，不执行
browser/native，因此不执行原TASK-01/03/04中的真机测量或交互步骤。

## 1. 实现范围

- `vite.config.ts`：新增编译常量，`qa`或非preview开发serve开启，
  普通及非qa自定义build关闭；preview沿原构建产物。
- `vitest.config.ts`：默认关闭、`--mode qa`开启；其他QA探针保持false。
- `src/vite-env.d.ts`：声明常量。
- `TerminalPanel.tsx`：仅对自动`getBufferText`参数求值及文本属性写入加分支。
  CWD/ready、500ms定时器及清理、render/output/startup订阅原样保留。
- 组件测试分离ready与镜像，并覆盖生产render/output完成/轮询/隐藏/释放、
  QA空文本/软换行/Unicode/内部空行/末尾空行/620行/失败文案。
- mounted按需消费者测试在两种编译模式下覆盖完整>500行文本、
  Registry全文/AI尾部接口、Copy All、菜单与快捷键导出、断开快照、
  detached归位session及unmount不关闭保留session。
- 配置单元测试覆盖12条Vite command/mode/preview组合和3条Vitest mode组合。
  未新增产品依赖、缓存、IPC、Worker、runtime开关、用户设置或平台API。

## 2. 源码基线与保留契约

P0=`6ef3ce6aeb8519b99715a9fa11c18f563a7c6e40`，版本0.4.38；
开始时工作树干净。设计中的`a11c227c`是历史调研引用，不作为本轮实际P0。
P0从git对象可重建；未把当前工作树回退、未改用户运行实例、
未创建/杀死renderer或测试终端。

| 文件 | P0 SHA-256 | P1 SHA-256 |
|---|---|---|
| TerminalPanel.tsx | `f97524c931954e592c839830ecd7d35f84708bb6edd1c6bc9b3adc3d4f16ae2e` | `9b2f8b807c15f48494c8a3f53491384e3d0ca1237152e42bcd0d3d403af90f20` |
| vite.config.ts | `291581045c148cfbba36f9d95a1ecb57365d200d2877a4c1bafc0d4f1a27b840` | `6089e64d05fb3d240c5726578908ab06f0675c46b596d48d37471f33f50e24d7` |
| vitest.config.ts | `6b6319dded27690d82fd0e5cfcc8a7d3a05687e6eb6c5cb2e91c5f7b1f27aca6` | `460678dbeb195e28784331117777702d50519a0ab07b385dbbb9b647b2541f4b` |

P1为本次工作树diff，没有新建提交。测试环境Linux x86_64、Node20.20.0、
pnpm10.26.1、Vitest4.1.11/jsdom；不是原生WebView执行环境。
**P0/P1二进制、引擎版本、Rust flags与生产性能原始采样均没有收集**。
不可把上述源码hash冒充binary hash，也不能把单元执行时间当性能数据。

消费者审计：自动镜像仅syncAutomationState中的一个调用点；Copy All、
saveBufferToFile、collectReattachState、disconnect交接、Registry读取仍保留。
ChatDrawer仍通过Registry getLastLines按需取上下文；未改成DOM读取。
默认browser CI的`pnpm dev`继续开启镜像，无需修改driver/观察协议。

## 3. 本地执行结果

原始日志均在被gitignore排除的
`qa-ui-auto-report/terminal-buffer-text-performance/`。

| 检查 | 实际结果 | 证据 |
|---|---|---|
| P0组件+Registry，产品仍未加分支 | **88 passed / 1 failed / 1 mode-skipped**；失败仅为新增生产无扫描断言，实际观察到读取早期历史 | `p0-unit.log` |
| P1默认mode组件+Registry+配置矩阵 | **106 passed / 1 mode-skipped，3文件通过** | `p1-default-unit.log` |
| P1 qa mode组件完整文件 | **85 passed / 1 mode-skipped，1文件通过** | `p1-qa-unit.log` |
| QA目录静态audit --gate | 通过，case/schema/catalog无错误、coverage ratchet无退化 | `case-audit.log` |
| 新case selected CI plan | 通过，登记了6个OS/mode组合；只是计划，未启动job或服务 | `case-plan.log` |
| TypeScript `tsc --noEmit` 静态检查 | **未通过**：qr/qr-decode/tesseract模块无法解析，伴随MFA隐式any诊断；没有本次修改文件诊断 | `typecheck.log` |
| browser/native、真实build、性能 | **未执行**（本轮用户指定边界） | 无运行报告，不宣称通过 |

两个mode各一个skip是相反编译模式专属测试的选择，不是平台能力跳过；
同一测试在其适用mode实际通过。保留完整文件内的迟到SSH prompt、
startup/CWD顺序、StrictMode、失败重连及输入测试，无删减原行为断言。
最初定向执行暴露测试夹具问题（timer时钟与可选OCR包解析），已修正测试：
轮询时钟在挂载前受控、异步连接状态明确flush；配置测试只mock无关OCR插件。
配置单元测试不是实际产物tree-shake/打包证明。未安装缺失包或修改无关MFA/OCR。

## 4. AC → V → 实际测试/用例 → 状态

| AC/V | 本轮证据或交接用例 | 状态/边界 |
|---|---|---|
| AC-01/03/07、V-01 | `does not scan history on production render, output completion or polling, even while hidden`；独立ready测试；既有startup/CWD/StrictMode | mounted生产路径通过，真实WebView待执行 |
| AC-02/03、V-02 | `mirrors complete QA text including soft wraps, Unicode, empty rows and failure messages`；TC-TERM-TEXT-001、TC-022/143/144 | qa单元通过，browser/native未执行 |
| AC-01/02/06、V-03 | `vite-plugins/terminalTextMirror.test.ts`；runbook C-01 | 配置矩阵通过；真实bundle/preview/三端打包未执行 |
| AC-04/07、V-04 | `preserves on-demand full history, copy/export, AI tail and disconnect snapshots in either mode`；`hands full history and the original session back from a detached panel in either mode`；Registry既有6条 | 两种模式mounted通过；真实OS剪贴板/文件/PID/AI预览待N-01/04 |
| AC-02/03/06/07、V-05 | TC-005/006/119/143/144；N-02/03/05 | 用例交接，native未执行 |
| AC-05/06、V-06 | PERF-01a/b/c/d | 配方已写，所有平台真实采样/收益/无退化判断未验证 |

可执行专题case共6条，位于 `qa-ui-auto-tests/cases/TC-TERM-TEXT-*.testcase.yaml`：

| ID | 内容 | Mode |
|---|---|---|
| TC-TERM-TEXT-001 | 620行完整文本、Unicode/ANSI/软换行及连续输出 | browser/native QA |
| TC-TERM-TEXT-002 | 半输入、延迟分段输出、非idle/idle ready及恰好一次执行 | browser/native QA |
| TC-TERM-TEXT-003 | 只读禁止输入，但实时输出继续；解除后新输入正常 | browser/native QA |
| TC-TERM-TEXT-004 | alternate假prompt不得ready，normal历史恢复及后续输入 | browser/native QA |
| TC-TERM-TEXT-005 | 清除620行旧历史、重建Unicode/空行/长行镜像，无过期文本 | browser/native QA |
| TC-TERM-TEXT-006 | Copy All的独立OS剪贴板首尾/长行/Unicode及连续复制 | native QA |

前5条支持两种模式，第6条只用native且需要隔离测试账号/剪贴板。
第6条自动核验必要首尾段，不宣称所有中段逐字节相等；完整比较仍由N-01覆盖。
每条均有covers/fixtures/modes、分步骤行为契约及visual/native边界。
已同步policy、dependencies和F2.2说明；未新增控件/verb/fixture，
无需重生成控件catalog。

本次补充仅改case、目录登记及交接文档，未改产品/单元测试代码；
6条case的schema及行为契约静态验证通过。扩充后静态audit及CI选例规划
结果见 `case-expansion-audit.log` / `case-expansion-plan.log`。
**没有执行browser/native，也没有因case补充重跑单元或重启应用。**

完整用例、OS隔离、数据、顺序步骤、取消/失败/恢复/生命周期、原生边界、
三端性能与证据模板见：
[browser/native runbook](../../qa-ui-auto-tests/native/runbooks/terminal-buffer-text-performance.md)。
复用TC-022仅browser，TC-005/119仅native，未扩大原case mode。

## 5. 发布边界

本轮交付为独立feat实现+本地单元证据+未执行的browser/native用例，
**不是TASK-04生产性能验收，也不是三端兼容验收完成**。
生产周期全文镜像从源码执行路径隔离；单元测试证实buffer mock的早期
历史不会被自动路径读取。不宣称固定CPU/内存收益、零性能退化或修复GC crash。

500ms业务poll仍存在，QA/development仍有原全文镜像开销，
主动全文复制/导出仍承担按需成本。无数据迁移，与GC恢复无依赖；
独立回退只撤销本feat代码及其测试适配，不回退用户数据或其他恢复功能。
