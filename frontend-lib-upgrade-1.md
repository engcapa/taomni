# Taomni 前端依赖升级计划

## Context

对 `package.json` 中的前端依赖和开发依赖进行全面升级。当前构建工具（Vite 5）、框架核心（React 18）及样式框架（Tailwind v3）落后较多版本。本次升级旨在提升打包与运行效率（利用 Vite 8 & Tailwind v4）、引入现代 React 19 功能（Actions 等），并消除技术债。升级按照风险和复杂度分 5 个批次执行。

### 关键前置约束

1. **Tailwind CSS v4 迁移**：v4 改为 CSS-first 架构，废弃了原有的 `tailwind.config.js`。鉴于 Taomni 的 Tailwind 配置极简（无自定义主题和插件），我们可使用最轻量的方案：引入 `@tailwindcss/vite` 插件进行原生 Vite 构建，或使用 `@tailwindcss/postcss` 插件配合 PostCSS。推荐使用原生的 `@tailwindcss/vite` 插件。
2. **React 19 升级与 TS 类型严格化**：React 19 对类型进行了大幅收紧（例如移除了 `React.HTMLAttributes` 中的某些默认类型，且 `ref` 不再需要 `forwardRef` 包装，可直接作为 prop）。升级 React 核心及 `@types/react` 19 将带来大量的 TS 编译错误，需结合官方 codemod 集中修复。
3. **Zustand v5 selector 风险**：Zustand v5 限制了 object-returning selectors。如果使用类似 `useAppStore(s => ({ a: s.a, b: s.b }))` 的写法，必须配合 `useShallow`，否则会在 React 19 中触发无限循环渲染。
4. **Marked 编译配置变化**：`marked.setOptions` 在 15+ 版本中已被弃用，在 18.x 中需要完全迁移为 `marked.use()`，以保证 Markdown 渲染的安全和稳定。
5. **xterm.js 版本锁定**：`@xterm/xterm` 及其 Addon 当前已经是最新稳定版本 `6.0.0` 系列，本次计划中无需进行 major 升级。

---

## Phase 1：安全与补丁包升级（低风险，API 完全兼容）

### 目标
执行小版本与补丁版本升级，无需或极少代码变更，用于确保基础依赖安全性。

### package.json 变更
```json
{
  "dependencies": {
    "@codemirror/autocomplete": "^6.20.3", // 6.20.2 -> 6.20.3
    "@tauri-apps/plugin-shell": "^2.3.5",  // 2.0.0 -> 2.3.5
    "dompurify": "3.4.8"                  // 3.2.4 -> 3.4.8
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.11.2",          // 2.10.1 -> 2.11.2
    "jsdom": "^29.1.1",                    // 29.1.0 -> 29.1.1
    "ws": "^8.21.0"                        // 8.20.0 -> 8.21.0
  }
}
```

### 代码变更
*   **DOMPurify**：无 API 变更，直接升级。
*   **Tauri Shell Plugin**：API 保持向前兼容，执行 bump 即可。

### 验证
```bash
pnpm install
pnpm run dev
pnpm run test
```

---

## Phase 2：开发工具链重构（Vite 8 + TS 6 + Vitest 4）

### 目标
升级整个前端构建、类型系统和测试运行器，以适配后续的 React 19 及 Tailwind v4 编译环境。

### package.json 变更
```json
{
  "devDependencies": {
    "vite": "^8.0.16",                     // 5.4.0 -> 8.0.16
    "@vitejs/plugin-react": "^6.0.2",      // 4.3.0 -> 6.0.2
    "typescript": "^6.0.3",                // 5.6.0 -> 6.0.3
    "vitest": "^4.1.8"                     // 2.1.9 -> 4.1.8
  }
}
```

