# File Explorer 明细视图列宽

## 范围与行为

用户要求 File Explorer 明细视图像 Windows Explorer 一样调整列宽。名称、修改日期、类型、大小的右边界均可拖动；调整单列不改变排序或文件选择。默认名称列继续填充剩余空间，第一次调整后使用显式宽度。

列边界双击按目录数据自动适配，包括虚拟列表尚未挂载的条目；保留完整路径提示。名称、日期、类型、大小分别至少 140/100/72/64px，最大 2048px。超宽时横向滚动，表头和文件行共用滚动容器，表头纵向固定。名称异常长时按最大列宽截断。

列宽合入既有 `taomni.explorer.view.v1` 的 `columnWidths`，全局共享，恢复和新标签使用相同宽度；旧配置缺省为空，未知列和非有限数值忽略，越界值钳制。图标和简洁列表保留原展示，切回明细恢复宽度。

边界支持鼠标、触控笔/触摸指针与键盘焦点。左右方向键调整 10px，Shift+方向键调整 50px，Home 恢复该列默认宽度；仅在列边界聚焦时处理，没有应用菜单快捷键。忽略 IME 合成和 Alt/Ctrl/Meta 组合，不影响 Cmd/Ctrl 文件操作。松开指针保存；pointercancel 撤销本次拖动；窗口失焦保存最后宽度；切换视图或卸载清理捕获和监听，晚到事件不写回。

## 实现边界

- `explorerColumns.ts`：列键、尺寸校验、布局与全目录文本测量；同一格式化函数用于行与自动适配。
- `useExplorerColumns.ts`：本次拖动的临时状态、指针身份、提交和取消、键盘与自动适配。
- `ExplorerFileColumns.tsx`：排序按钮、列边界与可访问名称/尺寸。
- `ExplorerFileList.tsx`：组合上述 owner，虚拟列表为固定表头留出滚动边距，框选坐标保留表头偏移。

## 验证映射

| ID | 场景与预期 | 用例/层 |
| --- | --- | --- |
| V1 | 四列独立拖动、最小/最大宽度；不误排序、不丢选择 | `ExplorerFileColumns.test.tsx`；TC-EXPLORER-006 browser/native |
| V2 | 指针取消、其他指针、失焦、模式切换和卸载无残留监听/晚写回 | mounted unit；006 模式切换与重开 |
| V3 | 双击适配名称和列标题、虚拟视口外长中文名也参与测量 | mounted/model unit；006 实际文件行无截断 |
| V4 | 列边界方向键/Home 所有权、IME/系统修饰键不抢占；普通表头仍排序 | mounted unit；006 实际焦点键盘与排序 |
| V5 | 配置迁移、损坏配置、存储失败、重开和新标签恢复 | mounted unit；006 reload/new tab |
| V6 | 超宽横向滚动、窄窗、深浅主题、表头与行对齐 | 006 几何断言及显式 light/dark 截图；002 browser 窄窗布局 |
| V7 | 10000 文件 End/Home、排序/过滤、框选、重命名、拖放、真实文件操作保留 | Explorer 原有 units；TC-EXPLORER-001～005 适用模式 |
| V8 | 共享 viewer、Workspace/PTY 生命周期及原文件导出保留 | 受影响 FILE/WS cases 和完整 crash-regression browser 18/native 22 |

本机使用 Linux Chromium 和匹配当前源码的 `com.taomni.app.qa` release；native 读取真实磁盘并检查 WebKitGTK 指针/滚动，满足用户明确的原生验收要求。Windows/macOS 通过 `qa-ui-auto-platforms`。macOS 本地焦点键经 WKWebView 桥接，不扩称 OS 全局键盘/AppKit 菜单验收。本轮执行中持续下载已完成 shard，只下载测试证据，不下载大型 native runtime。

## 验收状态

