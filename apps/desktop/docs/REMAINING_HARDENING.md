# Remaining hardening (not in this slice)

Tracked after multi-agent R1/R2 review. Intentionally **not** all done in the
queue / sandbox honesty pass.

| Item | Severity | Notes |
|------|----------|-------|
| Windows Job Object for ACP child tree | P1 platform | Direct `child.kill()` only; grandchildren may orphan |
| Computer Use opt-in host-attested | P1 security | Still FE boolean + localStorage; needs native confirm / host store |
| Bypass/YOLO host-attested | P1 security | localStorage permission mode |
| Full store/integration test harness | P2 | Pure unit coverage is strong; store event sequences untested |
| Cross-platform single-instance | P3 | Mutex is Windows-only |

Done in follow-up commit: queue notice i18n, secondary CLI absolute path,
markdown `style` attr removal, `acp_send` generation token.

## Root repo files intentionally not committed

| File | Why left untracked |
|------|--------------------|
| `.npmrc` (`dangerouslyAllowAllBuilds=true`) | Local install convenience; too permissive for shared default |
| `pnpm-workspace.yaml` (only `onlyBuiltDependencies`) | Incomplete / not a proper packages workspace; apps/desktop is self-contained |