### 关键配置变更
*   **Vite 8**：检查 [vite.config.ts](file:///data/code-src/person/taomni/vite.config.ts) 里的代理配置与宿主设置。Vite 8 修改了某些配置默认值，需确保本地 Tauri 调试代理（`sshProxyPlugin`, `sftpProxyPlugin`, `rdpProxyPlugin`）能够正常加载。
*   **Vitest 4**：在 [vitest.config.ts](file:///data/code-src/person/taomni/vitest.config.ts) 中，新版 Vitest 引入了对部分旧配置项的废弃，需进行语法对齐。

### 代码变更与排查
- 运行类型检查：
  ```bash
  pnpm exec tsc --noEmit
  ```
  处理 TS 6.0 带来的更严格的类型推导错误。

### 验证
```bash
pnpm run build
pnpm run test
```

---

## Phase 3：应用层基础库升级（Zustand + Marked + Lucide）

### 目标
完成应用功能模块中关键依赖的 Major 升级，重点修复被废弃的 API。

### package.json 变更
```json
{
  "dependencies": {
    "zustand": "^5.0.14",                  // 4.5.0 -> 5.0.14
    "marked": "18.0.5",                    // 15.0.7 -> 18.0.5
    "lucide-react": "^1.17.0",             // 0.400.0 -> 1.17.0
    "react-resizable-panels": "^4.11.2"    // 2.1.0 -> 4.11.2
  }
}
```

### 代码变更
1.  **Marked 升级**（[renderFormatted.ts](file:///data/code-src/person/taomni/src/lib/chat/renderFormatted.ts)）：
    - 废弃 `marked.setOptions`。修改为使用 `marked.use`：
    ```typescript
    // 旧代码
    marked.setOptions({
      gfm: true,
      breaks: true,
    });

    // 新代码
    marked.use({
      gfm: true,
      breaks: true,
    });
    ```
2.  **Zustand v5 审核**：
    - 检查项目中是否有使用 Selector 返回新对象的行为。
    - 例如，若存在 `useAppStore(s => ({ activeTabId: s.activeTabId }))`，需要将其重构为包裹 `useShallow` 的形式，或拆分为单独的属性查询：
    ```typescript
    import { useShallow } from 'zustand/react/shallow';
    const { activeTabId } = useAppStore(useShallow(s => ({ activeTabId: s.activeTabId })));
    ```
3.  **Lucide React 图标更名**：
    - v1.0.0+ 移除了部分图标的老旧别名，需对比全局导入的图标，如遇到报错则按官方更名表进行替换。

### 验证
```bash
pnpm run test
```

---

## Phase 4：样式引擎重构（Tailwind CSS v4）

### 目标
升级 Tailwind CSS 到 v4，利用 Rust 重写的 Oxide 引擎，将样式配置转化为 CSS-first 结构，并废弃 `tailwind.config.js`。

### package.json 变更
```json
{
  "devDependencies": {
    "tailwindcss": "^4.3.0",               // 3.4.0 -> 4.3.0
    "postcss": "^8.5.15",                  // 8.4.0 -> 8.5.15
    "autoprefixer": "^10.5.0"              // 10.4.0 -> 10.5.0
  }
}
```

### 推荐的升级路径：原生 Vite 插件模式
既然使用了 Vite 8，最优雅的方法是使用 `@tailwindcss/vite` 替换 PostCSS 构建流程。

1.  **安装 Vite 插件**：
    ```bash
    pnpm add -D @tailwindcss/vite
    ```
2.  **修改 [vite.config.ts](file:///data/code-src/person/taomni/vite.config.ts)**：
    ```typescript
    import tailwindcss from '@tailwindcss/vite';

    export default defineConfig({
      plugins: [
        tailwindcss(),
        react(),
        // ... 其他插件
      ],
    });
    ```
3.  **修改 [src/index.css](file:///data/code-src/person/taomni/src/index.css)**：
    移除旧的 `@tailwind` 语法：
    ```css
    /* 移除 */
    @tailwind base;
    @tailwind components;
    @tailwind utilities;

    /* 替换为 */
    @import "tailwindcss";
    ```
4.  **删除**：[tailwind.config.js](file:///data/code-src/person/taomni/tailwind.config.js) 和 [postcss.config.js](file:///data/code-src/person/taomni/postcss.config.js)。

### 验证
```bash
pnpm run dev
# 检查开发服务器是否能成功编译 css，并仔细比对界面样式是否有微小错位（v4 的 rounded 和 spacing 存在细微默认值调整）
```

---

## Phase 5：React 19 框架升级（核心框架升级）

### 目标
完成 React 19 核心框架及类型声明文件的迁移。

### package.json 变更
```json
{
  "dependencies": {
    "react": "^19.2.7",                    // 18.3.1 -> 19.2.7
    "react-dom": "^19.2.7"                 // 18.3.1 -> 19.2.7
  },
  "devDependencies": {
    "@types/react": "^19.2.16",            // 18.3.0 -> 19.2.16
    "@types/react-dom": "^19.2.3",          // 18.3.0 -> 19.2.3
    "@testing-library/react": "^16.3.2"    // 确保与 React 19 兼容
  }
}
```

### 关键代码变更与修复
1.  **全局运行 React 19 迁移 Codemod**：
    ```bash
    npx codemod@latest react/19/migration-recipe
    ```
    该脚本会自动处理 `forwardRef` 替换、`ReactDOM.render` 到 `createRoot` 的适配以及类型定义的微调。
2.  **TypeScript 严格编译报错修复**：
    - React 19 中，许多类型（如 `Ref` 的声明方式）发生了变化。需逐个文件解决 `tsc` 报错。

### 验证
```bash
pnpm run build
pnpm run test
# 在 Tauri / 浏览器中进行全量功能冒烟测试
```

---

## 执行顺序

```
Phase 1（低风险安全与补丁包升级）
  ↓
Phase 2（工具链：Vite 8 + TS 6 + Vitest 4）
  ↓
Phase 3（应用库：Zustand 5 + Marked 18 + Lucide 1.17）
  ↓
Phase 4（样式升级：Tailwind CSS v4 迁移）
  ↓
Phase 5（框架核心：React 19 升级）
```

每阶段完成后执行：
```bash
pnpm install
pnpm exec tsc --noEmit
pnpm run test
```

---

## 升级汇总

| Phase | 描述 | 涉及主要文件数 | 预计工作量 | 风险评估 |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 1** | 小版本与安全补丁包升级 | 仅 package.json | 0.5 天 | 极低 |
| **Phase 2** | Vite 8 + TS 6 + Vitest 4 工具链 | 配置文件、测试配置文件 | 1.5 天 | 中 |
| **Phase 3** | Zustand 5 + Marked 18 适配 | `renderFormatted.ts`、相关 store | 1-2 天 | 中低 |
| **Phase 4** | Tailwind v4 (CSS-first) 迁移 | `index.css`、移除配置文件 | 1.5 天 | 中 |
| **Phase 5** | React 19 & 类型声明升级 | 全局组件（特别是 ref 与类型定义声明） | 3-5 天 | 高 |

**前端升级总计工期**：约 8-11 天开发 + 2 天全面回归测试。
