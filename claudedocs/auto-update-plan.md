# Taomni 自动化升级方案

> **状态:** 待执行(方案已确认)
> **创建日期:** 2026-06-13
> **关联 roadmap 项:** "Auto-update via `tauri-plugin-updater`" / 代码签名 / 灰度发布

## 1. 背景与现状

- **当前无任何自动更新机制**:`tauri-plugin-updater` 未引入(`Cargo.toml` / `package.json` 均无),`tauri.conf.json` 无 updater 配置。
- **发布流水线已就绪**:`.github/workflows/release.yml` 使用 `tauri-apps/tauri-action@action-v0.6.2`,push `v<version>` tag 即跨平台构建并上传 GitHub Release。
- **版本约定**:应用版本在根 `package.json`(当前 `0.2.13`);`tauri.conf.json` 通过 `"version": "../package.json"` 读取;`Cargo.toml` 是独立的 Rust crate 版本。
- **UI 落点现成**:`src/components/AboutDialog.tsx` 用 `__APP_VERSION__` 显示版本,是"检查更新"的天然位置;插件在 `src-tauri/src/lib.rs` 的 Builder 链注册;权限在 `src-tauri/capabilities/default.json`。
- **运行时判定**:`src/lib/runtime.ts` 的 `isTauriRuntime()` 可用于 dev 模式守卫。
- **仓库:** `engcapa/taomni`,发布 tag 形如 `v0.2.13`。

## 2. 目标与边界(已确认决策)

| 决策点 | 选择 |
|--------|------|
| 分发端点 | **GitHub Releases**(复用现有流水线,`tauri-action` 生成并上传 `latest.json`) |
| 安装行为 | **提示并由用户确认**(启动静默检查 + About 手动检查 + 弹窗确认后下载安装重启) |
| OS 代码签名 | **本期不做**,后续单独推进(仅做 updater 必需的 minisign 验签) |

**目标:** 已安装客户端能发现新版本 → 提示用户 → 下载验签 → 安装重启。

## 3. 更新链路总览

```
客户端启动(延迟 3-5s) → 拉取 latest.json(GitHub Release)
  → 比对 version → 有新版则弹更新对话框(新版本号 + 更新说明)
  → 用户确认 → 下载更新包(minisign 验签)→ 安装 → 重启应用
```

`latest.json`(Tauri v2 格式)示例:

```json
{
  "version": "0.2.14",
  "notes": "本次更新说明",
  "pub_date": "2026-06-13T00:00:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "<minisign>", "url": "https://github.com/.../Taomni_0.2.14_x64-setup.nsis.zip" },
    "darwin-aarch64": { "signature": "<minisign>", "url": "https://github.com/.../Taomni_aarch64.app.tar.gz" },
    "darwin-x86_64":  { "signature": "<minisign>", "url": "https://github.com/.../Taomni_x64.app.tar.gz" },
    "linux-x86_64":   { "signature": "<minisign>", "url": "https://github.com/.../Taomni_0.2.14_amd64.AppImage.tar.gz" }
  }
}
```

## 4. 实施步骤

### 4.1 依赖

`src-tauri/Cargo.toml`(Tauri 已 2.11.2,匹配 v2 插件):
```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"   # 安装后 relaunch() 需要
```

`package.json`:
```jsonc
"@tauri-apps/plugin-updater": "^2",
"@tauri-apps/plugin-process": "^2"
```

### 4.2 签名密钥(minisign,updater 强制要求)

