# Windows 更新后首次启动的路径与粘贴

用户报告在部分 Windows 机器上，应用内升级完成后自动启动，部分路径和快捷键失效，手动退出并打开后恢复。问题早于 Tao Notepad，近期可见的例子是编辑器里的 Ctrl+V。用户在 Linux 和 macOS 上未遇到相同现象。基线为 `284ac1056`，分支为 `fix/windows-update-relaunch-context`。

## 复现环境与判据

本机为 Windows x64 26H2，build 26300.10075，WebView2 158.0.4370.33。单独打包同一份 Taomni 生产前端和 Rust 后端，使用独立产品名、安装目录、应用标识、回环更新地址和本轮签名密钥，保留 Tauri updater 签名验证、NSIS 被动安装和自动启动。测试包 `0.5.101`、`0.5.102`、`0.5.103` 是实验版本号。专用安装包只运行 DLL 复制钩子，避免对本机其他应用的 SocksCap 进程和服务执行清理。原始收据保存在 `qa-ui-auto-report/windows-update-paste/`。

| ID | 方法及应观察的结果 |
|---|---|
| V-01 | 原应用打开 About，点击检查更新和下载安装。记录安装前、自动启动、手工再启动的 PID、安装文件 SHA-256、工作目录、完整性级别、PATH 摘要、Git 可发现性。让旧进程模拟尚未取得桌面最新 Git 路径的环境，桌面用户的 PATH 保持原值。比较同一新版程序的两次启动。 |
| V-02 | 应用取得前台后，以 Windows 原生接口写入 CF_UNICODETEXT，再向该窗口发送 Ctrl+V。记录独立回读、编辑器行内容和页面异常。单行、LF、CRLF 分开执行。 |
| V-03 | 在真实 CodeMirror EditorState 上执行 Notepad 的命令，核对文末、替换选区、非 BMP 字符、结尾换行及多个选区的结果。 |
| V-04 | Browser `TC-NP-104/106` 验证快捷键、菜单、特殊粘贴及输入位置。Native `TC-NP-103/105/107` 通过真实剪贴板、进程重启、另存为和独立读盘验证保存目录和内容。 |

## 源码与已复现的失效条件

Tauri updater 2.11.0 在 Windows 运行签名校验通过的安装包，再退出旧进程。NSIS 的被动安装在成功回调中处理 `/R` 并通过 `nsis_tauri_utils::RunAsUser` 启动新映像。Windows 自动重启发生在安装器，前端的 `relaunchApp` 仅能在旧进程仍存在时运行。用户尚未指明确切失效路径，V-01 使用真实可执行文件作为区分性探针。

在独立安装的修复前 Taomni 中，单行和 LF 均粘贴成功。相同焦点下，包含 CRLF 的两行文本令编辑器保持空白并抛出 `Selection points outside of document`。源头为 `coreCommands.ts` 中的 `sel.from + txt.length`。CodeMirror 将 CRLF 表示成一个换行位置，原始字符串长度却将它算作两个。位于文档中段时，光标也可能落进后续文本。原实现只改主选区，真实状态测试同时复现了第二个选区没有被替换。原设计 AC-19 要求多光标可同时粘贴。这个缺陷在升级前的进程中也能触发。

## 决策、工作包与验收

| ID | 决定与依据 | 工作包与验收 |
|---|---|---|
| DEC-01 | 用户要求只修复本机复现并有源码解释的缺陷。用同一新版程序的手动启动作对照，保留未能归因的反馈。 | TASK-01 负责真实升级对照，AC-01 要求记录在 V-01 中能区分的启动差异和系统副作用。 |
| DEC-02 | 采用 CodeMirror 的 `state.replaceSelection`，由文档模型计算换行和全部选区位置。普通粘贴、特殊粘贴、剪贴板历史的插入入口都曾按原字符串长度定位光标。沿用原有系统剪贴板读取、快捷键映射和只读检查。 | TASK-02 修改 `actions/coreCommands.ts`、`NotepadEditor.tsx`、`useNotepadActions.ts`。AC-02 要求 Ctrl+V 或 macOS Cmd+V 在可编辑选区内插入一次并能继续输入，AC-03 要求各选区内容正确。V-02、V-03、V-04。 |
| DEC-03 | 用户指定 Windows 本机验证，Linux/macOS 运行 GitHub browser/native。桌面重启用例检验同一配置下的持久化，安装器自动启动另由 Windows 包测试覆盖。 | TASK-03 扩充 unit 和 YAML、登记 CI，AC-04 要求读取真实保存文件并在新进程验证上次保存目录。V-01、V-04。 |

## 验证记录

- `initial.json` 对应独立安装的修复前程序，三组系统剪贴板实测中仅 CRLF 触发异常。`unit-before.log` 记录 7 项通过、CRLF 文末和多选区 2 项失败。
- 修复后本机首轮 Notepad、共享剪贴板及更新 service/store 的 6 个单测文件共 72 项通过。`unit.log`、`refactor.log` 保留输出。