产品提交为 `e07d7823b`（Mermaid 原生曲线）与 `839cda93d`（列宽）；之后 `b47a425ba`、`cb76a51a2`、`8ecf83455` 只修正自动化窗口条件和异步就绪，没有改变产品源码或 runner。当前源码/runner 身份分别为 `6e57ec0e87321a2f2fadce61eccfaa8df7545ebdc27895988633d488ebbb1956` / `e217029995e211f35df80858dd2b4898e6f1142003f6c4f5a2d7995a0da257c7`。

证据根 `/data-raw-hdd/temp/taomni-curves-columns-20261117`。本机使用 Node 22.23.4 / pnpm 10.30.0，45 文件 / 293 项 unit、独立 draw.io/Word 检查器 16 项、TypeScript、refactor、开发用例契约和 case/control audit 均通过。匹配的 QA release 已核对实际二进制字节、build identity 与 native 回执，见 `node22-verification.json`、`independent-qa-build-identities.json`。

当前 Linux browser **34/34，完整 crash 18/18**；native **37/38，完整 crash 22/22**。新 006 的 86 步和原文件导出 028 均通过。最终本机 browser 报告为 `browser/run-20261118-030346-046534738/summary.json`，最终 006 native 为 `native/run-20261118-025346-465028580/summary.json`；完整有效并集及回执/绑定产物核验为 `independent-local-node22.json/.log`。旧版 006 的用例指纹明确列为 stale，不混入当前覆盖。

