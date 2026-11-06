# #778 — Ubuntu/X11 终端字形损坏

## 报告与边界

- issue: https://github.com/engcapa/taomni/issues/778
- Ubuntu 24.04.4 LTS/X11，Taomni 0.5.3；首次报告，无可靠手动触发步骤。
- 截图中应用顶部标签与工具栏正常，终端内部分中英文显示字形碎片；复制文本正确。
  切换屏幕未恢复，锁屏重新登录后恢复。
- 用户补充：Windows 11 曾在长时运行后出现同类现象，已有 WebGL 开关及
  context-loss 回退。Ubuntu 此前未报告。
- 以上定位到 terminal rendering 故障类，但不证明用户 GPU/驱动的具体根因。
  不把浏览器/托管软件 GPU 的通过声称为复现了原物理设备的间歇故障。

## 代码核对

0.5.3 与调查基线 `604894bea` 都默认 `webglRenderer: true`，只有 macOS native
通过 `shouldUseTerminalWebgl` 禁用 WebGL。原设置组件却只在 Windows 显示开关。
已有 context-loss handler 正确地只释放 addon 并刷新终端；图集错误但 context
仍存活时不会触发它。普通 fit/refresh 不是字形图集重建。

当前稳定 npm 包仍为 `@xterm/addon-webgl@0.19.0`，配 `@xterm/xterm@6.0.0`。
该版本包含以下相关问题，保留匹配版本而非换用未发布 beta：

