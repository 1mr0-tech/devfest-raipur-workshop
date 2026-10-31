#!/usr/bin/env bash
# OPTIONAL stretch: a real read-only Kubernetes identity for the agent.
# Creates ServiceAccount shop/agent-reader (view role) and a kubeconfig for it.
set -euo pipefail
ctx="${CTX:-k3d-sre-lab}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/agent-reader.kubeconfig"
k="kubectl --context $ctx"

$k -n shop create serviceaccount agent-reader --dry-run=client -o yaml | $k apply -f - >/dev/null
$k -n shop create rolebinding agent-reader --clusterrole=view \
  --serviceaccount=shop:agent-reader --dry-run=client -o yaml | $k apply -f - >/dev/null

token=$($k -n shop create token agent-reader --duration=2h)
server=$($k config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}')
ca=$($k config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')

cat > "$out" <<KCFG
apiVersion: v1
kind: Config
clusters:
- name: sre-lab
  cluster: {server: $server, certificate-authority-data: $ca}
users:
- name: agent-reader
  user: {token: $token}
contexts:
- name: agent-reader@sre-lab
  context: {cluster: sre-lab, user: agent-reader, namespace: shop}
current-context: agent-reader@sre-lab
KCFG
chmod 600 "$out"

echo "Wrote $out (token valid 2h)"
for check in "list pods -n shop" "delete pods -n shop" "delete pods -n kube-system"; do
  printf '  can-i %-28s -> ' "$check"
  kubectl --kubeconfig "$out" auth can-i $check || true
done
