#!/usr/bin/env python3
"""Check the agent's tool layer WITHOUT Gemini or an API key.

Starts the same MCP server Gemini would (read from .gemini/settings.json) and
calls it directly. Run `make agent-ro` or `make agent-write` first, then
`make mcp-check`. Also works as a fallback demo if the model API is down.
"""
import json, subprocess, sys, time, pathlib, queue, threading

root = pathlib.Path(__file__).resolve().parent.parent
cfg = json.loads((root / ".gemini/settings.json").read_text())["mcpServers"]["kubernetes"]
toml = cfg["args"][-1]
readonly = "read_only = true" in pathlib.Path(toml).read_text()
print(f"profile: {'read-only' if readonly else 'write'}\n")

p = subprocess.Popen([cfg["command"], *cfg["args"]], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
lines = queue.Queue()
threading.Thread(target=lambda: [lines.put(l) for l in p.stdout], daemon=True).start()
_id = 0

def rpc(method, params=None, wait=True):
    global _id
    msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
    if wait:
        _id += 1
        msg["id"] = _id
    p.stdin.write(json.dumps(msg) + "\n"); p.stdin.flush()
    while wait:
        d = json.loads(lines.get(timeout=60))
        if d.get("id") == _id:
            return d

def call(tool, **args):
    d = rpc("tools/call", {"name": tool, "arguments": args})
    if "error" in d:
        return True, d["error"].get("message", "")
    r = d["result"]
    return bool(r.get("isError")), "".join(c.get("text", "") for c in r.get("content", []))

failed = 0
def check(name, ok, detail=""):
    global failed
    failed += not ok
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"\n        {detail}" if detail and not ok else ""))

rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                   "clientInfo": {"name": "mcp-check", "version": "1"}})
rpc("notifications/initialized", wait=False)
tools = {t["name"] for t in rpc("tools/list")["result"]["tools"]}

print("Tools exposed to the agent")
for t in ("pods_list_in_namespace", "pods_log", "events_list"):
    check(f"{t} available", t in tools)
for t in ("resources_delete", "pods_delete", "pods_exec", "pods_run"):
    check(f"{t} NOT available", t not in tools)
check("resources_scale " + ("NOT available (read-only)" if readonly else "available"),
      (("resources_scale" not in tools) if readonly else ("resources_scale" in tools)))

print("\nWhat the agent can see")
err, out = call("pods_list_in_namespace", namespace="shop")
check("lists pods in shop", not err and "web-" in out, out[:200])
err, out = call("events_list", namespace="shop")
check("reads events", not err, out[:200])

print("\nGuardrails")
err, out = call("resources_list", apiVersion="v1", kind="Secret", namespace="shop")
check("Secrets are denied", err and ("denied" in out.lower() or "not allowed" in out.lower() or "forbidden" in out.lower()), out[:200])
print("        ->", out[:110].replace("\n", " "))
err, out = call("pods_list", context="k3d-ai-cluster")
check("other cluster context is unreachable", err, out[:200])
print("        ->", out[:110].replace("\n", " "))

if not readonly:
    print("\nWrite path (scales web 2 -> 3 -> 2)")
    err, out = call("resources_scale", apiVersion="apps/v1", kind="Deployment",
                    name="web", namespace="shop", scale=3)
    check("scale web to 3", not err, out[:200])
    err, out = call("resources_scale", apiVersion="apps/v1", kind="Deployment",
                    name="web", namespace="shop", scale=2)
    check("scale web back to 2", not err, out[:200])

p.terminate()
print("\nALL PASS" if not failed else f"\n{failed} FAILED")
sys.exit(1 if failed else 0)