1. `clearTexture()` 清空共享 glyph/cache/pages 后未通知其他 renderer 重建 model。
   其他终端的缓冲不变，但旧 UV/texture-page 坐标指向新 glyph，产生错字/碎片。
   本次是 fixture 显式调用 addon clear 的受控复现；应用目前没有主动 clearAtlas
   调用，不能把此触发直接归因到原报告的自然长时路径。
   上游 [#6014](https://github.com/xtermjs/xterm.js/issues/6014)、
   [#6055](https://github.com/xtermjs/xterm.js/pull/6055)。
2. 后续上游用 renderer 独立比较单调 `pageLayoutVersion`，替代共享失效 flag：
   [#6038](https://github.com/xtermjs/xterm.js/issues/6038)、
   [#6042](https://github.com/xtermjs/xterm.js/pull/6042)。注意 **0.19.0** 的
   `_requestClearModel` 没有 reset；不能照搬新版的“consume-once”描述为本版
   已证实行为。clear 漏通知在本版独立存在；merge 路径需要同时保留回归。
3. 每次 atlas 上传调用 `generateMipmap`；Linux 部分 GPU 堆栈出现损坏，上游改为
   无 mipmap 的 LINEAR min/mag filters：
   [#5986](https://github.com/xtermjs/xterm.js/issues/5986)、
   [#5987](https://github.com/xtermjs/xterm.js/pull/5987)。硬件触发未在本机确认。

## 修复范围

- 使用 pnpm pinned patch 回补上述三个上游修复的相关小范围源码变更；同步发布包
  的 ESM/CJS runtime 文件（只改 src 不会影响 Vite 选中的 lib）。不升级 xterm core，
  不修改默认值或用户已持久化选择。
- atlas clear、page merge、overflow page layout 变化增加 version；各 renderer
  自行记录已见版本，换 atlas 后重新建立 model。没有逐输出 IPC/定时清缓存。
- 取消 glyph atlas mipmap，显式使用 LINEAR min/mag；不关闭全应用 GPU/compositing。
- 将既有 WebGL profile 开关开放给 Linux，保留 Windows 和 macOS 原策略。
  “右键终端 → Change settings → Use WebGL renderer”可即时关闭；需要后续新终端
  继承时使用已有 Save as default。会话 profile 的既有持久化语义不变。
- 不 remount TerminalPanel、不 reset/clear 缓冲、不杀进程、不重连 SSH，不将
  正常终端送入 WebView renderer-crash recovery。

## 测试设计与证据

用户要求全部 browser/native 用例通过 `.github/workflows/qa-ui-auto-platforms.yml`
在 GitHub 执行，不在本地执行。静态 TypeScript、catalog、boundary 和单元测试
与 browser/native 运行证据分开记录。

### V1 — 真实像素复现 `TC-TERM-RENDER-001`

三个同字体/主题/DPR 的真实 xterm 共享一个 atlas。进入 alternate screen，两个
终端保持 ASCII/CJK/框线 header；第三个清空并重填图集。只刷新受影响终端最后
一行，避免全 viewport refresh 掩盖旧顶行顶点。独立裁剪前后 screenshot，比较
4×4 block channel diff ≤14（上游同类 pixel oracle 阈值），同时要求 header 文本、
几何、Terminal 对象、backend session IDs 不变。再限制测试用新 page 尺寸，填入
带颜色 glyph 触发实际 merge，并要求 ≥4 page-removal 事件。

调试对象只在 dev/QA 全文观察编译分支注册；production branch 不可达且由打包
消除。fixture 不向 PTY 输入，cleanup 恢复 atlas 参数与 alternate screen。
保存原图、期望/实际/差分和 `terminal-rendering.json`，失败记录不覆盖。

- 修复前源码：`69704e664`，尚未使用任何 addon patch。
- GitHub baseline run：https://github.com/engcapa/taomni/actions/runs/42135031972
- browser 原始报告：`run-20261106-001617-921328339/TC-TERM-RENDER-001/terminal-rendering.json`。
  clear 后两份 header 的 `maxBlockChannelDifference` 分别 114、111（阈值14），
  文本仍为 `REF-0123456789 中文字形 ┌─┐`，`shared`/`sameTerms` 均 true，
  几何不变；merge 实际发生23次 page removal 后两份差异均为0。保留失败 PNG/receipt。
  这是受控 library failure 的成功复现；browser local shell 不可用，`sessions: []`，
  **不能从该 browser 结果声称已验证真实 PTY/SSH 连续性**。
- Linux native 原始报告：`run-20261106-005150-666502561/TC-TERM-RENDER-001/terminal-rendering.json`。
  Ubuntu24.04/X11 QA release 的 clear 两份像素差异均144，文字/几何/对象和三个
  backend session IDs 不变；merge 实际20次 page removal 后差异均0。
  `summary.json` / pixel report 的 hash 已与原始 receipt 核对；该 shard 原始 exitCode=1。
  其余9项 native crash-regression 均通过，没有 skip。
- entry job 的绿色只表示完成了 receipt 交付，原始 `runner_exit_code:1` /
  `case_result_exit_code:1` 与失败用例才是执行结果，最终 summarize 才汇总实际 pass/fail。

### V2 — Linux/Windows 活会话开关 `TC-TERM-RENDER-002`

真实 disposable POSIX SSH shell 记录 `$$` 和未导出的 shell-local marker，打印
独立 BEFORE 输出行。由当前终端设置关闭 WebGL，检查 addon 释放、原历史仍在；
只有原 shell PID+变量一致才能打印独立 STABLE 结果行。重开设置仍显示关闭，
显式重新开启 WebGL后再检查 addon 安装、原 shell/历史与后续输入。browser 使用
真实 SSH bridge，不将 stub 证据替代 native IPC/WebView。

- 候选源码 `ba3962182`，GitHub run
  https://github.com/engcapa/taomni/actions/runs/42137876791 ：
  Linux browser `run-20261106-003939-575332282`、Windows browser
  `run-20261106-004514-220388900` 中该 case 均通过，分别保留 STABLE/WEBGL 独立
  输出行与真实 SSH shell 状态。原始 summary hash/receipt exitCode=0 已核对。
- 同轮 V1：Linux browser `run-20261106-003950-382770900`、Windows browser
  `run-20261106-004316-455292700` 的 clear/merge 四组 pixel 差异全为0；
  两平台各14个用例全部通过、0 skip。macOS browser 两 shard 合计13/13 通过；
  renderer-switch case 按实际平台声明不适用于 macOS，不把该排除标成执行 pass。
- 核对 hosted selection 发现 `ba3962182` 的 `TC-TERM-RENDER-002` 使用 browser-only
  `quick_connect`/`auth`，Linux/Windows native 被 planner 记为 not-applicable，**不能
  作为 native 开关已测**。`dd6abda33` 改为共享 fill/click/wait UI 步骤、重映射
  checkpoints；静态检查确认两端 native_support 为 None。通过同一 workflow 补跑
  https://github.com/engcapa/taomni/actions/runs/42141625169 ，hosted selection 已确认
  开关用例纳入 Linux/Windows×browser/native 四种组合，并保留自动 crash-regression；
  产品与二进制输入不变。实际执行/取消状态见下。
- `42137876791` 的 Linux native `run-20261106-011509-454753933`：V1 clear/merge
  四组 pixel 差异全部0；三个真实 backend session IDs、对象、缓冲与几何保持不变。
  原始 summary/pixel hash 与 receipt 核对一致，exitCode=0。与修复前 native
  144/144 的差异构成受控像素故障的红→绿；不是物理驱动长时触发复现。
- macOS native 四 shard 合计13/13通过、0 skip，原始 receipt hash 已核对。
  macOS 使用既有稳定 DOM 策略，不声称执行了 native WebGL 像素分支。
- 主验证 `42137876791` 已结束：browser Linux14/14、Windows14/14、macOS13/13；
  native Linux14/14、macOS13/13；Windows native13/14。所有组合无 skip。
  Windows V1 `run-20261106-013112-656664600` clear/merge 像素差异全0，三个真实
  session IDs不变；但该 shard 首个 `TC-150` 在 setup/所有步骤之前失败：
  `native app document did not become ready within 20.0s: document root is not mounted`。
  desktop screenshot 未见应用界面，日志为空，根因未定；同 shard 随后用同一二进制
  完成 V1、WS039/053。最终 aggregate `passed:false`，不是可忽略的绿色运行。
- 保持产品、20秒超时和用例断言不变，定向复核 Windows `TC-150,TC-TERM-RENDER-002`
  加 crash-regression。第一次 `42144872829` 仅指定 native，因强制 tag 包含两个
  browser-only case 而在 plan 阶段被拒绝，**没有执行任何产品用例**。
  修正为 browser/native 后以 `08e555019` 执行：
  https://github.com/engcapa/taomni/actions/runs/42145253666 。
  **最终 workflow success，aggregate passed/report_ok=true，failures及infrastructure_errors均空；
  Windows browser10/10、native11/11全部通过、无skip。**
  其中 `TC-150` 原生复核 `run-20261106-020230-553323500` 通过（原冷启动失败仍保留，
  根因未定，不能据一次复核宣称修好了Windows启动）；V2 `run-20261106-020401-194451800`
  通过，真实 SSH 原shell PID/变量/历史与后续输入保留；summary hash/receipt核对一致。
  `08e555019` 与主/补充验证的产品/patch/构建输入一致，只有测试/证据增量。
- 补充运行 `42141625169`：Linux browser9/9、Windows browser9/9、Linux native10/10
  全通过、无skip。Linux native `run-20261106-012642-363771203` 的 V2 原始
  summary hash/receipt exitCode=0 已核对，真实 SSH 原shell PID/变量/历史与后续输入
  均保留。Windows重复执行在上述复核全绿后主动取消，不把cancelled写成pass。
- 首个候选 run `42137113187` 因用例平台/POSIX fixture 声明修正主动取消，不作为证据。

### 最终覆盖结论（2026-11-06）

- 受控同类 glyph 故障在 Linux browser/native 修复前均复现；修复后 Linux/Windows
  browser/native 的 V1 像素差异全部0，真实native会话身份保持。
- V2最终共享UI步骤在Linux/Windows browser/native各自实际通过。
- crash-regression完整集合三平台 browser/native均有同产品输入的实际通过证据；
  macOS保持默认稳定renderer。主运行并非全绿，Windows补充复核全绿，两者都保留。
- 最终证据更新只修改本文件，不改变上述产品、用例或构建输入。
- 原Ubuntu物理GPU间歇触发、Windows11物理设备长时运行仍按下节标unverified；
  hosted Windows为Windows2025 runner，不冒充Windows11硬件验收。

### V3 — 保留行为

- 既有 complete `crash-regression` browser/native 集合（workflow 自动合并），native
  使用匹配 QA release binary。
- `TC-110` split、`TC-150` current settings、`TC-TERM-TEXT-004` alternate buffer、
  `TC-154`/`TC-155` 复制与字形选区；按受影响平台安排。
- focused unit：TerminalAppearanceSettings Linux/Windows/macOS 分支与既有 terminal
  context-loss/dispose contracts。对 patch 的源码及 ESM/CJS 包行为另设 contracts。
- 本地支持检查已通过：`pnpm build`（含 tsc/boundary/source-size）、
  `pnpm check:refactor`、QA catalog gate/development contract；production `dist/assets`
  搜索确认无 `__TAOMNI_QA_TERMINALS__`/`registerQaTerminalRendering`。
- GitHub Linux producer 完整前端单元：670 test files passed，6227 passed + 1 existing
  skipped；`frontend-unit-contracts.log` 保留在 build artifact，未缩小全套范围。
- 单元：TerminalPanel/Appearance/Viewport 105 passed + 1 existing skipped；
  profile/registry 9 passed；ESM/CJS backport 6 passed；Python probe/CI selection/build
  pipeline 28 passed。未在本地运行任何 browser/native 用例。独立只读正确性复核未发现
  具体问题（不作为运行证据）。

### 剩余物理设备验收

原 Ubuntu 24.04/X11 设备和曾出问题的 Windows 11 设备各记录 GPU/驱动、WebView、
显示协议、缩放、运行时长与开关状态。长时 TUI/CJK/颜色输出、多 tab 与锁屏/唤醒
后检查真实截图和复制内容。未完成前明确标为 unverified；不能保证驱动问题已消失，
也不能从短时软件 GPU 样本宣称零性能退化。

## 源码边界

手写 renderer seam/probe 按生命周期/JS fixture/host pixel oracle 分离。pnpm patch
包含发布包压缩生成的 bundle，因此单行较长；不将依赖 bundle 拷进产品源模块。
上游发布含等价修复的稳定兼容版本后，应移除本地 backport 并保留像素回归。
