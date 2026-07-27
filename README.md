<h1><img src="apps/desktop/src-tauri/icons/icon.png" width="48" height="48" align="center" alt="Grox 图标"> Grox</h1>

Grox 是以 [xai-org/grok-build](https://github.com/xai-org/grok-build) 为核心打造的桌面端 Agent。它通过 ACP（Agent Client Protocol）连接本机 Grok Build 运行时，在 Tauri 桌面窗口中提供会话恢复、流式思考、工具调用、代码差异、权限审批、结构化问答和用量统计。

本仓库是 **Lite 极简 fork**：只包含 `apps/desktop` 桌面壳，不内置、不编译 Grok Agent。运行前请先安装官方 [Grok Build CLI](https://github.com/xai-org/grok-build)。

## 已实现能力

- 真实 ACP JSON-RPC 链路：原生进程托管、请求响应、通知流和异常退出处理
- 中英文界面与明暗主题：默认简体中文和 GrokNight 暗黑模式
- 项目与任务目录：项目可置顶、在资源管理器打开、重命名、归档和移除；任务可置顶与归档
- Agent 时间线：回答、思考、计划、工具调用、终端输出与文件 Diff；任务完成后自动收纳处理过程，工具详情默认折叠
- 安全预览侧栏：支持 Markdown、静态 HTML、图片与文本文件，可拖动调整侧栏、检查器和预览区宽度
- 交互闭环：对话框可直接切换模型、权限和思考强度，支持文件上传、剪贴板图片粘贴、计划批准及结构化问答
- 多账户接入：Grok OAuth、xAI 官方 API 与 OpenAI 兼容服务；API 密钥、Base URL 和模型列表地址统一在账户模块管理，密钥不回传 WebView
- 账户中心：头像菜单、登录/退出、订阅方案、周额度、用量与官方升级入口
- 扩展管理：可视化添加、启用和移除 MCP、Skills、Plugins，并提供主流市场入口
- 配置同步：账户模块内的 `config.toml`、`system-prompt.md` 与项目 `AGENTS.md` 支持双向编辑和外部变更热同步
- 动态模型：OAuth 实时跟随 Grok 模型目录；官方及兼容 API 可拉取模型列表并持久选择常驻模型
- 桌面安全：Markdown 清洗、CSP、HTTP(S) 外链校验、无控制台子进程
- 离线 Mock：浏览器开发时可完整演示主要界面状态

## 架构

```text
React / Zustand
      │ GrokBridge
      ▼
AcpBridge（JSON-RPC 2.0）
      │ Tauri IPC
      ▼
Rust 原生进程层
      │ stdin / stdout
      ▼
本机 grok agent stdio
```

WebView 不直接启动任意命令。Rust 层只托管已解析的 Grok Build 可执行文件，并把逐行 ACP 消息转发给前端。

## 前置条件

- Node.js、pnpm
- Rust（编译 Tauri 壳）
- Windows WebView2 或对应平台的 Tauri 系统依赖
- 本机已安装 Grok Build CLI（`~/.grok/bin/grok`、PATH，或通过 `GROK_DESKTOP_CLI` 指定）

## 快速开始

```powershell
cd apps/desktop
pnpm install

# 浏览器 Mock，适合只看界面
pnpm dev

# 使用本机 Grok CLI 启动桌面端
pnpm desktop:dev
```

桌面端默认使用真实 ACP。浏览器环境自动使用 Mock；Tauri 中可用 `?mock=1` 临时切换 Mock。

开发时也可通过环境变量覆盖：

```powershell
$env:GROK_DESKTOP_CLI = "D:\path\to\grok.exe"
$env:GROK_DESKTOP_CWD = "D:\path\to\workspace"
pnpm desktop:dev
```

## 构建安装包

```powershell
cd apps/desktop
pnpm desktop:build
```

运行时解析顺序：`GROK_DESKTOP_CLI` → 系统 `grok`。GitHub Release 默认走 Lite。

代码签名、macOS notarization 和更新服务凭据属于发布环境配置，不应提交到仓库。

## 验证

```powershell
cd apps/desktop
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

## 目录

| 路径 | 说明 |
|---|---|
| `apps/desktop/src` | React 界面、状态与 GrokBridge |
| `apps/desktop/src-tauri` | Tauri 原生进程层与发布配置 |
| `apps/desktop/scripts` | 图标生成与 Release 版本同步 |

## 上游与许可证

Grox Desktop 基于 `xai-org/grok-build` 生态开发，桌面壳第一方代码遵循 [Apache License 2.0](LICENSE)。运行时依赖的 Grok Build CLI 及其第三方组件遵循各自上游许可证。前端与 Tauri 依赖的许可证见 `apps/desktop` 的 lockfile（`pnpm-lock.yaml`、`src-tauri/Cargo.lock`）。
