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

当前状态：受影响 unit 45 文件 / 293 项、TypeScript 与 refactor 检查通过；Linux browser 完整批次 34/34（18 crash）通过。006 的 native 指令兼容及显式深色主题追加后，在 `browser/run-20261118-003156-699818154` 具名复验通过，当前有效并集仍为 34/34。匹配 QA release 的 `native/run-20261118-003255-917884230` 中，006 与原文件导出 028 均通过、identity stable；其余 36 项 native 正在执行。Windows/macOS 新版验证结果待回填，不以静态 audit 或构建成功代替真实结果。证据根 `/data-raw-hdd/temp/taomni-curves-columns-20261117`。

用例修正记录：首次 native preflight 拒绝了 browser-only `set_viewport`，该次没有运行产品步骤；006 改用真实窗口并通过拉宽列产生横向溢出，浏览器窄窗仍由 002 覆盖。另显式切换并断言 light、dark，避免把系统浅色和显式浅色误认为两种主题。拖动端点保持在 1280px 原生窗口内，不依赖浏览器允许的视口外鼠标坐标。
