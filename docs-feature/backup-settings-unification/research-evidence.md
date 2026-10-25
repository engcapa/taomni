# Backup 整合设计：本轮调研与已执行检查

## 基线与边界

- 日期：2026-10-25；Windows / PowerShell。
- Git HEAD：`65a822785a86c52671983076cd0a244c59626260`。
- 首次 `git status --short` 无输出；本轮只增加本专题设计/图稿/报告截图，未修改产品源码、真实配置、备份文件或 GitHub 状态。
- 实际工具：Node `v24.21.0`、pnpm `12.4.1`、Vitest `4.1.11`。仓库要求 Node 22/pnpm 10；本轮结果仅作为源码调研的既有快速基线，产品实施收尾应按要求工具链执行。

## 已执行前端基线

工作目录：工程根目录。

```powershell
pnpm exec vitest run src/stores/backupStore.test.ts src/components/settings/BackupSettingsPanel.test.tsx src/components/settings/RemoteBackupPanel.test.tsx
```

工具输出摘要：

```text
Test Files  3 passed (3)
     Tests  28 passed (28)
  Duration  2.21s
```

进程退出码 0。Vite 提示当前配置使用 `__dirname`，未来 native config loader 不支持；本次检查仍正常完成，没有修改无关配置。

这些测试证明既有 store 保存队列/迟到读取、现有组件调用、原生连接 UI 的已有 mock 场景。**没有覆盖**新要求的全局 full 重开/重启、继承/覆盖执行解析、跨目标活动授权可达性、删除授权任务、真实配置落盘/网络停止和 `.taobak` 三类历史兼容。后者均在设计中标为待实现/待验证。

## 源码事实

- `BackupSettingsPanel` 的手工 scope/includeMail 是临时 useState，未绑定 BackupPolicy，因此重挂载会回 core/false。
- `RemoteBackupPanel` 另有 batchScope/batchIncludeMail；云 target.source 独立；现有 batch 仅把外部 scope 传本地。
- `engine::resolve_scope_flags` 的 full 默认为 core+聊天+邮件，邮件可被显式 false 覆盖；full 的 local_history 沿用 false。
- manifest formatVersion=1；加密读取接受 `TAOBAK_ENC_V1`、`TAOBAK_ENC_V2`，这不是本次新定义的版本。
- 外层设置是现有分组/搜索/定位模型，不应因 Backup 改版替换为新的侧栏或独立页面。
- 当前 locale 文件为 `src/lib/i18n/locales/en.ts` 与 `zh-CN.ts`；复用 useT/getLocale，不新建并行国际化系统。

## GitHub #714

通过本机 `gh` 的已登录 keyring 访问，实际账号 `engcapa`。仅本次命令进程显式设置 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 到用户指定代理；没有输出明文 token、改全局 Git 配置或重新登录。

```powershell
gh api repos/engcapa/taomni/issues/714 --jq '{number,title,state,html_url,created_at,updated_at,body,user:.user.login,labels:[.labels[].name],comments}'
gh api repos/engcapa/taomni/issues/714/comments --paginate --jq '.[] | {id,user:.user.login,created_at,updated_at,body}'
```

- 状态 open、评论 0；创建于 2026-10-12，报告者 ganwenlong。
- 正文为个人/企业飞书浏览器账号混用后无法终止进行中的授权，希望删除任务。
- 附件通过相同代理成功读取（HTTP 200，JPEG，228625 bytes），保存于 [原报告截图](../../docs-issue/714-feishu-authorization/issue-reported.jpg)。
- 截图是报告者的实际证据；本轮未用真实账号重现。源码中“仅当前目标的会话可取消”与截图“新目标+忙碌但无取消”一致，原生复现与回归仍待执行。

## 图稿与反馈

- 使用 drawio 原生 XML 与本机 draw.io Desktop 导出 PNG；保留可编辑 `.drawio`。
- 用户在异步问题中选择“采用这版布局（推荐）”，确认全局置顶、渠道同页折叠、手工只显示全局范围、活动授权独立提示。
- 随后明确约束：只动 Backup，设置整体结构不动，注意多语言，备份文件格式不变且兼容旧备份。
- V2 因此删除 V1 的外围设置侧栏示意，只显示 Backup 内容，并增加英文总览。当前有效产物为 `overview-v2`、`overview-en-v2`、`channel-expanded-v2`、`authorization-recovery-v2` 的 PNG 与 draw.io 源。
- V1 已被 V2 替代；内部布局沿用用户决定。图稿渲染/反馈不构成产品实现或原生验收证据。

## 未执行项目

未修改或构建产品；未运行真实 Tauri、访问真实飞书账号、创建/取消真实授权、下载/恢复用户备份、迁移真实配置或验证其他平台。为避免把设计交付当产品完成，以上全部保持未验证；实际工作包、自动化与当前 Windows 真机步骤见主设计和 #714 修复设计。