```bash
pnpm tauri signer generate -w ~/.tauri/taomni-updater.key
```
- **公钥** → 写入 `tauri.conf.json` 的 `plugins.updater.pubkey`
- **私钥 + 密码** → 配成 GitHub Secrets:`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- ⚠️ 私钥务必离线安全备份(见风险章节)

### 4.3 `tauri.conf.json`

```jsonc
"plugins": {
  "updater": {
    "endpoints": [
      "https://github.com/engcapa/taomni/releases/latest/download/latest.json"
    ],
    "pubkey": "<生成的公钥>",
    "windows": { "installMode": "passive" }
  }
},
"bundle": {
  "createUpdaterArtifacts": true
  // ... 现有 targets/icon 不变
}
```

### 4.4 权限 `src-tauri/capabilities/default.json`

在 `permissions` 数组追加:
```jsonc
"updater:default",
"process:allow-restart"
```

### 4.5 后端注册 `src-tauri/src/lib.rs`

在 `tauri::Builder::default()` 链上(无条件,区别于现有 debug-only 的 `tauri_plugin_log`):
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

### 4.6 CI `.github/workflows/release.yml`

- 给 `build` 与 `build-macos` 两个 job 里的 **每个** `tauri-action` step 注入 env:
  ```yaml
  env:
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
  ```
  (与现有 macOS 的 `LIBGSSAPI_*` env 并列)
- `createUpdaterArtifacts: true` 后,`tauri-action` 默认生成并合并 `latest.json`。
- ⚠️ **并行写入竞争**:`build`(linux+windows 矩阵)与 `build-macos` 并行向同一 Release 写 `latest.json`,有覆盖风险。**稳妥方案**:新增一个 `needs: [build, build-macos]` 的收尾 job,从各平台已上传的 `.sig` 重新合成完整 `latest.json` 后覆盖上传。首次发布务必验证四个平台条目齐全。

### 4.7 前端服务层 + store

- 新增 `src/lib/updateService.ts`:封装 `check() / downloadAndInstall(onProgress) / relaunch()`,用 `isTauriRuntime()` 守卫,dev 模式 no-op 返回"无更新"。
- 新增 `src/stores/updateStore.ts`:Zustand 状态机
  `idle | checking | available | downloading(progress%) | ready | error | uptodate`,保存可用版本号、更新说明、错误信息。
- 启动检查:`MainLayout` mount 后延迟 3-5s 调一次静默 `check()`,不阻塞启动。

### 4.8 前端 UI

- 改 `src/components/AboutDialog.tsx`:加"检查更新"按钮 + 当前状态文案。
- 新增 `src/components/UpdateDialog.tsx`:新版本号 + 更新说明 + 下载进度条 + "立即重启安装 / 稍后"。
- i18n:`src/lib/i18n/locales/en.ts`、`zh-CN.ts` 增加 `update.*` 文案(检查中/有新版/下载中/已就绪/失败/已是最新)。

### 4.9 测试

- `src/stores/updateStore.test.ts`:状态流转单测。
- `updateService` mock 插件 API 的单测。
- 手动端到端:构建 v0.2.14 → 在装有"带 updater 的旧版"机器上跑完整链路(检查→确认→下载→重启)。

## 5. 关键注意点与风险

- 🔴 **私钥即生命线**:minisign 私钥丢失 = 之后所有客户端验签失败、无法再推任何更新。必须离线安全备份。
- 🟡 **存量用户断层**:现有 0.2.13 无 updater,无法自动升级。用户需**手动安装一次**带 updater 的版本,之后才进入自动更新链。需在发布说明中告知。
- 🟡 **未签名的代价(本期接受)**:macOS Gatekeeper / Windows SmartScreen 首次安装会警告;更新流程本身可跑通。
- 🟡 **Linux 限制**:updater 仅支持 AppImage(deb/rpm 不支持),需确认产物含 `.AppImage` 及其 `.tar.gz` updater 包。
- 🟡 **CI latest.json 合并**:见 4.6,首次发布必须验证四平台条目齐全且签名正确。

## 6. 需要人工执行的步骤(不可由代码自动完成)

1. 本地运行 `pnpm tauri signer generate` 生成 minisign 密钥对。
2. 把私钥/密码配置为 GitHub 仓库 Secrets。
3. 离线备份私钥。
4. 首次发布带 updater 的版本后,人工验证 Release 中的 `latest.json` 与各平台 `.sig`。

> 其余代码改动(依赖、配置、权限、后端注册、CI env、前端 service/store/UI、i18n、测试)均可由实现阶段完成。

## 7. 灰度发布 / 回滚(后续,非本期)

- GitHub 单一 `latest.json` 难以原生灰度;roadmap 的 5%→25%→100% 需自建分发端点按比例返回不同清单。
- 回滚:可手工编辑 `latest.json` 做版本固定(pin)/指回旧版。
- 标记为后续独立任务,与 OS 代码签名一并推进。

## 8. 验收标准

- [ ] 旧版(带 updater)客户端启动后能静默检出新版本并弹窗。
- [ ] About 弹窗"检查更新"按钮可手动触发,状态正确。
- [ ] 用户确认后能下载(进度可见)、验签通过、安装并重启到新版本。
- [ ] 四个平台(win-x64 / mac-arm64 / mac-x64 / linux-x64)的 `latest.json` 条目与签名齐全。
- [ ] dev 模式(`pnpm dev`)下不报错,检查更新 no-op。
- [ ] `pnpm build` 与 `pnpm test` 通过。

## 9. 涉及文件清单

**修改:** `src-tauri/Cargo.toml`、`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json`、`src-tauri/src/lib.rs`、`.github/workflows/release.yml`、`src/components/AboutDialog.tsx`、`src/layouts/MainLayout.tsx`、`src/lib/i18n/locales/en.ts`、`src/lib/i18n/locales/zh-CN.ts`

**新增:** `src/lib/updateService.ts`、`src/stores/updateStore.ts`、`src/components/UpdateDialog.tsx`、`src/stores/updateStore.test.ts`

