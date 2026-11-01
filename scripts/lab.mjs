#!/usr/bin/env node
// Cross-platform lab helper (macOS, Linux, Windows). Only needs Node 20+.
// Every kubectl call is pinned to the lab cluster's context, so other clusters
// on your machine are never touched.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLUSTER = 'sre-lab';
const CTX = `k3d-${CLUSTER}`;
const API = '127.0.0.1:6550'; // not 0.0.0.0: Windows cannot connect to that
const WIN = process.platform === 'win32';
const MANIFEST = join(ROOT, 'manifests', 'app.yaml');
const GEMINI_DIR = join(ROOT, '.gemini');

const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const green = (s) => c(32, s), red = (s) => c(31, s), dim = (s) => c(2, s);

// npx / npm / gemini are .cmd shims on Windows and need a shell there.
const SHIM = new Set(['npx', 'npm', 'gemini']);
const quote = (a) => (WIN && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function opts(cmd, extra = {}) {
  return { cwd: ROOT, shell: WIN && SHIM.has(cmd), encoding: 'utf8', ...extra };
}
function die(msg) { console.error(red(msg)); process.exit(1); }

function run(cmd, args, extra = {}) {
  const r = spawnSync(cmd, args.map(quote), opts(cmd, { stdio: 'inherit', ...extra }));
  if (r.error) die(`Could not run "${cmd}": ${r.error.message}. Is it installed? Try: npm run preflight`);
  return r.status ?? 1;
}
function out(cmd, args, extra = {}) {
  const r = spawnSync(cmd, args.map(quote), opts(cmd, { stdio: ['pipe', 'pipe', 'pipe'], ...extra }));
  return { code: r.error ? 127 : (r.status ?? 1), stdout: r.stdout || '', stderr: r.stderr || '' };
}
const kc = (...args) => run('kubectl', ['--context', CTX, ...args]);
const kcOut = (...args) => out('kubectl', ['--context', CTX, ...args]);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function rollouts() {
  for (const d of ['web', 'cart', 'report'])
    if (kc('-n', 'shop', 'rollout', 'status', `deploy/${d}`, '--timeout=180s') !== 0) die(`deploy/${d} did not become ready`);
}

// Gemini CLI settings + MCP server config. The agent gets a kubeconfig holding
// ONLY the lab cluster, so it cannot reach your other clusters even if asked.
function writeProfile(profile) {
  const src = join(ROOT, 'config', profile === 'readonly' ? 'k8s-readonly.toml' : 'k8s-write.toml');
  mkdirSync(GEMINI_DIR, { recursive: true });
  const cfg = out('k3d', ['kubeconfig', 'get', CLUSTER]);
  if (cfg.code !== 0) die(`Cluster ${CLUSTER} not found. Run: npm run up`);
  const kube = join(GEMINI_DIR, 'lab.kubeconfig');
  writeFileSync(kube, cfg.stdout);
  try { chmodSync(kube, 0o600); } catch { /* not supported on Windows */ }
  const toml = join(GEMINI_DIR, 'k8s.toml');
  // TOML literal string (single quotes): Windows backslashes need no escaping
  writeFileSync(toml, `kubeconfig = '${kube}'\n` + readFileSync(src, 'utf8'));
  writeFileSync(join(GEMINI_DIR, 'settings.json'), JSON.stringify({
    mcpServers: { kubernetes: { command: 'npx', args: ['-y', 'kubernetes-mcp-server@latest', '--config', toml], trust: profile === 'readonly' } }, // read-only server: no approval clicks needed. Write profile asks every time.
    // The MCP guardrails only matter if the agent has no other way in. Without
    // this it happily runs kubectl through its built-in shell (or via a subagent).
    tools: { exclude: ['run_shell_command', 'write_file', 'replace'] },
    experimental: { enableAgents: false },
  }, null, 2) + '\n');
  console.log(`Gemini profile: ${profile}  (from ${src})`);
  console.log('Restart gemini to pick it up. Inside gemini, run /mcp to see the tools.');
}

// OPTIONAL stretch: a real read-only Kubernetes identity (ServiceAccount + view role).
function rbac() {
  const apply = (obj) => out('kubectl', ['--context', CTX, 'apply', '-f', '-'], { input: JSON.stringify(obj) });
  apply({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'agent-reader', namespace: 'shop' } });
  apply({
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
    metadata: { name: 'agent-reader', namespace: 'shop' },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' },
    subjects: [{ kind: 'ServiceAccount', name: 'agent-reader', namespace: 'shop' }],
  });
  const tok = kcOut('-n', 'shop', 'create', 'token', 'agent-reader', '--duration=2h');
  if (tok.code !== 0) die('Could not create token: ' + tok.stderr);
  const view = JSON.parse(kcOut('config', 'view', '--raw', '--minify', '-o', 'json').stdout);
  const cl = view.clusters[0].cluster;
  const file = join(ROOT, 'agent-reader.kubeconfig');
  writeFileSync(file, JSON.stringify({
    apiVersion: 'v1', kind: 'Config',
    clusters: [{ name: CLUSTER, cluster: { server: cl.server, 'certificate-authority-data': cl['certificate-authority-data'] } }],
    users: [{ name: 'agent-reader', user: { token: tok.stdout.trim() } }],
    contexts: [{ name: `agent-reader@${CLUSTER}`, context: { cluster: CLUSTER, user: 'agent-reader', namespace: 'shop' } }],
    'current-context': `agent-reader@${CLUSTER}`,
  }, null, 2));
  try { chmodSync(file, 0o600); } catch { /* not supported on Windows */ }
  console.log(`Wrote ${file} (token valid 2h)`);
  for (const q of ['list pods -n shop', 'delete pods -n shop', 'delete pods -n kube-system']) {
    const r = out('kubectl', ['--kubeconfig', file, 'auth', 'can-i', ...q.split(' ')]);
    console.log(`  can-i ${q.padEnd(28)} -> ${r.stdout.trim()}`);
  }
}

