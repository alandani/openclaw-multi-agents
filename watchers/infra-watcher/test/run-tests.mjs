#!/usr/bin/env node
// Fixture-driven tests for the infra watcher. Run: node test/run-tests.mjs
import assert from 'node:assert/strict';
import {
  runChecks, buildMessage, okMessage, expiryIssue, parseProbeOutput, parseEnvFile, mockDeps,
} from '../bin/infra-check.mjs';

const cfg = {
  vultrApiKey: 'test', hostingerApiKey: 'test',
  thresholds: { cpu: 90, disk: 90, ram: 90, tier1: 30, tier2: 14, tier3: 7 },
};
const NOW = '2026-07-21T08:00:00.000Z';
const daysFromNow = (n) => new Date(Date.parse(NOW) + n * 86400000).toISOString();

const healthyHttp = {
  'api.vultr.com/v2/instances': {
    instances: [{ id: 'v1', label: 'site-a', main_ip: '203.0.113.10', power_status: 'running', server_status: 'ok' }],
    meta: { links: { next: '' } },
  },
  '/vps/v1/virtual-machines/101/metrics': {
    cpu_usage: { unit: '%', usage: { 1752940800: 12 } },
    ram_usage: { unit: 'bytes', usage: { 1752940800: 1073741824 } },  // 1 GiB
    disk_space: { unit: 'bytes', usage: { 1752940800: 21474836480 } }, // 20 GiB
  },
  '/vps/v1/virtual-machines': [
    { id: 101, hostname: 'site-c', state: 'running', ipv4: [{ address: '203.0.113.20' }], memory: 4096, disk: 51200 },
  ],
  '/domains/v1/portfolio': [
    { domain: 'healthy.com', expires_at: daysFromNow(200) },
    { domain: 'no-expiry-subdomain', expires_at: null },
  ],
};

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ok — ${name}`); })
    .catch((e) => { console.error(`  FAIL — ${name}\n    ${e.message}`); process.exitCode = 1; });
}

// --- unit: expiry tiers ---
await test('expiry tiers map to spec severities', () => {
  const t = cfg.thresholds;
  assert.equal(expiryIssue('x', 'd.com', 'domain', 31, t), null);
  assert.equal(expiryIssue('x', 'd.com', 'domain', 30, t).severity, 'warning');
  assert.match(expiryIssue('x', 'd.com', 'domain', 30, t).text, /heads-up/);
  assert.equal(expiryIssue('x', 'd.com', 'domain', 14, t).severity, 'warning');
  assert.doesNotMatch(expiryIssue('x', 'd.com', 'domain', 14, t).text, /heads-up/);
  assert.equal(expiryIssue('x', 'd.com', 'domain', 7, t).severity, 'critical');
  assert.match(expiryIssue('x', 'd.com', 'domain', -2, t).text, /EXPIRED 2 day/);
});

// --- unit: probe output parsing ---
await test('SSH probe output parses METRICS and CPANEL lines', () => {
  const p = parseProbeOutput('METRICS disk=92 ram=41 cpu=7\nCPANEL homedisk=99 backup_recent=no\n');
  assert.deepEqual(p.metrics, { disk: 92, ram: 41, cpu: 7 });
  assert.deepEqual(p.cpanel, { homedisk: 99, backup_recent: 'no' });
});

// --- unit: env parsing ---
await test('env parser strips comments and quotes', () => {
  const e = parseEnvFile('A=1  # note\nB="x y"\n# comment\nC=\n');
  assert.deepEqual(e, { A: '1', B: 'x y', C: '' });
});

// --- scenario: everything healthy → silent ---
await test('healthy run produces no issues and null message', async () => {
  const r = await runChecks(cfg, [], mockDeps({ now: NOW, http: healthyHttp }), () => {});
  assert.deepEqual(r.issues, []);
  assert.equal(r.ok, true);
  assert.equal(r.message, null);
  assert.match(okMessage(r), /all checks passed \(1 Vultr, 1 Hostinger VPS, 2 domains, 0 SSH hosts\)/);
});

// --- scenario: multiple failures → ONE combined message, critical first ---
await test('multiple failures combine into one message, critical first', async () => {
  const http = structuredClone(healthyHttp);
  http['api.vultr.com/v2/instances'].instances[0].power_status = 'stopped';
  http['/domains/v1/portfolio'].push({ domain: 'soon.com', expires_at: daysFromNow(25) });
  http['/vps/v1/virtual-machines/101/metrics'].cpu_usage.usage = { 1752940800: 97 };
  const instances = [
    { provider: 'domainesia', host: '203.0.113.30', name: 'site-d', ssh_user: 'u', ssh_key_path: 'k', cpanel: true },
  ];
  const ssh = { 'site-d': 'METRICS disk=93 ram=12 cpu=4\nCPANEL homedisk=45 backup_recent=no\n' };
  const r = await runChecks(cfg, instances, mockDeps({ now: NOW, http, ssh }), () => {});

  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 5);
  assert.equal(r.issues[0].severity, 'critical'); // sorted critical-first
  const msg = r.message;
  assert.equal(typeof msg, 'string');
  assert.match(msg, /⚠️ Infra watcher 2026-07-21 — 5 issue\(s\):/);
  assert.match(msg, /🔴 site-a: Vultr instance DOWN \(power_status=stopped\)/);
  assert.match(msg, /🟡 site-c: cpu 97% \(>90%\)/);
  assert.match(msg, /🟡 soon\.com: domain expires in 25 day\(s\) \(heads-up\)/);
  assert.match(msg, /🟡 site-d: disk 93% \(>90%\)/);
  assert.match(msg, /🟡 site-d: no backup activity in last 48h/);
  // ONE message: exactly one header line
  assert.equal((msg.match(/Infra watcher/g) || []).length, 1);
});

// --- scenario: hostinger RAM % derived from bytes vs plan size ---
await test('hostinger RAM/disk percentages derived from bytes', async () => {
  const http = structuredClone(healthyHttp);
  // 3.9 GiB used of 4096 MB plan → ~98% RAM; 49 GiB of 50 GiB disk → 98% → critical
  http['/vps/v1/virtual-machines/101/metrics'].ram_usage.usage = { 1752940800: 4187593113 };
  http['/vps/v1/virtual-machines/101/metrics'].disk_space.usage = { 1752940800: 52613349376 };
  const r = await runChecks(cfg, [], mockDeps({ now: NOW, http }), () => {});
  assert.match(r.message, /🟡 site-c: RAM 97% \(>90%\)/);
  assert.match(r.message, /🔴 site-c: disk 98% — nearly FULL/);
});

// --- scenario: instance down suppresses metrics fetch ---
await test('down hostinger VPS reports DOWN and skips metrics', async () => {
  const http = structuredClone(healthyHttp);
  http['/vps/v1/virtual-machines'][0].state = 'stopped';
  delete http['/vps/v1/virtual-machines/101/metrics'];
  const r = await runChecks(cfg, [], mockDeps({ now: NOW, http }), () => {});
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0].text, /site-c: Hostinger VPS DOWN \(state=stopped\)/);
});

// --- scenario: API failure surfaces as warning, not silence ---
await test('provider API failure becomes a warning issue', async () => {
  const http = structuredClone(healthyHttp);
  http['api.vultr.com/v2/instances'] = { __error: 'HTTP 401 from /v2/instances' };
  const r = await runChecks(cfg, [], mockDeps({ now: NOW, http }), () => {});
  assert.match(r.message, /🟡 Vultr API check failed: HTTP 401/);
});

// --- scenario: SSH failure + unresolvable host are warnings ---
await test('SSH failure and unresolvable instance_id become warnings', async () => {
  const instances = [
    { provider: 'vultr', instance_id: 'v1', name: 'site-a', ssh_user: 'u', ssh_key_path: 'k' },
    { provider: 'vultr', instance_id: 'ghost', name: 'site-x', ssh_user: 'u', ssh_key_path: 'k' },
  ];
  const ssh = { 'site-a': { __error: 'Permission denied (publickey)' } };
  const r = await runChecks(cfg, instances, mockDeps({ now: NOW, http: healthyHttp, ssh }), () => {});
  assert.match(r.message, /🟡 site-a: SSH check failed \(Permission denied/);
  assert.match(r.message, /🟡 site-x: cannot resolve host/);
});

// --- scenario: SSL expiry via TLS probe ---
await test('expiring SSL cert on an instance domain is flagged', async () => {
  const instances = [
    { provider: 'domainesia', host: 'h', name: 'site-d', ssh_user: 'u', ssh_key_path: 'k', ssl_domains: ['shop.example.id'] },
  ];
  const fx = { now: NOW, http: healthyHttp, ssh: { 'site-d': 'METRICS disk=10 ram=10 cpu=10\n' }, ssl: { 'shop.example.id': 10 } };
  const r = await runChecks(cfg, instances, mockDeps(fx), () => {});
  assert.match(r.message, /🟡 shop\.example\.id: SSL certificate expires in 10 day\(s\)/);
});

// --- buildMessage edge ---
await test('buildMessage returns null with no issues', () => {
  assert.equal(buildMessage([], new Date(NOW)), null);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', with FAILURES' : ''}`);
