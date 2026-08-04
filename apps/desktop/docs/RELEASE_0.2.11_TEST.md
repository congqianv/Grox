# Grox Desktop 0.2.11 — 测试说明

**主题：** Codex 能力迁移 A0–D + 队列 heldByCli / 沙箱诚实 / worktree 纠错  
**版本：** `apps/desktop` **0.2.11**  
**说明：** 取代过时的 `RELEASE_0.2.9_TEST.md` 中与 **沙箱注入** 相关的期望。

## 启动

```powershell
cd C:\Users\Harry_win10\Desktop\Grox-build\apps\desktop
pnpm install
pnpm test          # 期望全绿
pnpm typecheck
pnpm desktop:dev   # 真 ACP（需本机 grok 绝对路径）
# 仅 UI：pnpm dev
```

以 `package.json` / `tauri.conf.json` / `Cargo.toml` 版本为准（**0.2.11**）。

---

## 设计原则（测试时对照）

| 原则 | 期望 |
|------|------|
| 开放默认 | 沙箱默认 **跟随 CLI**，不强制 workspace |
| 不二次审讯 | sandbox=off / Bypass 可继续，仅警告 |
| UI 诚实 | 隔离 unknown 时 **不是** 绿色「已隔离」 |
| 壳不注入 | 桌面 Agent 主进程 **从不** 注入 `--sandbox` / `GROK_SANDBOX`（避免模型 API 403） |
| 不硬挡并行 | 多 session / 子代理仅软提示 |
| 无 git 不假死 | Worktree 失败仍可用 Local + 多 session |
| flag 可关 | 关闭 `sandboxUi` **仅隐藏 UI**；开关均不改变 spawn argv |

---

## 必测清单

### 0. 回归护城河（最高优先）

- [ ] 主聊天能正常发消息、流式回复
- [ ] **排队**：turn 进行中再发 → 本地队列 + CLI 并发；结束后 strip held / drain
- [ ] **heldByCli**：入队被 CLI 接受后仍见「等待当前回合结束」；idle 后该行消失且 **不** dual-send
- [ ] **重连后队列**：有 held/queued 行时重连 → 行变为可 drain 的 local，**会**自动发（新 agent 未跑过）
- [ ] **插话**（Ctrl+Enter）不拆坏当前回合
- [ ] **权限卡**可点允许/拒绝；不丢卡
- [ ] **Stop** 后队列不错误自动 drain
- [ ] Computer Use 仍须设置里 opt-in（Bypass **不会**自动开 CU）

### 1. A0 Effective / inspect

- [ ] 顶栏环境摘要 chip → EFFECTIVE 面板
- [ ] sandbox/permission applied 未知时 **unknown**（非假绿）
- [ ] `pnpm dev`：inspect 降级，不挡聊天

### 2. A1 沙箱（开放 · **无注入**）

- [ ] 默认「跟随 CLI」；齿轮 chip 对非默认项显示 **`pref:…`**，不是 live 状态
- [ ] 显式选 workspace / 只读 → **仅保存偏好**；toast/提示写明 **不注入** Agent 主进程
- [ ] **重连后 spawn 仍不带** `--sandbox`（与 follow_cli 行为一致；用 CLI/进程参数或行为确认）
- [ ] 选 **off** → 金色说明，无二次弹窗拦截
- [ ] 忙碌时改沙箱 → **无**「pending 重连后生效」承诺（pending 位恒 false）
- [ ] 设置关闭 `sandboxUi` → 隐藏沙箱选择 UI；spawn 仍不注入

### 3. A2 Worktree

- [ ] 默认 **Local**
- [ ] **列表失败** → 错误态文案（不是「尚无 worktree」）
- [ ] 列表真为空 → empty 文案
- [ ] 创建失败（`ok: false`）→ 失败提示，**不**假成功
- [ ] 打开无效路径 → **不**建坏 session

### 4. B1 子代理轨

- [ ] 真 spawn_subagent 出现在右侧轨；纯 shell / Task call-uuid **不**进轨
- [ ] 普通 task 文案含 “plan/general” **不**误收
- [ ] 多 session 并行：仅软提示，不禁止发送
- [ ] 关闭 `agentStripV2` 后回到简条

### 5. C / D / flags

- [ ] 复制 headless 片段可用
- [ ] Review 预设：模式/权限生效；文案不声称沙箱已隔离
- [ ] flag 全关后聊天核心仍可用

---

## 已知限制（不必当回归失败）

1. **applied sandbox** 上游常不回报 → 面板长期 unknown 是诚实行为  
2. **Worktree create** 依赖 CLI/git  
3. Computer Use / Bypass 仍以 FE + localStorage 为主（主机侧强确认属后续硬化）  
4. Windows 孙进程 Job Object 清理属后续硬化  

---

## 自动门禁

```powershell
pnpm test
pnpm typecheck
# 可选：pnpm test:rust
```
