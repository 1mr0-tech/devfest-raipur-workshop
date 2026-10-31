#!/usr/bin/env bash
# Pre-flight check for the AI-assisted SRE workshop. Exit 0 only if everything passes.
fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n        -> %s\n' "$1" "$2"; fail=1; }

echo "Workshop pre-flight"

if docker info >/dev/null 2>&1; then ok "Docker daemon running"
else bad "Docker daemon" "Start Docker Desktop and wait until it is ready"; fi

if command -v k3d >/dev/null; then ok "k3d $(k3d version | head -1 | awk '{print $3}')"
else bad "k3d" "brew install k3d"; fi

if command -v kubectl >/dev/null; then ok "kubectl installed"
else bad "kubectl" "brew install kubectl"; fi

if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  ok "node $(node --version)"
else bad "node >= 20" "brew install node"; fi

if command -v gemini >/dev/null; then ok "gemini $(gemini --version 2>/dev/null | head -1)"
else bad "gemini CLI" "npm install -g @google/gemini-cli"; fi

if [ -n "${GEMINI_API_KEY:-}" ]; then ok "GEMINI_API_KEY is set"
else bad "GEMINI_API_KEY" "Get a free key at https://aistudio.google.com/apikey then: export GEMINI_API_KEY=..."; fi

if command -v npx >/dev/null && npx -y kubernetes-mcp-server@latest --version >/dev/null 2>&1; then
  ok "kubernetes-mcp-server downloads and runs"
else bad "kubernetes-mcp-server" "Check your network, then: npx -y kubernetes-mcp-server@latest --version"; fi

if [ "$fail" -eq 0 ]; then echo "All good. See you at the workshop."; else echo "Fix the FAIL items above."; fi
exit "$fail"
