# Grox Desktop

Grox 的 Tauri 2 + React 19 桌面应用，通过 `grok agent stdio` 的 ACP 接口连接 Grok Build。

## 运行

```powershell
pnpm install
pnpm dev                  # 浏览器 Mock
pnpm desktop:dev          # lite：不编译 Agent，使用本机 Grok CLI
pnpm desktop:dev:bundled  # 编译 debug sidecar 并以内置 Agent 启动
```

Tauri 环境默认使用 `AcpBridge`；浏览器环境使用 `MockBridge`。调试时可在 Tauri URL 上追加 `?mock=1`。

本机 CLI 查找顺序：`GROK_DESKTOP_CLI` → PATH / `~/.grok/bin/grok` 等系统路径 →（仅 bundled）安装包内 sidecar。

## 构建

```powershell
pnpm desktop:build          # lite：只打桌面壳（推荐）
pnpm desktop:build:bundled  # 编译 release-dist sidecar 并打进安装包
```

默认 `tauri.conf.json` 不设置 `bundle.externalBin`，因此 lite 跳过 sidecar。bundled 模式会编译根仓库的 `xai-grok-pager-bin`，并用 `tauri.conf.bundled.json` 把 `grok-<target-triple>` 打进安装包。

## 环境变量

- `GROK_DESKTOP_CLI`：覆盖 Grok CLI 路径
- `GROK_DESKTOP_CWD`：覆盖默认工作区
- `GROK_HOME`：沿用 Grok Build 配置与会话目录
- `XAI_API_KEY`：由 Agent 读取；前端不会写入 localStorage

## 主要模块

- `src/bridge/AcpBridge.ts`：ACP JSON-RPC、认证、模型、会话和事件映射
- `src/state/store.ts`：统一状态与 BridgeEvent 应用
- `src/components/session`：流式时间线、权限卡和结构化问答
- `src-tauri/src/main.rs`：受限子进程、IPC、外链和生命周期
- `scripts/prepare-sidecar.mjs`：debug/release sidecar 构建（仅 bundled）
- `src-tauri/tauri.conf.bundled.json`：bundled 打包配置（内置 CLI）
