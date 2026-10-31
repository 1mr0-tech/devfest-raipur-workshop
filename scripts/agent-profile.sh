#!/usr/bin/env bash
# Usage: agent-profile.sh readonly|write
# Writes .gemini/settings.json so Gemini CLI launches the Kubernetes MCP server
# with the chosen profile. Paths must be absolute, hence generated per machine.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in
  readonly) toml="$root/config/k8s-readonly.toml" ;;
  write)    toml="$root/config/k8s-write.toml" ;;
  *) echo "usage: $0 readonly|write" >&2; exit 2 ;;
esac
mkdir -p "$root/.gemini"
cat > "$root/.gemini/settings.json" <<JSON
{
  "mcpServers": {
    "kubernetes": {
      "command": "npx",
      "args": ["-y", "kubernetes-mcp-server@latest", "--config", "$toml"],
      "trust": false
    }
  }
}
JSON
echo "Gemini profile: $1  ($toml)"
echo "Restart gemini to pick it up. Inside gemini, run /mcp to see the tools."
