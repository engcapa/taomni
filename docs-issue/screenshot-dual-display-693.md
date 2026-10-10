# Ubuntu 双显示屏截图（#693）

关联：<https://github.com/engcapa/taomni/issues/693>。报告环境为 Ubuntu 24.04.4 LTS / Taomni 0.4.34。

## 根因与修复

- Wayland portal 返回一个或多个独立屏幕流，旧截图捕获取第一个流，再假定它是整张虚拟桌面进行裁剪。现在按目标屏幕的 compositor 逻辑位置和尺寸匹配实际流；拒绝分享目标屏或元数据不能确定目标时给出错误，不用其他屏的截图回退掩盖失败。RDP 默认单流行为保留。
- 混合 DPI 下 GDK/Tao 将各屏的位置、尺寸乘以各自缩放率，不能把这些位置当成统一的桌面像素位置。现在还原每屏逻辑坐标匹配 portal 和 GTK 输出，区域截图按实际流像素尺寸映射。
- Wayland 不允许读取全局指针位置，Tao 返回的 `(0,0)` 不能用来判断鼠标所在屏。截图按钮以调用窗口所在屏为默认；全局快捷键以主窗口所在屏为默认。显示器选择器允许截图另一屏，不需要移动主窗口。
- Wayland 忽略普通窗口的全局定位。遮罩全屏明确指定匹配逻辑几何的 GDK monitor，支持在不同 DPI 的屏幕间切换。
- Linux 临时隐藏应用使用最小化、恢复，保留 compositor 的窗口映射与所在屏。原来的 GTK hide/show 会重新映射窗口，X11 实测将第二屏的主窗口移回了第一屏。
- 混合 DPI 的浮动控件、边框先换算为 compositor 逻辑几何，再按 Wayland 和辅助 XWayland 两个 GDK 桌面的实际几何转换。XWayland 会将整个桌面以全局 2× 坐标表示，只使用 `LogicalPosition` 仍使控制条实际缩小一半并进入捕获区。现在直接向辅助 GTK 后端发送转换后的几何。控件布局保留选定输出的 scale，并在逻辑桌面判断是否与捕获区域相交；各屏 physical 范围重叠也不会重新猜测所属屏。
- QA 像素观察以 compositor 中实际窗口所在输出的 scale 换算，而非 XWayland 的全局 buffer scale。双输出拓扑在虚拟输入设备创建前配置完成；指针必须实测到达两屏的目标点后才能通过 fixture preflight。
- GNOME 顶栏的右边缘指针屏障会阻止在顶部 16px 跨输出停车，表现为指针恰好停在接缝。这是测试停车点问题；改在顶栏下方停车，仍要求原生 seat 指针到达实际目标。Pin 的透明度采样先移开拖动后留在图片上的指针，避免把悬停帮助提示当成图片像素。
- Wayland 恢复窗口时，Tao 会在最小化缓存尚未变化时跳过焦点请求，而且 GTK 的激活 token 依赖当前焦点表面。现在在销毁遮罩或新 XWayland 贴图抢占焦点之前，先由 GTK 主线程 `deiconify/show/present` 恢复主窗口；QA 等待 compositor 可见状态。双屏独立原图 fixture 在自己的 GNOME 桌面禁用通知 banner，避免“应用已就绪”覆盖原图；不修改用户桌面通知设置。
- 滚动完成后的普通编辑窗口会保留隐藏全屏表面的旧 configure 记录，仅重发 resize 仍会偶发停在 1717×965。转换前对隐藏 GTK 窗口执行 `unrealize`，清除旧原生表面的 configure/resize 几何记录，保留 WebView 对象和编辑内容，然后配置正常窗口并重新映射。QA 继续检查初始 1100×800 和用户再次缩放到 760×620 的实际原生尺寸。
- 切换到 200% 输出前，隐藏窗口仍缓存上一屏 100% 缩放；按该缓存转换物理尺寸会请求双倍逻辑尺寸，出现遮罩正确而 WebView 视口为 2560×1440 的错误。切换前重建隐藏表面，并按目标输出发送 1280×720 的逻辑尺寸；原图仍保持 2560×1440。
- 公共显示器切换会在捕获新输出时临时隐藏遮罩，Mutter 此时没有该窗口的 actor。QA 在用例期限内等待重新映射，然后继续要求完整原图、目标屏几何、视口和 DPR 精确匹配；不会将这个正常的中间状态直接判成窗口消失。

