# Facilitator guide (90 min)

## Run of show

| Time | Block | Notes |
|---|---|---|
| 0:00-0:40 | Talk | About 25 slides, see `slide-map.md`. State up front that the lab recreates the ideas locally. |
| 0:40-0:50 | Setup | `npm run preflight` then `npm run up`. Have a helper ready for Docker issues. |
| 0:50-1:00 | Lab 1 | Let people struggle for about 3 min before discussing. |
| 1:00-1:15 | Lab 2 | Fault A then B. Compare the agent's time to the manual time. |
| 1:15-1:25 | Lab 3 | Make everyone run the dry-run before approving. |
| 1:25-1:30 | Lab 4 + wrap | Four destructive prompts, ask which layer stopped each. Close on "less toil for the humans who remain". |

Running late: drop Fault A in Lab 2 and skip `npm run rbac`.
Running early: do **Lab 5** (OOMKilled with no log line, then an agent-written postmortem). It is the best use of spare minutes. Or run `npm run mcp-check` live to show the guardrails without the model.

Measured on the build machine (cluster already warm): `npm run up` 60 s, each fault visible in 20-30 s, `npm run reset` about 30 s. The mechanical steps are fast, so the lab's real duration is the people and the model. Budget about 35-40 min for Labs 1-4 with a mixed group, which leaves 10 min of slack for Lab 5 or questions.

## Things verified on a real cluster

- `npm run up`, `break-1`, `break-2`, `fix-1`, `fix-2`, `reset` all work. Fault A gives `ErrImagePull` then `ImagePullBackOff`; Fault B gives `Error` then `CrashLoopBackOff` after about 30 s.
- Read-only profile exposes 13 tools with no write tools; write profile removes `resources_delete`, `pods_delete`, `pods_exec`, `pods_run`.
- Fault C (`npm run break-3`) gives `OOMKilled`, exit 137, and no log line from the broken pod. The agent's `pods_get` tool returns that evidence.
- The MCP tool path was driven directly: `pods_log` returned the FATAL line, and `resources_create_or_update` fixed the cart deployment, with the pod recovering.
- `npm run mcp-check` passes for both profiles (tools offered or removed, Secrets denied, other cluster context unreachable, scale works only in the write profile).
- `npm run rbac`: the identity can list pods in `shop` and cannot delete in `shop` or `kube-system`.
- `gemini mcp list` shows the server Connected in both profiles, once the folder is trusted.

## Not verified (no API key on the build machine)

Model behaviour: whether Gemini reads logs unprompted on Fault B, and whether it honours `GEMINI.md`. **Do a full dry run with your key the day before.** If it only reads events on Fault B, nudge it: "check the container logs".

## Gotchas

- **Folder trust.** Gemini CLI disables MCP servers in untrusted folders. Tell everyone to pick "Trust folder" at first launch.
- **Rolling update.** During Fault A, 1 of 3 pods fails while the old ones keep serving, so the site stays up. That is realistic. Say so.
- **Free-tier rate limits** are shared across a room's Wi-Fi/IP in some cases. Fallback: `npm run fix-1` / `npm run fix-2`.
- **Sleep.** `npm run awake` keeps the machine awake for 2 h (macOS `caffeinate`, Windows `SetThreadExecutionState`, Linux `systemd-inhibit`). Closing the lid still sleeps a laptop unless it is on power with an external display.
- **Existing clusters.** All targets use `--context k3d-sre-lab`, and the agent's kubeconfig (`.gemini/lab.kubeconfig`) contains only the lab cluster. Every MCP tool accepts a `context` argument, so without this an agent could target any cluster in your kubeconfig.
- **Windows, macOS, Linux.** All lab glue is one Node script (`scripts/lab.mjs`, run via `npm run`), so there is no bash, make, awk or `$(...)` in anything participants type. kubectl commands in the docs avoid shell-specific syntax. The only per-OS steps are installing tools and setting `GEMINI_API_KEY` (bash vs. PowerShell).
- **Windows API port.** k3d's default kubeconfig points at `0.0.0.0`, which Windows cannot connect to. `npm run up` creates the cluster with `--api-port 127.0.0.1:6550`, so port 6550 must be free.
- **Windows is the least-tested path.** CI proves the script runs and resolves the `npx` and `gemini` shims on Windows, but GitHub's Windows runners cannot run Linux containers, so no cluster runs there. Test on a real Windows laptop with Docker Desktop (WSL2 backend) before the day.
