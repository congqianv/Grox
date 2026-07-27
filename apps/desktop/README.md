# Grox Desktop

Grox 的 Tauri 2 + React 19 桌面应用（**Lite**）：只打包桌面壳，通过本机已安装的 Grok Build CLI（`grok agent stdio` ACP）连接运行时。

## 运行

```powershell
pnpm install
pnpm dev            # 浏览器 Mock，适合只看界面
pnpm desktop:dev    # 使用本机 Grok CLI 启动桌面端
```

Tauri 环境默认使用 `AcpBridge`；浏览器环境使用 `MockBridge`。调试时可在 Tauri URL 上追加 `?mock=1`。

本机 CLI 查找顺序：`GROK_DESKTOP_CLI` → PATH / `~/.grok/bin/grok` 等系统路径。

## 构建

```powershell
pnpm desktop:build  # 只打桌面壳安装包
```

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
- `scripts/sync-release-version.mjs`：Release 时同步版本号
- `scripts/gen-icons.mjs`：从 `app-icon.svg` 生成桌面图标