最终 hosted 具名补跑 [44153057201](https://github.com/engcapa/taomni/actions/runs/44153057201) **成功结束**，两端 browser 各 **19/19**、native 各 **23/23**，包含最新版 006 和完整 crash 集合。八个执行分片全部在 workflow 结束前下载到 `hosted-ready/`，日志保留下载时间和 `workflowStatus in_progress`；不是等最终汇总后再收集。原始 case 数、签名和绑定文件均独立核验，不依据绿色上传 job 推断通过。

完整受影响选择的当前有效并集：

| 平台 | browser | native | 完整 crash-regression |
| --- | --- | --- | --- |
| Linux | 34/34 | 37/38 | browser 18/18；native 22/22 |
| Windows | 34/34 | 37/38 | browser 18/18；native 22/22 |
| macOS ARM hosted | 34/34 | 38/38 | browser 18/18；native 22/22 |

Linux/Windows 的唯一保留失败均为下面详述的 TC-EXPLORER-005；其余无缺失、跳过或意外失败。`independent-three-platform-final.json` 和 `.log` 独立核验 **48 份报告、37584 个绑定产物条目**的签名、稳定源码/runner、匹配 QA release、当前用例指纹、执行配置及文件大小/SHA-256。重复执行绑定同一文件时按报告分别计条目。`final-selection-matrix.json` 与预期 34/38 项及完整 crash ID 集合逐项比对通过；`final-verification-index.json` 是机器可读入口。旧 006 的原始失败及 stale 指纹均保留，不覆盖当前补跑。

## 保留失败与验证边界

TC-EXPLORER-005 的 Linux/Windows 既有后台终端标签关闭交互继续保留失败：真实系统剪贴板、系统文件管理器粘贴和字节一致性已经通过，但 mousedown 激活后台终端后标签栏移动，mouseup 未关闭标签，下一步无法定位 Explorer 预览按钮。本次没有修改 TabItem/TabBar；它们与变更前 `b7f8252fc` 一致。失败截图、事件和独立粘贴记录见 `retained-native-005-diagnosis.json`。按用户允许忽略无关失败的约定，这项留作独立修复，不放宽断言、不宣称后续进程重启恢复通过，也不计为 crash 套件通过数。

Linux 早期 005 还曾缺少外部 PCManFM-Qt；补齐依赖后执行到上述真实交互失败。两次原件均保留。macOS native 桥接按键、browser 主机截图不扩称 OS 全局键盘/AppKit 菜单或其他 macOS 版本/架构验收。

## 自动化修正与历史证据

| 批次 | 原始问题与处理 | 保留证据 |
| --- | --- | --- |
| 本机早期 006 | native preflight 拒绝 browser-only `set_viewport`，该次未运行产品步骤；改用真实窗口，显式验证 light/dark | 原失败和最终 86 步报告均保留 |
| [44128082186](https://github.com/engcapa/taomni/actions/runs/44128082186) | Windows 原生窗口 1028×779，旧用例把日期边界从 x1017 拖到 x1097；macOS browser 一片在分配 runner 前因容量取消 | `hosted/`、`hosted-runner-capacity.json`；取消不算执行或通过 |
| `b47a425ba` / [44140964491](https://github.com/engcapa/taomni/actions/runs/44140964491) | 先让末列进入视口，再执行原 80/300px 拖动；保留精确宽度、排序、选择和持久化断言。另发现重载后侧栏已折叠和宽窗口没有实际溢出的测试假设 | `hosted-followup/`；旧失败保留 |
| [44142717188](https://github.com/engcapa/taomni/actions/runs/44142717188) | macOS 容量缺口补跑 browser 非 crash 5 项及完整 crash，**23/23** | `hosted-macos-recovery/` |
| `cb76a51a2` / [44150178225](https://github.com/engcapa/taomni/actions/runs/44150178225) | 重载后等待实际恢复的 previews 标签和真实文件行；两次 Shift+Right 使宽窗口确有横向溢出。Windows browser 19/19、macOS browser 18/19；后者切换新标签时过早解析到旧隐藏 pane | `hosted-restored/`；两端 native 原始 23/23，旧 006 明确 stale |
| `8ecf83455` / [44153057201](https://github.com/engcapa/taomni/actions/runs/44153057201) | 等待旧标签失活、新标签激活及新 pane 文件行，保留全部断言，无固定 sleep；最新本机 browser/native、1028×779 窄窗探针和两端 browser 均通过 | `hosted-ready/`、`independent-local-node22.json/.log` |

一次 dispatch 使用短 commit，44140628191 在 checkout 失败，0 case 执行；已改用完整 SHA。该失败同样保留，不算产品测试失败或成功。

自动适配只要求文件名内容不截断，不要求用户显式拉宽的其他列总和能塞进窄窗；真实横向滚动和表头/行误差小于 1.5px 另有断言。最新版 006 是 86 步，所有跨窗口、恢复和新标签改动都保留原行为检查。

## 真实导出、视觉与空间

用户原文件 `/home/zhyhang/temp/testing.md` 在 native 中直接打开，前后 SHA-256 均为 `c669a35a1cc8ec37aba798b496fa5b6c8c6405118079482bcaec03ee4c27f900`。稳定产物 `verified-original-final/testing.drawio`、PDF 和 Word 绑定实际 028 回执；原文件两条长弧从 87/101 个点降为 **8/7 个原生控制点**，实际 draw.io Desktop 29.6.6 鼠标拖动、撤销后 source/target 保持连接。三平台 9 个真实 native draw.io 文件的 XML/端点检查见 `independent-actual-export-files.json`，原文件最大 8 个控制点，时序端点最大误差 0.312px。

Linux 实际 draw.io Desktop、四页 PDF 与四页 Word 视觉记录为 `visual-review.json`，Word 使用 LibreOffice，不扩称 Win11 Microsoft Word 客户端验收。列宽本机视觉为 `explorer-visual-review.json`、`explorer-restored-visual-review.json`，最新 Windows/macOS browser 深浅主题及横滚截图为 `hosted-ready-browser-visual-review.json`；后者只证明 Chromium 主机行为。最终 Windows/macOS QA release 截图另见 `hosted-ready-native-visual-review.json`；macOS 后期截图的既有标签 tooltip 部分遮挡左表头，未据此宣称完整无遮挡的表头视觉验收。

报告统一放 HDD，执行期间持续下载已完成分片，跳过大型 native runtime。已移除闲置默认 `src-tauri/target/debug`，约 5.15GiB 逻辑大小，见 `cleanup-unused-debug-target.json`；保留匹配 QA release、回执和绑定证据。
