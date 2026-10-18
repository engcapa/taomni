# 邮件批量 IMAP 操作 — Windows 11 本机验证

日期：2026-10-18。Windows 11 Pro 10.0.26300；WebView2 / EdgeDriver
155.0.4283.60；Node 22.23.3、pnpm 10.34.7、Rust 1.96.0。
原生应用为独立 `com.taomni.app.qa`，Rust debug + 生产前端。
没有使用个人邮箱、个人邮件目录或生产应用数据。

## 最终结果

| 检查 | 结果 | 本机原始证据 |
| --- | --- | --- |
| MailClientTab、mailMutations、mailFilters、MailFiltersPanel Vitest | 75 passed | `qa-ui-auto-report/_local/mail-bulk-unit-final.log` |
| Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib mail:: -- --test-threads=4` | 153 passed；1 个原有真实 Outlook 凭据用例 ignored | `qa-ui-auto-report/_local/mail-bulk-rust-final.log` |
| Python loopback 邮件服务 unittest | 15 passed | `qa-ui-auto-report/_local/mail-bulk-qa-unit.log` |
| Browser BULK-01、BULK-02、DRAG-01、FILTER-01 | 4 passed，0 failed，0 skipped | `qa-ui-auto-report/mail-bulk-browser/run-20261018-185621-802929600/summary.json` |
| Native BULK-01、BULK-02、BULK-03、FILTER-01 | 4 passed，0 failed，0 skipped | `D:/qa-mail-bulk/run-20261018-190113-147570100/summary.json` |
| QA 构建（含 TypeScript 检查、Vite、原生编译） | passed；构建耗时 182.02 秒 | `qa-ui-auto-report/_local/mail-bulk-native-build.log` |
| QA audit / CI selected plan / Windows current execution gate | passed | `qa-ui-auto-report/_local/mail-bulk-audit.json`、`mail-bulk-ci-plan.json`、`mail-bulk-status.json` |
| 所有改动 Rust 文件 rustfmt / git diff whitespace | passed | `rustfmt --check --edition 2024 --config skip_children=true ...`、`git diff --check` |

Browser 与 native 的 source identity 均为
`df304bcae8e53051b93e54159057744de9fa21ef6dbf90a030a3acd76b07a0b1`，
执行期间 `identity_stable=true`；相邻 `runner_receipt.json` 均存在且通过
current execution gate。QA 二进制 SHA-256：
`a879d393340aaa1c050a519c734636242a92ccc5b4e9271457cec77d14491b46`。

## 实际断言与图像检查

- 200 封选择、服务端 COPY 上限 25：首批后故障，保留 175 封选择、显示
  25/200，并可打开原始错误详情；Retry 后源文件夹 0、Trash 恰好 200。
- COPY 成功后 STORE 失败：恢复后只完成剩余阶段，服务端没有重复副本。
- 成功 COPY 的响应被丢弃：显示结果待核实，不提供自动重试复制入口；再次
  点击 Delete selected 也不会发送第二次 COPY。
- UIDPLUS 缺失：报告待清理，不发送普通 EXPUNGE；恢复 UIDPLUS 后定向
  删除所选的 3 封，保留另外一封已标记删除的哨兵邮件。
- 原生协议 oracle 检查不支持 MOVE 时不发送 MOVE、COPY 源 UID 不重复、
  所有场景均无普通 EXPUNGE。服务端计数独立于前端状态和 SQLite 缓存。
- 保留普通/永久删除、确认取消、已读进行中删除、搜索选择、拖拽移动/复制、
  过滤规则等回归；新增 empty-folder 请求 ID 快照测试确保重复请求不删除后来
  到达的邮件。
- 已查看 browser 的 partial 截图，以及 native 的 complete、sentinel-preserved
  截图：进度、剩余选择、重试和详情按钮可见；选中邮件完成后界面没有恢复旧行。

图片位于上述报告目录各 case 子目录。原生 BULK-03 同时保留
`mail-bulk-store-failed.png`、`mail-bulk-uncertain-copy.png`、
`mail-bulk-no-uidplus.png` 和 `mail-bulk-sentinel-preserved.png`。

## 保留的失败与边界

- 改前真实 TCP 协议回归失败已保留：`mail-bulk-baseline.log`，与截图中的
  MOVE 不支持、COPY 数量超限组合一致。
- 首轮 browser BULK-02 暴露了正文加载清除错误、隐藏重试入口的问题；实现
  改为独立保存操作失败状态，并增加挂载回归。首轮失败截图/HTML/trace 保留在
  `run-20261018-185303-285523300`，最终四条用例全部重新执行通过。
- 首轮邮件 Rust 全量测试在已有数据库锁测试的初始化等待阶段超时（等待锁
  持有线程启动，不是产品响应时间断言）。新增测试 runtime 限为一个工作线程，
  最终邮件套件使用 4 个测试线程通过；没有增加原有时间预算或删除断言。
- 全仓库 `cargo fmt --check` 仍报告未改动文件的既有格式差异，例如
  `src-tauri/src/bin/sockscap-helper/capture.rs`。完整输出保留于
  `mail-bulk-repository-fmt.log`；本次改动的全部 Rust 文件单独检查通过。
- 原生测试服务在客户端断开 IDLE 时打印连接重置；外置报告目录的 receipt
  辅助工具打印 Git-discovery warning。所有四条 native 用例和执行身份检查
  均通过；报告和收据未被修改以消除这些输出。
- 真实 Outlook 账号测试需要外部凭据并默认忽略；没有将它计入通过数。
  Linux/macOS 和外部邮件提供商互操作未在本次 Windows 本机验证中执行。
  COPY 结果无法确定时，客户端选择保留待核实状态，不声称已经完成，也不
  自动猜测目标副本并重发。