// Check the agent's tool layer WITHOUT Gemini or an API key: start the same MCP
// server Gemini would (read from .gemini/settings.json) and call it directly.
async function mcpCheck() {
  let cfg;
  try { cfg = JSON.parse(readFileSync(join(GEMINI_DIR, 'settings.json'), 'utf8')).mcpServers.kubernetes; }
  catch { die('No .gemini/settings.json. Run: npm run agent-ro   (or agent-write)'); }
  const readonly = /^\s*read_only\s*=\s*true/m.test(readFileSync(cfg.args.at(-1), 'utf8'));
  console.log(`profile: ${readonly ? 'read-only' : 'write'}\n`);

  const child = spawn(cfg.command, cfg.args.map(quote), { cwd: ROOT, shell: WIN && SHIM.has(cfg.command), stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let nextId = 0;
  createInterface({ input: child.stdout }).on('line', (l) => {
    try { const d = JSON.parse(l); pending.get(d.id)?.(d); } catch { /* not a JSON-RPC line */ }
  });
  const rpc = (method, params = {}) => new Promise((res, rej) => {
    const id = ++nextId;
    const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), 90000);
    pending.set(id, (d) => { clearTimeout(t); res(d); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const d = await rpc('tools/call', { name, arguments: args });
    if (d.error) return [true, d.error.message || ''];
    return [!!d.result.isError, (d.result.content || []).map((x) => x.text || '').join('')];
  };

  let failed = 0;
  const check = (name, pass, detail = '') => {
    if (!pass) failed++;
    console.log(`  ${pass ? green('PASS') : red('FAIL')}  ${name}` + (!pass && detail ? `\n        ${detail.slice(0, 200)}` : ''));
  };

  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-check', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = new Set((await rpc('tools/list')).result.tools.map((t) => t.name));

  console.log('Tools exposed to the agent');
  for (const t of ['pods_list_in_namespace', 'pods_log', 'events_list']) check(`${t} available`, tools.has(t));
  for (const t of ['resources_delete', 'pods_delete', 'pods_exec', 'pods_run']) check(`${t} NOT available`, !tools.has(t));
  check(`resources_scale ${readonly ? 'NOT available (read-only)' : 'available'}`, readonly ? !tools.has('resources_scale') : tools.has('resources_scale'));

  console.log('\nWhat the agent can see');
  let [err, text] = await call('pods_list_in_namespace', { namespace: 'shop' });
  check('lists pods in shop', !err && text.includes('web-'), text);
  [err, text] = await call('events_list', { namespace: 'shop' });
  check('reads events', !err, text);

  console.log('\nGuardrails');
  [err, text] = await call('resources_list', { apiVersion: 'v1', kind: 'Secret', namespace: 'shop' });
  check('Secrets are denied', err && /denied|not allowed|forbidden/i.test(text), text);
  console.log('        ->', text.slice(0, 110).replace(/\s+/g, ' '));
  [err, text] = await call('pods_list', { context: 'k3d-ai-cluster' });
  check('other cluster context is unreachable', err, text);
  console.log('        ->', text.slice(0, 110).replace(/\s+/g, ' '));

  if (!readonly) {
    console.log('\nWrite path (scales web 2 -> 3 -> 2)');
    for (const n of [3, 2]) {
      [err, text] = await call('resources_scale', { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', namespace: 'shop', scale: n });
      check(`scale web to ${n}`, !err, text);
    }
  }
  child.kill();
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}

async function preflight() {
  console.log('Workshop pre-flight  ' + dim(`(${process.platform})`));
  let fail = 0;
  const ok = (m) => console.log(`  ${green('PASS')}  ${m}`);
  const bad = (m, fix) => { fail = 1; console.log(`  ${red('FAIL')}  ${m}\n        -> ${fix}`); };
  const mac = process.platform === 'darwin';
  const hint = {
    docker: WIN || mac ? 'Install and START Docker Desktop' : 'Install Docker Engine and start it (sudo systemctl start docker)',
    k3d: WIN ? 'winget install k3d  (or: choco install k3d / scoop install k3d)' : mac ? 'brew install k3d' : 'curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash',
    kubectl: WIN ? 'winget install Kubernetes.kubectl' : mac ? 'brew install kubectl' : 'https://kubernetes.io/docs/tasks/tools/',
    key: WIN ? 'PowerShell: $env:GEMINI_API_KEY="..."   (key: https://aistudio.google.com/apikey)' : 'export GEMINI_API_KEY="..."   (key: https://aistudio.google.com/apikey)',
  };

  out('docker', ['info']).code === 0 ? ok('Docker daemon running') : bad('Docker daemon', hint.docker);
  const k3d = out('k3d', ['version']);
  k3d.code === 0 ? ok(`k3d ${(k3d.stdout.match(/v[\d.]+/) || [''])[0]}`) : bad('k3d', hint.k3d);
  out('kubectl', ['version', '--client']).code === 0 ? ok('kubectl installed') : bad('kubectl', hint.kubectl);
  Number(process.versions.node.split('.')[0]) >= 20 ? ok(`node v${process.versions.node}`) : bad('node >= 20', 'https://nodejs.org');
  const g = out('gemini', ['--version']);
  g.code === 0 ? ok(`gemini ${g.stdout.trim().split('\n')[0]}`) : bad('Gemini CLI', 'npm install -g @google/gemini-cli');
  process.env.GEMINI_API_KEY ? ok('GEMINI_API_KEY is set') : bad('GEMINI_API_KEY', hint.key);
  out('npx', ['-y', 'kubernetes-mcp-server@latest', '--version']).code === 0
    ? ok('kubernetes-mcp-server downloads and runs')
    : bad('kubernetes-mcp-server', 'Check your network, then: npx -y kubernetes-mcp-server@latest --version');

  console.log(fail ? '\nFix the FAIL items above.' : '\nAll good. See you at the workshop.');
  process.exit(fail);
}

function awake() {
  console.log('Keeping this machine awake for 2h. Ctrl+C to stop.');
  if (process.platform === 'darwin') process.exit(run('caffeinate', ['-dims', '-t', '7200']));
  if (WIN) {
    const ps = "Add-Type -Namespace W -Name P -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; [W.P]::SetThreadExecutionState(0x80000003) | Out-Null; Start-Sleep 7200";
    process.exit(run('powershell', ['-NoProfile', '-Command', ps]));
  }
  if (out('systemd-inhibit', ['--version']).code === 0)
    process.exit(run('systemd-inhibit', ['--what=idle:sleep', '--why=SRE workshop', 'sleep', '7200']));
  die('No systemd-inhibit found. Disable sleep in your desktop power settings instead.');
}

const table = {
  help: [() => help(), 'Show commands'],
  awake: [awake, 'Keep this machine awake for 2h (macOS, Linux, Windows)'],
  preflight: [preflight, 'Check Docker, k3d, kubectl, node, gemini, API key'],
  up: [() => {
    if (out('k3d', ['cluster', 'get', CLUSTER]).code !== 0) {
      const s = run('k3d', ['cluster', 'create', CLUSTER, '--agents', '1', '--api-port', API]);
      if (s !== 0) die('k3d cluster create failed. Is Docker running? (npm run preflight)');
    }
    run('kubectl', ['config', 'use-context', CTX]); // so plain `kubectl -n shop ...` in the docs hits the lab
    if (kcOut('get', 'ns', 'shop').code !== 0) kc('create', 'namespace', 'shop');
    if (kc('apply', '-n', 'shop', '-f', MANIFEST) !== 0) die('kubectl apply failed');
    rollouts();
    kc('-n', 'shop', 'get', 'pods');
  }, 'Create the k3d cluster and deploy the healthy shop app'],
  down: [() => run('k3d', ['cluster', 'delete', CLUSTER]), 'Delete the lab cluster'],
  status: [() => kc('-n', 'shop', 'get', 'pods'), 'Show shop pods'],
  'break-1': [() => kc('-n', 'shop', 'set', 'image', 'deploy/web', 'nginx=nginx:1.27-alpne'), 'Fault A: typo in the web image tag (ImagePullBackOff)'],
  'break-2': [() => kc('-n', 'shop', 'set', 'env', 'deploy/cart', 'DB_HOST-'), 'Fault B: remove DB_HOST from cart (CrashLoopBackOff)'],
  'break-3': [() => kc('-n', 'shop', 'set', 'env', 'deploy/report', 'MODE=full'), 'Fault C: report generator switched to MODE=full (OOMKilled)'],
  'fix-1': [() => kc('-n', 'shop', 'set', 'image', 'deploy/web', 'nginx=nginx:1.27-alpine'), 'Manual fix for fault A'],
  'fix-2': [() => kc('-n', 'shop', 'set', 'env', 'deploy/cart', 'DB_HOST=postgres.shop.svc.cluster.local'), 'Manual fix for fault B'],
  'fix-3': [() => kc('-n', 'shop', 'set', 'env', 'deploy/report', 'MODE=light'), 'Manual fix for fault C'],
  reset: [async () => {
    kc('apply', '-n', 'shop', '-f', MANIFEST);
    rollouts();
    await sleep(5);
    kc('-n', 'shop', 'get', 'pods');
  }, 'Put the app back to healthy'],
  'agent-ro': [() => writeProfile('readonly'), 'Gemini profile: read-only Kubernetes MCP'],
  'agent-write': [() => writeProfile('write'), 'Gemini profile: write-enabled MCP (dangerous tools removed)'],
  'mcp-check': [mcpCheck, "Verify the agent's tool layer and guardrails (no API key needed)"],
  rbac: [rbac, 'Optional: read-only ServiceAccount kubeconfig, then test it'],
};

function help() {
  console.log('Usage: npm run <command>\n');
  for (const [name, [, desc]] of Object.entries(table)) console.log(`  ${name.padEnd(12)} ${desc}`);
}

const name = process.argv[2] || 'help';
if (!table[name]) { console.error(red(`Unknown command: ${name}\n`)); help(); process.exit(2); }
await table[name][0]();