当前交互是一次选择一块显示器，选择器可以访问全部输出；一次拖选跨两屏并合成为一张图不属于本次实现。

Wayland 的「当前窗口」预选与显示器选择是不同路径：标准 Wayland 不提供普通窗口的全局原点，原实现将 GDK 虚拟 `(0,0)` 当成窗口位置，在首屏可能错误预选、第二屏报「窗口不在屏幕内」。现在明确拒绝该预选方式，提示使用 Screen region 在目标屏拖选，主窗口保持可见、不创建错误遮罩。Windows/macOS/X11 的当前窗口预选保留。`TC-SHOT-N12` 明确检查这两种平台结果，不把 Wayland 的报错记录成预选成功。

## 自动验收设计

`TC-SHOT-N23` 使用真实 OS 枚举的两个虚拟输出，外部 GTK 窗口分别绘制独立色块原图：

- Ubuntu 24.04 / X11：独立 Xorg dummy server 提供两块实际 RandR 输出，必须由 GDK 枚举为两屏。第一轮证实 Xvfb 的 SetMonitor 请求并未建立输出，因此不使用该方案。
- Ubuntu 26.04 / GNOME Wayland：两块 Mutter virtual monitor，1920×1080 / 100% 和 2560×1440 / 200%；实际配置、映射窗口几何和缩放率必须符合，缺失即失败。
- 分别从两屏调用公共截图入口，公共选择器切换到另一屏后返回；检查完整 PNG 原图像素、原生遮罩位置、viewport/DPR、真实 OS 拖选后剪贴板裁剪像素、主窗口恢复到调用屏。独立区域帧探测会隐藏、恢复主窗口；公共入口测试前由 fixture 激活主窗口，要求它确实可见且位于目标屏。仅移动最小化窗口后点击隐藏 WebView 不能代表手工点击入口。普通窗口在屏内的位置由 compositor 管理，不要求恢复到固定的绝对 XY；遮罩几何、DPR、PNG 和剪贴板像素仍严格匹配。截图完成后的恢复断言由产品负责，不由 fixture 激活代替。
- 原图由外部 GTK/Cairo 绘制生成，不从产品捕获结果构造。独立输出、元数据、原图与实际 PNG 保留为 artifacts。

