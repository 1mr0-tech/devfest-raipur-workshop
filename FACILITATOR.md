# Facilitator guide (90 min)

## Run of show

| Time | Block | Notes |
|---|---|---|
| 0:00-0:40 | Talk | About 25 slides, see `slide-map.md`. State up front that the lab recreates the ideas locally. |
| 0:40-0:50 | Setup | `make preflight` then `make up`. Have a helper ready for Docker issues. |
| 0:50-1:00 | Lab 1 | Let people struggle for about 3 min before discussing. |
| 1:00-1:15 | Lab 2 | Fault A then B. Compare the agent's time to the manual time. |
| 1:15-1:25 | Lab 3 | Make everyone run the dry-run before approving. |
| 1:25-1:30 | Lab 4 + wrap | Four destructive prompts, ask which layer stopped each. Close on "less toil for the humans who remain". |

Running late: drop Fault A in Lab 2 and skip `make rbac`.
Running early: do **Lab 5** (OOMKilled with no log line, then an agent-written postmortem). It is the best use of spare minutes. Or run `make mcp-check` live to show the guardrails without the model.

Measured on the build machine (cluster already warm): `make up` 60 s, each fault visible in 20-30 s, `make reset` about 30 s. The mechanical steps are fast, so the lab's real duration is the people and the model. Budget about 35-40 min for Labs 1-4 with a mixed group, which leaves 10 min of slack for Lab 5 or questions.

## Things verified on a real cluster

- `make up`, `break-1`, `break-2`, `fix-1`, `fix-2`, `reset` all work. Fault A gives `ErrImagePull` then `ImagePullBackOff`; Fault B gives `Error` then `CrashLoopBackOff` after about 30 s.
- Read-only profile exposes 13 tools with no write tools; write profile removes `resources_delete`, `pods_delete`, `pods_exec`, `pods_run`.
- Fault C (`make break-3`) gives `OOMKilled`, exit 137, and no log line from the broken pod. The agent's `pods_get` tool returns that evidence.
- The MCP tool path was driven directly: `pods_log` returned the FATAL line, and `resources_create_or_update` fixed the cart deployment, with the pod recovering.
- `make mcp-check` passes for both profiles (tools offered or removed, Secrets denied, other cluster context unreachable, scale works only in the write profile).
- `make rbac`: the identity can list pods in `shop` and cannot delete in `shop` or `kube-system`.
- `gemini mcp list` shows the server Connected in both profiles, once the folder is trusted.

## Not verified (no API key on the build machine)

Model behaviour: whether Gemini reads logs unprompted on Fault B, and whether it honours `GEMINI.md`. **Do a full dry run with your key the day before.** If it only reads events on Fault B, nudge it: "check the container logs".

## Gotchas

- **Folder trust.** Gemini CLI disables MCP servers in untrusted folders. Tell everyone to pick "Trust folder" at first launch.
- **Rolling update.** During Fault A, 1 of 3 pods fails while the old ones keep serving, so the site stays up. That is realistic. Say so.
- **Free-tier rate limits** are shared across a room's Wi-Fi/IP in some cases. Fallback: `make fix-1` / `make fix-2`.
- **Sleep.** `make awake` keeps a Mac awake for 2 h. Closing the lid still sleeps it unless on power with an external display.
- **Existing clusters.** All targets use `--context k3d-sre-lab`, and the agent's kubeconfig (`.gemini/lab.kubeconfig`) contains only the lab cluster. Every MCP tool accepts a `context` argument, so without this an agent could target any cluster in your kubeconfig.
- **zsh.** `commands.txt` defines `k` as a function, not a `K="kubectl ..."` variable, because zsh does not word-split unquoted variables.
