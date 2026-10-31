# AI-assisted SRE workshop. Every kubectl call is pinned to the lab cluster's
# context, so other clusters on your machine are never touched.
CLUSTER := sre-lab
CTX     := k3d-$(CLUSTER)
K       := kubectl --context $(CTX)

.DEFAULT_GOAL := help
.PHONY: help awake preflight up down status break-1 break-2 fix-1 fix-2 reset agent-ro agent-write rbac

help: ## Show targets
	@grep -E '^[a-z0-9-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

awake: ## Keep the Mac awake for 2h (display, idle and system sleep blocked)
	@echo "Keeping this Mac awake for 2h. Ctrl+C to stop."
	@caffeinate -dims -t 7200

preflight: ## Check Docker, k3d, kubectl, node, gemini, API key
	@./scripts/preflight.sh

up: ## Create the k3d cluster and deploy the healthy shop app
	@k3d cluster list $(CLUSTER) >/dev/null 2>&1 || k3d cluster create $(CLUSTER) --agents 1
	@$(K) get ns shop >/dev/null 2>&1 || $(K) create namespace shop
	@$(K) apply -n shop -f manifests/app.yaml
	@$(K) -n shop rollout status deploy/web --timeout=180s
	@$(K) -n shop rollout status deploy/cart --timeout=180s
	@$(K) -n shop get pods

down: ## Delete the lab cluster
	k3d cluster delete $(CLUSTER)

status: ## Show shop pods
	@$(K) -n shop get pods

break-1: ## Fault A: typo in the web image tag (ImagePullBackOff)
	$(K) -n shop set image deploy/web nginx=nginx:1.27-alpne

break-2: ## Fault B: remove DB_HOST from cart (CrashLoopBackOff)
	$(K) -n shop set env deploy/cart DB_HOST-

fix-1: ## Manual fix for fault A
	$(K) -n shop set image deploy/web nginx=nginx:1.27-alpine

fix-2: ## Manual fix for fault B
	$(K) -n shop set env deploy/cart DB_HOST=postgres.shop.svc.cluster.local

reset: ## Put the app back to healthy
	@$(K) apply -n shop -f manifests/app.yaml
	@$(K) -n shop rollout status deploy/web --timeout=180s
	@$(K) -n shop rollout status deploy/cart --timeout=180s
	@$(K) -n shop get pods

agent-ro: ## Gemini profile: read-only Kubernetes MCP
	@./scripts/agent-profile.sh readonly

agent-write: ## Gemini profile: write-enabled MCP (dangerous tools removed)
	@./scripts/agent-profile.sh write

rbac: ## Optional: create a read-only ServiceAccount kubeconfig and test it
	@CTX=$(CTX) ./scripts/rbac.sh
