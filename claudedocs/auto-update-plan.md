# Taomni 自动化升级方案

> **状态:** 代码已实施(待人工配置签名密钥与 GitHub Secrets,见 §6)
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
| 安装行为 | **始终需用户显式确认**(启动静默检查 + About 手动检查;检测到新版**仅提示**,不确认则**不下载、不安装、不重启**) |
| 安装包/架构选择 | **允许用户选择架构产物**(macOS:arm64 / x86_64;依当前运行架构与 Rosetta 状态给出"推荐"与可运行候选,默认选中当前架构) |
| OS 代码签名 | **本期不做**,后续单独推进(仅做 updater 必需的 minisign 验签) |

**目标:** 已安装客户端能发现新版本 → 提示用户 → 用户确认(并可选架构)→ 下载验签 → 安装 → 用户确认后重启。

## 3. 更新链路总览

```
客户端启动(延迟 3-5s) → 静默 check()(原生架构)拉取 latest.json(GitHub Release)
  → 比对 version → 有新版则【仅提示】(更新对话框:新版本号 + 更新说明),不自动下载
  → 用户在对话框内选择安装包架构(默认 = 当前运行架构;macOS 另可选 arm64/x86_64)
  → 用户点「下载并安装」(✅ 确认门 #1) → check({ target }) 取所选架构产物
  → 下载更新包(minisign 验签)→ 安装
  → 用户点「立即重启」(✅ 确认门 #2) → relaunch() 重启到新版本
（未点确认 ⇒ 不下载;已安装未重启 ⇒ 下次启动生效）
```

> **两道确认门**:① 下载/安装前必须用户点击,启动检测只"提示"不"动手";② 安装完成后不自动重启,由用户决定何时重启。
> **架构选择**:`check({ target })` 的 `target` 即 `latest.json` `platforms` 的 key(如 `darwin-x86_64`)。已核实 Tauri v2 updater JS `CheckOptions.target?: string` 支持按调用覆盖目标平台,因此无需自建下载器,仍由插件完成下载/验签/安装。

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

### 4.5.1 架构探测命令(支撑"用户选择安装包")`src-tauri/src/update.rs`(新增,极小)

前端需要知道:当前 OS、当前运行二进制对应的 updater target key、推荐产物,以及**本机能实际运行**的候选产物(避免在 Intel Mac 上把只能跑在 Apple Silicon 的 arm64 包列出来)。新增一个应用自有命令返回这些信息;**应用自有命令不走 capability ACL,无需改 `default.json`**(与现有 ~190 个命令一致),在 `lib.rs` 的 `invoke_handler` 注册即可。

```rust
#[derive(serde::Serialize)]
pub struct UpdaterPlatform {
    pub os: String,                 // "darwin" | "windows" | "linux"
    pub native_target: String,      // 当前二进制的 updater key,如 "darwin-aarch64"
    pub recommended_target: String, // 建议安装(原生优先),如 "darwin-aarch64"
    pub candidates: Vec<String>,    // 可在本机运行、供用户选择的产物
    pub is_rosetta: bool,           // macOS:x86_64 二进制是否跑在 Apple Silicon(Rosetta)
}

#[tauri::command]
pub fn updater_platform() -> UpdaterPlatform { /* 见下决策表 */ }
```

target key 规则:`{os}-{arch}`,`os ∈ {darwin, windows, linux}`,`arch` 取 `std::env::consts::ARCH`(我方仅发 `x86_64`/`aarch64`,与 updater key 完全一致;未来 32 位/armv7 需单独映射)。候选与推荐按下表(macOS 借 `sysctlbyname("sysctl.proc_translated")` 判定 Rosetta:返回 1=Rosetta、0=原生、ENOENT=Intel):

| 运行环境(二进制 arch + 硬件) | candidates | recommended | native | is_rosetta |
|------|------|------|------|------|
| Apple Silicon 原生(arm64 二进制) | `darwin-aarch64`, `darwin-x86_64` | `darwin-aarch64` | `darwin-aarch64` | false |
| Apple Silicon 跑 x86_64(Rosetta) | `darwin-aarch64`, `darwin-x86_64` | `darwin-aarch64`(提示可切原生) | `darwin-x86_64` | true |
| Intel Mac(x86_64) | `darwin-x86_64` | `darwin-x86_64` | `darwin-x86_64` | false |
| Windows x86_64 | `windows-x86_64` | 同 native | `windows-x86_64` | false |
| Linux x86_64 | `linux-x86_64` | 同 native | `linux-x86_64` | false |

> `candidates.len() == 1` 时前端不显示选择器。跨架构验签无额外成本:`check({ target })` 取对应条目自带的 `.sig`,插件用同一 pubkey 验签。macOS 上"切换到原生 arm64"= 下载 arm64 `.app.tar.gz` 替换当前 bundle 后 `relaunch()`,可正常工作。

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

- 新增 `src/lib/updateService.ts`,用 `isTauriRuntime()` 守卫(dev 模式全部 no-op,`getPlatform()` 返回单候选、`check()` 返回"无更新"):
  - `getPlatform()` → `invoke('updater_platform')`,得到 os/native/recommended/candidates/is_rosetta。
  - `check(target?)` → `check(target ? { target } : undefined)`;按 `target` 缓存返回的 `Update`(避免同一架构重复网络请求),返回 `{ version, notes } | null`。
  - `downloadAndInstall(target, onProgress)` → 取缓存或新 `check({ target })` 得到 `Update` → `update.downloadAndInstall(onProgress)`。
  - `relaunch()` → `@tauri-apps/plugin-process` 的 `relaunch()`。
