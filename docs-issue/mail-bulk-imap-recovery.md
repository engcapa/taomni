# 邮件批量操作数量限制与安全续做

日期：2026-10-18。基线：`9932869b633f2c2867e428d26a93861b674c1cfb`。

## 问题与复现

普通删除使用移动到 Trash。旧前端每 250 封分组，后端将整组 UID 发给
MOVE；任意 MOVE 错误均降级为 COPY、标记删除、EXPUNGE。服务器不支持
MOVE 且限制单次 COPY 数量时，选择 200 封会收到
`COPY copy mail count over limit (after MOVE error: Could not parse command)`。
`No Response` 是 imap crate 对协议 NO 响应的显示，不是网络无响应。

本机 loopback IMAP 禁用 MOVE、设置 COPY 上限 20 封后，新增的
`moving_200_messages_adapts_to_provider_copy_count_limit` 在旧实现上失败，
错误与截图一致。原始失败日志保留在
`qa-ui-auto-report/_local/mail-bulk-baseline.log`。

## 实现与保留行为

- 后端 `mail/mutations.rs` 共用移动、复制和永久删除执行器，初始每批 50
  封，同时限制命令长度。明确的数量/命令长度拒绝会将当前批次减半到最小
  一封；认证、配额、其他服务端拒绝及不明确的网络错误不会伪装成数量限制。
- 查询 MOVE/UIDPLUS 能力，执行过程中复用能力结果，续做时重新查询。
  未提供 MOVE 时使用 COPY 路径；普通 MOVE 业务错误不会转成 COPY。
- 在独立邮件 SQLite 中持久化请求 ID、服务器身份、源文件夹 UIDVALIDITY、
  所选 UID、批次大小及每封的执行阶段。发送 COPY/MOVE 前先写入待核实状态；
  已确认 COPY 后续 STORE/UID EXPUNGE 失败，可从相应阶段继续，不再次 COPY。
  相同请求 ID 的已完成操作可重复取回结果；新的明确复制动作可使用新 ID。
- 禁止连接池自动重放整个非幂等操作。COPY 响应丢失后保留待核实状态并
  阻止重复提交；MOVE 待核实时可查询源 UID 是否已经消失，不能证明完成的
  UID 保持待核实。UIDVALIDITY 改变时不对新一代 UID 执行旧请求。
- 只使用 UID EXPUNGE。缺少 UIDPLUS 时报告已复制/已标记但待清理的状态，
  不退回整个文件夹的 EXPUNGE；恢复 UIDPLUS 后可继续定向清理。
- 每批完成的邮件在保存执行记录的同一 SQLite 事务中移除源缓存；部分成功
  会返回确切 UID。过滤规则消费部分结果并报告失败，不再将整个请求计为成功。
- 前端移动、复制、删除按 50 封更新进度，标记操作保持原有 250 封分组。
  重试保留原请求 ID、跳过已完成请求，只应用新增完成 UID，失败项仍选中。
  已读/正文加载的共用状态更新不能覆盖操作错误、Retry remaining 和 Details。
- 保留普通删除移入垃圾箱、永久删除确认/取消、跨文件夹搜索选择、拖拽移动/
  复制、过滤规则、整文件夹已读与删除并行等原有工作流。

网络连接继续使用已有邮件会话代理解析；没有新增下载或外部服务。
所有故障注入、服务器账号及邮件数据库均使用临时测试数据。

## 验证范围

新增 `TC-MAIL-BULK-02`：browser 与 native 选择 200 封，在服务端每次最多 25
封且完成首批后失败的条件下，验证 25/200 进度、175 封剩余选择、详情及续做，
最终源文件夹为 0、Trash 恰好为 200。

新增 `TC-MAIL-BULK-03`：native 验证 COPY 后 STORE 失败续做、成功 COPY
响应丢失后的重复点击保护、UIDPLUS 缺失及恢复，以及保留其他已标记删除的
哨兵邮件；独立协议检查拒绝重复 COPY 和普通 EXPUNGE。

保留用例：`TC-MAIL-BULK-01`、`TC-MAIL-DRAG-01`（browser）及
`TC-MAIL-FILTER-01`。新增用例已加入 CI policy/dependencies，并同步 controls、
testid catalog、故障注入 verb 的 schema、browser/native 实现和协议测试。

具体本机执行结果、构建身份、截图和限制记录于
`qa-ui-auto-tests/evidence/mail-bulk-imap-recovery-win11-20261018.md`。