双屏专项 [38048637180](https://github.com/engcapa/taomni/actions/runs/38048637180)，提交 `6b5368cfb9bc32b309f0d30d8c97c11fdf63b244`：X11 与 GNOME Wayland 各 1/1 通过。两个输出的持续区域流、6 次公共入口/选择器整屏图、2 次原生拖选剪贴板裁剪均与独立原图零误差匹配；主窗口两次均恢复到调用屏。Wayland 第二屏原图为 2560×1440，遮罩和 WebView 为 1280×720、DPR=2，剪贴板选区为 768×512。汇总校验原始 summary、receipt、selection、构建和源码身份，失败、跳过、基础设施错误及能力缺口均为 0。

三端完整截图回归 [38048894575](https://github.com/engcapa/taomni/actions/runs/38048894575)，同一提交：**148/148 通过**。按本轮 invocation `5e571452e2cf4977a6f1878a3899cd01` 收集 7 组原始 artifacts，不混用下载目录中保留的旧轮报告；汇总校验 summary 哈希、签名 receipt、selection、case、runner、构建及源码身份。失败、跳过、基础设施错误、声明的能力缺口及未审查用例均为 0。独立汇总报告为 `D:/qa-n693/aggregate-final/ci-summary.json`。

| 平台与模式 | 实际通过 |
| --- | ---: |
| Windows browser | 39/39 |
| macOS browser | 39/39 |
| Linux browser | 39/39 |
| Windows native | 8/8 |
| macOS native | 7/7 |
| Linux X11 native | 8/8 |
| Ubuntu 26.04 GNOME Wayland native | 8/8 |

原有滚动截图、编辑窗口缩放、独立贴图设置窗口、Done 覆盖/新建/仅复制及系统剪贴板场景均包含在本轮回归中。状态：修复与 OS 虚拟双输出原生验收完成；物理硬件验收仍待执行。不能把 schema/audit 或 fixture 配置请求当作通过证据。

本机 Win11 解锁后执行 `TC-SHOT-N10/N11/N12/N16/N17/N20/N21/N22`，8/8 通过；报告为 `D:/qa-n693/runs/run-20261010-200128-961794200/summary.json`。对应 `status --gate` 接受原始报告，未满足检查和拒绝报告均为 0。QA 应用标识 `com.taomni.app.qa`；构建、执行源码身份均为 `b349911d872c2e9f75d51c56dfe4bbf9b1abb11d7ccaaa3bd7b67c7ae44d8824`，运行器身份为 `b7904df9c2bcdca2284b6477185da4da39531c7323f0c01d5f682497ea41b705`。本机只有单屏，此结果不计为双屏硬件验收。此前锁屏和长路径清理失败的记录保留，不用于通过结论。

本机 QA 二进制：`D:/code/person/taomni-fix-screenshop-autoscroll-20261010/src-tauri/target/qa-ui-auto/debug/taomni.exe`，SHA-256 为 `82f70142c4bf962a1bcd9e28731ca84ecb1132f9a1c127e9a2c64588e03afe81`。目录通过共享 target 的 junction 解析到 `D:/code/person/taomni/src-tauri/target/qa-ui-auto/debug/taomni.exe`，本轮隔离记录的哈希一致。测试仅运行 QA 进程和独立存储，安装版应用未停止。用例目录 `audit --gate`、development case contract、Wayland 工具 17 项单元测试及本机构建均通过。

## 物理双屏验收边界

本机 Win11 当前没有扩展屏。Runner 的 OS 虚拟双输出能验证 GDK、portal、Mutter、WebView、剪贴板及 DPI 坐标链路，不能证明实体显示器热插拔、显卡驱动和真实设备组合。物理硬件验收仍需有双屏的 Ubuntu 桌面：100%/100%、100%/200%，外屏放右侧及负坐标左侧；每屏分别触发截图、切换、拖选复制、取消，并验证主窗口未迁移。未取得这份证据前不关闭 issue 或声称物理验收完成。

硬件执行时保留以下记录，当前各项均待执行：

| 环境 | 布局 / 缩放 | 验收动作与证据 |
| --- | --- | --- |
| Ubuntu 24.04.4 / GNOME Wayland | 外屏右侧，100% / 100% | 两屏分别调用截图；选择器往返；每屏拖选 Copy / Cancel；保留显示设置、遮罩照片和剪贴板 PNG |
| Ubuntu 24.04.4 / GNOME Wayland | 外屏右侧，100% / 200% | 重复上述动作；检查每屏原图物理尺寸及相同逻辑选区的 1× / 2× 像素尺寸 |
| Ubuntu 24.04.4 / GNOME Wayland | 外屏左侧负坐标，100% / 200% | 重复上述动作，确认左屏无遮挡、无偏移、未误截右屏 |
| Ubuntu 24.04.4 / X11 | 外屏左右各一次，100% / 100% | 两屏分别触发、切换、拖选复制与取消；保留 RandR 拓扑和 PNG |

同时记录测试 commit、系统版本、会话类型、显卡驱动、显示器型号与分辨率。Wayland 授权选择目标屏或全部屏；主动拒绝、只分享另一屏时应返回明确错误并恢复应用。拔下外屏后失效显示器应报不可用，不能悄悄复制另一屏。物理机器结果与 runner 虚拟输出结果分别归档。
