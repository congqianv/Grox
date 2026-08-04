# Grox Desktop 0.2.9 — 测试说明

**主题：** Codex 能力迁移 A0–D（开放优先，防回归）  
**版本：** `apps/desktop` **0.2.9**  
**分支建议：** `feat/desktop-turn-queue-permission-stall`（或你合入后的测试分支）

## 启动

```powershell
cd C:\Users\Harry_win10\Desktop\Grox-build\apps\desktop
pnpm install
pnpm test          # 期望全绿
pnpm desktop:dev   # 真 ACP（需本机 grok）
# 仅 UI：pnpm dev
```

确认设置里应用版本 / 运行时显示壳为 **0.2.9**（若 UI 仍缓存旧号，以 `package.json` / `tauri.conf.json` 为准）。

---

## 设计原则（测试时对照）

| 原则 | 期望 |
|------|------|
| 开放默认 | 沙箱默认 **跟随 CLI**，不强制 workspace |
| 不二次审讯 | sandbox=off / Bypass 可继续，仅警告 |
| UI 诚实 | 隔离 unknown 时 **不是** 绿色「已隔离」 |
| 不硬挡并行 | 多 session / 子代理仅软提示 |
| 无 git 不假死 | Worktree 失败仍可用 Local + 多 session |
| flag 可关 | 关闭 sandboxUi 后 spawn 不注 `GROK_SANDBOX` |

---

## 必测清单

### 0. 回归护城河（最高优先）

- [ ] 主聊天能正常发消息、流式回复
- [ ] **排队**：turn 进行中再发一条 → 进入队列；结束后 drain
- [ ] **插话**（Ctrl+Enter 若可用）不拆坏当前回合
- [ ] **权限卡**出现时可点允许/拒绝；不丢卡
- [ ] **Stop** 后队列不错误自动 drain
- [ ] Computer Use 仍须设置里 opt-in（Bypass **不会**自动开 CU）

### 1. A0 Effective / inspect

- [ ] 点顶栏环境摘要 chip → 见 **EFFECTIVE** 面板
- [ ] `permission/sandbox applied` 在未知时显示 **unknown**（非假绿）
- [ ] 浏览器 `pnpm dev`：inspect 显示 unavailable/降级，**不挡聊天**
- [ ] `pnpm desktop:dev`：inspect 尽量加载 CLI 版本；失败只降级

### 2. A1 沙箱（开放）

- [ ] 默认标签含「跟随 CLI」；**不**无故变严
- [ ] 显式选 workspace → 空闲时重连 Agent → 新 spawn 带沙箱（可用任务试写文件感知）
- [ ] 选 **off** → 仅金色警告，**无**二次弹窗拦截
- [ ] **忙碌时**改沙箱 → 提示 pending +「重连应用」；当前回合行为不半切换
- [ ] 设置 → 功能开关 **关闭 sandboxUi** → 重启/重连后不再由壳注入沙箱

### 3. A2 Worktree

- [ ] 默认仍是 **Local（当前项目）**
- [ ] 列表失败/空：提示降级，**不**禁用聊天
- [ ] 打开已有 worktree：路径无效时 **不**建坏 session
- [ ] 创建 worktree：失败只报错；成功可再点打开（依赖本机 `grok` + git）

### 4. B1 子代理条

- [ ] 有 task/subagent 时出现条；点击行应滚动到时间线工具卡
- [ ] 多 session 并行时仅 **软提示**，不禁止发送
- [ ] 关闭 `agentStripV2` 后回到更简条（或隐藏增强）

### 5. C CI 文档

- [ ] 设置 → 「复制 headless 片段」可复制
- [ ] 仓库存在 `apps/desktop/docs/examples/`（只读文档）

### 6. D Review 预设

- [ ] Composer 齿轮 → Review 只读 / 允许修改
- [ ] 只读：偏 ask + 确认权限（+ 若 sandboxUi 开则请求 read_only）
- [ ] 允许修改：可再改回；**非**强制企业锁

### 7. Feature flags

- [ ] 设置里开关即时影响 UI（同页刷新）
- [ ] 全部关掉后：聊天核心路径仍可用

---

## 已知限制（不必当回归失败）

1. **applied sandbox** 上游 ACP 常不回报 → 面板长期 unknown 是诚实行为  
2. **Worktree create** 依赖 CLI/HOME/git；失败只提示，属开放降级  
3. **未构建安装包**时，用 `pnpm desktop:dev` 测源码版即可  

---

## 自动门禁（发版前已跑）

```text
pnpm test       # vitest
pnpm typecheck
cargo check --manifest-path src-tauri/Cargo.toml
```
