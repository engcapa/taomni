# VMware Workstation 内置 VNC 服务器实测（2026-10-01）

用户提供的真实服务器：本机 VMware Workstation 17.6.4（build-24832109）给一台 macOS 14 客户机开启的内置 VNC 服务器（回环端口，无密码）。只测 Taomni，没有 RealVNC 同服务器对照。

方法：QA 身份 release 构建（`com.taomni.app.qa`，产品代码与 `1b5f92f7` 起一致）经 `vnc_burst_proxy.py`（只记字节数与时间）连接；会话信息读自 F8 菜单；指针用系统 `SetCursorPos`（不点击），按键用 WebDriver 动作（不经过本机系统，不按回车）；画面状态靠画布像素统计、截图差分与本机 OCR 判断。截图、OCR 文本与原始记录只留在 `qa-ui-auto-report/vmware-vnc/`，桌面名与画面不进文档。

## 1. 服务器行为

- RFB 3.8，安全类型只有 None（1）；ServerInit 1918×970（客户机按 VMware 窗口自适应），32 bpp rgb888。
- 编码：Taomni 把 Tight 放第一位时（Low / Medium）服务器用 Tight（含 JPEG）；ZRLE 在第一位时（High / Automatic，Tight 在第三位）服务器回 Raw。看起来只看客户端列表的第一项。
- 非增量刷新请求（F8 → 刷新屏幕，5 次都发出）只换来变化区域；SetEncodings / SetPixelFormat 之后服务器才重发整帧。

## 2. 结果

| 检查 | 结果 |
|---|---|
| 连接 | 会话安全策略设为 `allow-none`；先过未加密警告；会话信息显示协议 3.8、安全方式 None（未加密）、直连 |
| 首帧 | Raw 整帧 7.44 MB，回环上 166–175 ms 收完 |
| 锁屏：指针 | 只移动指针（9 个 PointerEvent），服务器随后回 352 KB 更新，锁屏从纯灰背景恢复为显示时钟与头像 |
| 锁屏：键盘 | Shift、`a`、Backspace 各发一对 KeyEvent；输入 `a` 后密码框内容变化（约 190 个截图像素），Backspace 后恢复到输入前，只剩光标闪烁的差异 |
| 桌面（用户手工解锁后） | 菜单栏 OCR 读到访达菜单；Cmd+Space 打开聚焦搜索，输入 `taomni vnc` 后屏幕上出现该文字，Esc 两次后消失（Command 经 Super_L 到达客户机） |
| 画质切换（桌面，单次） | 切换后的整帧：Low 1.23 MB / 253 ms、Medium 1.00 MB / 49 ms（都是 Tight），High 7.45 MB / 164 ms（请求 ZRLE，服务器回 Raw）；桌面同时有动画，两档 Tight 的大小不可直接比较 |
| 关闭连接 | 断开，显示重连按钮 |

## 3. 发现（交 P0，不在本批次）

- 没有保存密码的 VNC 会话打开前总会弹出密码框，且不允许空提交；连只提供 None 的服务器时只能随便输入一个字符（不会被使用）。RealVNC 只在服务器要求认证时才询问。
- High / Automatic 在这类服务器上拿到的是 Raw（7.45 MB 一整帧），回环上无感，局域网上会明显变慢。可考虑在服务器对首选编码回 Raw、且已确认支持 Tight 时把 Tight 提到第一位。
- 会话编辑器的 VNC 安全策略下拉框是写死的英文，中文界面不翻译（语言包里已有 `vncSecurityAllowNone` 等 key）。

## 4. 未执行

- 剪贴板（本机 → 客户机）：执行时本机剪贴板是非文本内容，为不覆盖用户数据跳过。
- DesktopSize（需要调整 VMware 窗口大小）、Windows 键等系统级特殊键直通、RealVNC 同服务器对照。