- 新增 `src/stores/updateStore.ts`:Zustand 状态机
  `idle | checking | available | downloading(progress%) | ready | error | uptodate`,并保存:可用版本号、更新说明、错误信息;以及架构选择相关 —
  `candidates / nativeTarget / recommendedTarget / isRosetta / selectedTarget`,和"所选架构在此版本是否可用"的校验态(`targetStatus: unknown | checking | ok | unavailable`)。
  - `selectedTarget` 默认 = `recommendedTarget`。
  - 切换 `selectedTarget` 时调 `check({ target })`:返回 null ⇒ `targetStatus = unavailable`(该架构无此版本),否则 `ok`。
- 启动检查:`MainLayout` mount 后延迟 3-5s,先 `getPlatform()` 再静默 `check()`(原生架构),仅在有新版时把状态置 `available`(只提示、不下载)。

### 4.8 前端 UI

- 改 `src/components/AboutDialog.tsx`:加"检查更新"按钮 + 当前状态文案。
- 新增 `src/components/UpdateDialog.tsx`,自上而下:
  1. 新版本号 + 更新说明(`notes`)。
  2. **安装包/架构选择器**(仅 `candidates.length > 1` 时显示,默认选中 `recommendedTarget`):
     - 列出候选架构(如 macOS 的 `arm64` / `x86_64`),标注"当前架构""推荐(原生)"。
     - `isRosetta` 时显示一行提示:当前运行于 Rosetta(x86_64),建议切换到原生 arm64。
     - 切换时按 `targetStatus` 显示校验态:`checking`→禁用确认按钮;`unavailable`→提示"该架构暂无此版本"并禁用确认。
  3. **✅ 确认门 #1**:`下载并安装` 按钮(点击前不发生任何下载/安装)。
  4. 下载进度条(`downloading`)。
  5. **✅ 确认门 #2**:`ready` 后显示 `立即重启` / `稍后`(`稍后`仅关闭对话框,更新已就绪,下次启动生效)。
  - 平台差异备注:Windows `installMode: passive` 安装器自身会关闭并拉起新版本,`relaunch()` 行为以插件实际为准;macOS/Linux 走 `process.relaunch()`。
- i18n:`src/lib/i18n/locales/en.ts`、`zh-CN.ts` 增加 `update.*` 文案 —
  状态类(检查中/有新版/下载中/已就绪/失败/已是最新)+ 架构选择类(`update.arch.title`、`update.arch.current`、`update.arch.recommended`、`update.arch.rosettaHint`、`update.arch.unavailable`)+ 按钮(`update.downloadAndInstall`、`update.restartNow`、`update.later`)。

### 4.9 测试

- `src/stores/updateStore.test.ts`:状态流转单测,含 `selectedTarget` 切换、`targetStatus` 校验(ok/unavailable)、默认选中 `recommendedTarget`。
- `updateService` mock 插件 API 的单测:`check(target)` 透传 `{ target }`、按 target 缓存 `Update`、dev 模式 no-op。
- `updater_platform` 命令的 Rust 单测:各 arch/Rosetta 分支下 candidates/recommended/native 正确。
- 手动端到端:构建 v0.2.14 → 在装有"带 updater 的旧版"机器上跑完整链路;**额外在 Apple Silicon 上验证 arm64↔x86_64 两种选择各自下载到正确产物并能重启**。

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

- [ ] 旧版(带 updater)客户端启动后能静默检出新版本并弹窗,**仅提示、不自动下载**。
- [ ] About 弹窗"检查更新"按钮可手动触发,状态正确。
- [ ] **未点「下载并安装」前不发生任何下载/安装;安装完成后不自动重启,由用户点「立即重启」触发。**
- [ ] **macOS 上出现架构选择器,默认选中当前架构;选 arm64 / x86_64 分别下载到对应产物并能正确安装重启;Rosetta 下提示可切换原生。**
- [ ] 单候选平台(当前 win-x64 / linux-x64)不显示选择器,流程不受影响。
- [ ] 用户确认后能下载(进度可见)、验签通过、安装并重启到新版本。
- [ ] 四个平台(win-x64 / mac-arm64 / mac-x64 / linux-x64)的 `latest.json` 条目与签名齐全。
- [ ] dev 模式(`pnpm dev`)下不报错,检查更新 no-op。
- [ ] `pnpm build` 与 `pnpm test` 通过。

## 9. 涉及文件清单

**修改:** `src-tauri/Cargo.toml`、`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/default.json`、`src-tauri/src/lib.rs`、`.github/workflows/release.yml`、`src/components/AboutDialog.tsx`、`src/layouts/MainLayout.tsx`、`src/lib/i18n/locales/en.ts`、`src/lib/i18n/locales/zh-CN.ts`

**新增:** `src-tauri/src/update.rs`(架构探测命令)、`src/lib/updateService.ts`、`src/stores/updateStore.ts`、`src/components/UpdateDialog.tsx`、`src/stores/updateStore.test.ts`

