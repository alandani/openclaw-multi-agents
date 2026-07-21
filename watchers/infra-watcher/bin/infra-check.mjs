#!/usr/bin/env node
// Infra watcher — read-only checks across Vultr, Hostinger, DomaiNesia/cPanel.
//
// Usage:
//   node infra-check.mjs [--json] [--send] [--on-demand] [--mock <file>] [--verbose]
//
//   --json       print machine-readable JSON result to stdout
//   --send       POST the combined message to OpenClaw /hooks/agent (only if issues)
//   --on-demand  with --send: also send an "all good" message when nothing is wrong
//   --mock       use fixture file instead of live APIs/SSH (see test/fixtures.json)
//   --verbose    log each check as it runs (stderr)
//
// Config: .env at repo root (or ENV_FILE=/path), instances.json at repo root
// (or INSTANCES_JSON=/path). Missing instances.json just skips SSH checks.
//
// Exit codes: 0 = ran (with or without issues), 2 = fatal config error.

import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { connect as tlsConnect } from 'node:tls';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// ---------- config ----------

export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const hash = val.search(/\s#/); // strip trailing comment
    if (hash !== -1) val = val.slice(0, hash).trim();
    val = val.replace(/^["']|["']$/g, '');
    if (key) out[key] = val;
  }
  return out;
}

export function loadConfig() {
  const envPath = process.env.ENV_FILE || resolve(REPO_ROOT, '.env');
  const fileEnv = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  const env = { ...fileEnv, ...process.env }; // real environment wins
  const num = (k, d) => (env[k] && !Number.isNaN(Number(env[k])) ? Number(env[k]) : d);
  return {
    vultrApiKey: env.VULTR_API_KEY || '',
    hostingerApiKey: env.HOSTINGER_API_KEY || '',
    gatewayUrl: (env.OPENCLAW_GATEWAY_URL || '').replace(/\/$/, ''),
    hooksToken: env.OPENCLAW_HOOKS_TOKEN || '',
    waRecipient: env.WA_RECIPIENT_PHONE || '',
    thresholds: {
      cpu: num('THRESHOLD_CPU_PERCENT', 90),
      disk: num('THRESHOLD_DISK_PERCENT', 90),
      ram: num('THRESHOLD_RAM_PERCENT', 90),
      tier1: num('THRESHOLD_EXPIRY_DAYS_TIER1', 30),
      tier2: num('THRESHOLD_EXPIRY_DAYS_TIER2', 14),
      tier3: num('THRESHOLD_EXPIRY_DAYS_TIER3', 7),
    },
  };
}

export function loadInstances() {
  const p = process.env.INSTANCES_JSON || resolve(REPO_ROOT, 'instances.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---------- live dependency implementations ----------

async function liveFetchJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return res.json();
}

function liveSshProbe(entry, host, script) {
  const key = (entry.ssh_key_path || '').replace(/^~(?=\/|$)/, homedir());
  const args = [
    '-i', key,
    '-p', String(entry.ssh_port || 22),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    `${entry.ssh_user}@${host}`,
    script,
  ];
  return new Promise((resolvePromise, reject) => {
    execFile('ssh', args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]));
      else resolvePromise(stdout);
    });
  });
}

function liveSslDaysLeft(host, domain) {
  return new Promise((resolvePromise, reject) => {
    const sock = tlsConnect(
      { host, port: 443, servername: domain, rejectUnauthorized: false, timeout: 10000 },
      () => {
        const cert = sock.getPeerCertificate();
        sock.end();
        if (!cert || !cert.valid_to) return reject(new Error('no certificate presented'));
        resolvePromise(daysBetween(new Date(), new Date(cert.valid_to)));
      },
    );
    sock.on('timeout', () => { sock.destroy(); reject(new Error('TLS timeout')); });
    sock.on('error', reject);
  });
}

export const liveDeps = {
  fetchJson: liveFetchJson,
  sshProbe: liveSshProbe,
  sslDaysLeft: liveSslDaysLeft,
  now: () => new Date(),
};

// ---------- helpers ----------

export function daysBetween(from, to) {
  return Math.ceil((to.getTime() - from.getTime()) / 86400000);
}

function crit(source, text) { return { severity: 'critical', source, text }; }
function warn(source, text) { return { severity: 'warning', source, text }; }

// Expiry tiers: <=tier3 days critical, <=tier1 days warning, beyond that silent.
export function expiryIssue(source, label, kind, daysLeft, t) {
  if (daysLeft < 0) return crit(source, `${label}: ${kind} EXPIRED ${-daysLeft} day(s) ago`);
  if (daysLeft <= t.tier3) return crit(source, `${label}: ${kind} expires in ${daysLeft} day(s) — renew NOW`);
  if (daysLeft <= t.tier2) return warn(source, `${label}: ${kind} expires in ${daysLeft} day(s)`);
  if (daysLeft <= t.tier1) return warn(source, `${label}: ${kind} expires in ${daysLeft} day(s) (heads-up)`);
  return null;
}

function pctIssues(source, label, metrics, t) {
  const issues = [];
  const rules = [
    ['cpu', metrics.cpu, t.cpu], ['RAM', metrics.ram, t.ram], ['disk', metrics.disk, t.disk],
  ];
  for (const [name, value, limit] of rules) {
    if (value == null || value < 0) continue;
    if (name === 'disk' && value >= 98) issues.push(crit(source, `${label}: disk ${value}% — nearly FULL`));
    else if (value > limit) issues.push(warn(source, `${label}: ${name} ${value}% (>${limit}%)`));
  }
  return issues;
}

// ---------- provider checks ----------

export async function checkVultr(cfg, deps, log) {
  const issues = [];
  const byId = {};
  if (!cfg.vultrApiKey) return { issues, byId };
  const headers = { Authorization: `Bearer ${cfg.vultrApiKey}` };
  let cursor = '';
  let count = 0;
  try {
    do {
      const url = `https://api.vultr.com/v2/instances?per_page=100${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await deps.fetchJson(url, headers);
      for (const inst of page.instances || []) {
        count += 1;
        const label = inst.label || inst.hostname || inst.id;
        byId[inst.id] = { host: inst.main_ip, label };
        log(`vultr: ${label} power=${inst.power_status} server=${inst.server_status}`);
        if (inst.power_status !== 'running') {
          issues.push(crit('vultr', `${label}: Vultr instance DOWN (power_status=${inst.power_status})`));
        } else if (inst.server_status === 'locked') {
          issues.push(warn('vultr', `${label}: Vultr instance locked`));
        }
      }
      cursor = page.meta?.links?.next || '';
    } while (cursor);
  } catch (e) {
    issues.push(warn('vultr', `Vultr API check failed: ${e.message}`));
  }
  return { issues, byId, count };
}

function latestMetric(series) {
  const usage = series?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const keys = Object.keys(usage);
  if (!keys.length) return null;
  const last = keys.sort((a, b) => Number(a) - Number(b)).at(-1);
  const v = Number(usage[last]);
  return Number.isFinite(v) ? v : null;
}

export async function checkHostingerVms(cfg, deps, log) {
  const issues = [];
  const byId = {};
  if (!cfg.hostingerApiKey) return { issues, byId };
  const headers = { Authorization: `Bearer ${cfg.hostingerApiKey}` };
  let vms = [];
  try {
    vms = await deps.fetchJson('https://developers.hostinger.com/api/vps/v1/virtual-machines', headers);
    if (!Array.isArray(vms)) vms = vms.data || [];
  } catch (e) {
    issues.push(warn('hostinger', `Hostinger VPS API check failed: ${e.message}`));
    return { issues, byId };
  }
  for (const vm of vms) {
    const label = vm.hostname || String(vm.id);
    byId[String(vm.id)] = { host: vm.ipv4?.[0]?.address, label };
    log(`hostinger: ${label} state=${vm.state}`);
    if (vm.state && vm.state !== 'running') {
      issues.push(crit('hostinger', `${label}: Hostinger VPS DOWN (state=${vm.state})`));
      continue;
    }
    try {
      const to = deps.now();
      const from = new Date(to.getTime() - 30 * 60000);
      const m = await deps.fetchJson(
        `https://developers.hostinger.com/api/vps/v1/virtual-machines/${vm.id}/metrics` +
          `?date_from=${from.toISOString()}&date_to=${to.toISOString()}`,
        headers,
      );
      const cpu = latestMetric(m.cpu_usage);
      const ramBytes = latestMetric(m.ram_usage);
      const diskBytes = latestMetric(m.disk_space);
      const metrics = {
        cpu: cpu != null ? Math.round(cpu) : null,
        ram: ramBytes != null && vm.memory ? Math.round((ramBytes / (vm.memory * 1048576)) * 100) : null,
        disk: diskBytes != null && vm.disk ? Math.round((diskBytes / (vm.disk * 1048576)) * 100) : null,
      };
      log(`hostinger: ${label} cpu=${metrics.cpu} ram=${metrics.ram} disk=${metrics.disk}`);
      issues.push(...pctIssues('hostinger', label, metrics, cfg.thresholds));
    } catch (e) {
      issues.push(warn('hostinger', `${label}: could not read Hostinger metrics (${e.message})`));
    }
  }
  return { issues, byId, count: vms.length };
}

export async function checkHostingerDomains(cfg, deps, log) {
  const issues = [];
  if (!cfg.hostingerApiKey) return { issues };
  const headers = { Authorization: `Bearer ${cfg.hostingerApiKey}` };
  let domains = [];
  try {
    domains = await deps.fetchJson('https://developers.hostinger.com/api/domains/v1/portfolio', headers);
    if (!Array.isArray(domains)) domains = domains.data || [];
  } catch (e) {
    issues.push(warn('hostinger', `Hostinger domains API check failed: ${e.message}`));
    return { issues };
  }
  for (const d of domains) {
    const name = d.domain || d.name;
    const expires = d.expires_at || d.expiration_date;
    if (!name || !expires) continue; // free subdomains etc. have no expiry
    const daysLeft = daysBetween(deps.now(), new Date(expires));
    log(`domain: ${name} expires in ${daysLeft}d`);
    const issue = expiryIssue('hostinger', name, 'domain', daysLeft, cfg.thresholds);
    if (issue) issues.push(issue);
  }
  return { issues, count: domains.length };
}

// ---------- SSH / cPanel checks ----------

const METRICS_SCRIPT = [
  'disk=$(df -P / 2>/dev/null | awk \'NR==2 {gsub(/%/,""); print $5}\')',
  'ram=$(free 2>/dev/null | awk \'/^Mem:/ {printf "%d", ($3/$2)*100}\')',
  'cpu=$(top -bn1 2>/dev/null | grep -m1 -o "[0-9.]* id" | awk \'{print int(100-$1)}\')',
  'echo "METRICS disk=${disk:--1} ram=${ram:--1} cpu=${cpu:--1}"',
].join('\n');

function cpanelScript(backupPath) {
  const bk = backupPath || '/backup';
  return [
    `hd=$(df -P /home 2>/dev/null | awk 'NR==2 {gsub(/%/,""); print $5}')`,
    `bk=$(find ${bk} -mindepth 1 -mtime -2 2>/dev/null | head -n 1)`,
    'echo "CPANEL homedisk=${hd:--1} backup_recent=$([ -n "$bk" ] && echo yes || echo no)"',
  ].join('\n');
}

export function parseProbeOutput(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(METRICS|CPANEL)\s+(.*)$/);
    if (!m) continue;
    const bucket = (out[m[1].toLowerCase()] = {});
    for (const pair of m[2].trim().split(/\s+/)) {
      const [k, v] = pair.split('=');
      bucket[k] = /^-?\d+$/.test(v) ? Number(v) : v;
    }
  }
  return out;
}

export async function checkSshInstances(cfg, instances, hostsById, deps, log) {
  const issues = [];
  for (const entry of instances) {
    const name = entry.name || entry.host || entry.instance_id;
    const resolved = entry.host || hostsById[entry.instance_id]?.host;
    if (!resolved) {
      issues.push(warn('ssh', `${name}: cannot resolve host (no static host and instance_id not found via ${entry.provider} API)`));
      continue;
    }
    const script = entry.cpanel ? `${METRICS_SCRIPT}\n${cpanelScript(entry.backup_path)}` : METRICS_SCRIPT;
    try {
      const parsed = parseProbeOutput(await deps.sshProbe(entry, resolved, script));
      if (!parsed.metrics) throw new Error('no METRICS line in output');
      log(`ssh: ${name} ${JSON.stringify(parsed)}`);
      issues.push(...pctIssues('ssh', name, parsed.metrics, cfg.thresholds));
      if (entry.cpanel) {
        if (!parsed.cpanel) {
          issues.push(warn('cpanel', `${name}: cPanel probe returned no data`));
        } else {
          const hd = parsed.cpanel.homedisk;
          if (hd >= 98) issues.push(crit('cpanel', `${name}: /home disk ${hd}% — quota nearly FULL`));
          else if (hd > cfg.thresholds.disk) issues.push(warn('cpanel', `${name}: /home disk ${hd}% (>${cfg.thresholds.disk}%)`));
          if (parsed.cpanel.backup_recent === 'no') {
            issues.push(warn('cpanel', `${name}: no backup activity in last 48h (${entry.backup_path || '/backup'})`));
          }
        }
      }
    } catch (e) {
      issues.push(warn('ssh', `${name}: SSH check failed (${e.message})`));
    }
    for (const domain of entry.ssl_domains || []) {
      try {
        const daysLeft = await deps.sslDaysLeft(resolved, domain);
        log(`ssl: ${domain} expires in ${daysLeft}d`);
        const issue = expiryIssue('ssl', domain, 'SSL certificate', daysLeft, cfg.thresholds);
        if (issue) issues.push(issue);
      } catch (e) {
        issues.push(warn('ssl', `${domain}: SSL check failed (${e.message})`));
      }
    }
  }
  return { issues, count: instances.length };
}

// ---------- orchestration ----------

export async function runChecks(cfg, instances, deps, log = () => {}) {
  const vultr = await checkVultr(cfg, deps, log);
  const hostinger = await checkHostingerVms(cfg, deps, log);
  const domains = await checkHostingerDomains(cfg, deps, log);
  const ssh = await checkSshInstances(cfg, instances, { ...vultr.byId, ...hostinger.byId }, deps, log);
  const issues = [...vultr.issues, ...hostinger.issues, ...domains.issues, ...ssh.issues];
  issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  return {
    ok: issues.length === 0,
    generatedAt: deps.now().toISOString(),
    counts: {
      vultrInstances: vultr.count || 0,
      hostingerVms: hostinger.count || 0,
      domains: domains.count || 0,
      sshInstances: ssh.count || 0,
    },
    issues,
    message: buildMessage(issues, deps.now()),
  };
}

export function buildMessage(issues, now) {
  if (!issues.length) return null;
  const date = now.toISOString().slice(0, 10);
  const lines = issues.map((i) => `${i.severity === 'critical' ? '🔴' : '🟡'} ${i.text}`);
  return `⚠️ Infra watcher ${date} — ${issues.length} issue(s):\n${lines.join('\n')}`;
}

export function okMessage(result) {
  const c = result.counts;
  return `✅ Infra watcher: all checks passed (${c.vultrInstances} Vultr, ${c.hostingerVms} Hostinger VPS, ${c.domains} domains, ${c.sshInstances} SSH hosts)`;
}

export async function sendToOpenClaw(cfg, text) {
  if (!cfg.gatewayUrl || !cfg.hooksToken || !cfg.waRecipient) {
    throw new Error('OPENCLAW_GATEWAY_URL / OPENCLAW_HOOKS_TOKEN / WA_RECIPIENT_PHONE not all set');
  }
  const res = await fetch(`${cfg.gatewayUrl}/hooks/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.hooksToken}` },
    body: JSON.stringify({
      message: `reply with exactly this text and nothing else:\n${text}`,
      deliver: true,
      channel: 'whatsapp',
      to: cfg.waRecipient,
      timeoutSeconds: 120,
    }),
    signal: AbortSignal.timeout(130000),
  });
  if (!res.ok) throw new Error(`OpenClaw hooks POST failed: HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

// ---------- mock deps (for --mock and tests) ----------

export function mockDeps(fx) {
  return {
    fetchJson: async (url) => {
      for (const [substr, payload] of Object.entries(fx.http || {})) {
        if (url.includes(substr)) {
          if (payload && payload.__error) throw new Error(payload.__error);
          return payload;
        }
      }
      throw new Error(`no fixture for ${url}`);
    },
    sshProbe: async (entry) => {
      const out = (fx.ssh || {})[entry.name];
      if (out == null) throw new Error('no fixture ssh output');
      if (typeof out === 'object' && out.__error) throw new Error(out.__error);
      return out;
    },
    sslDaysLeft: async (_host, domain) => {
      const days = (fx.ssl || {})[domain];
      if (days == null) throw new Error('no fixture ssl entry');
      return days;
    },
    now: () => new Date(fx.now || Date.now()),
  };
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const verbose = has('--verbose');
  const log = verbose ? (m) => process.stderr.write(`[infra-check] ${m}\n`) : () => {};

  const cfg = loadConfig();
  if (!cfg.vultrApiKey && !cfg.hostingerApiKey) {
    process.stderr.write('fatal: neither VULTR_API_KEY nor HOSTINGER_API_KEY is set\n');
    process.exit(2);
  }

  let deps = liveDeps;
  let instances = loadInstances();
  const mockIdx = args.indexOf('--mock');
  if (mockIdx !== -1) {
    const fx = JSON.parse(readFileSync(args[mockIdx + 1], 'utf8'));
    deps = mockDeps(fx);
    if (fx.instances) instances = fx.instances;
  }

  const result = await runChecks(cfg, instances, deps, log);

  if (has('--send')) {
    const text = result.message || (has('--on-demand') ? okMessage(result) : null);
    if (text) {
      try {
        await sendToOpenClaw(cfg, text);
        result.sent = true;
      } catch (e) {
        result.sent = false;
        result.sendError = e.message;
        process.stderr.write(`send failed: ${e.message}\n`);
      }
    } else {
      result.sent = false; // nothing to send — silent unless anomaly
    }
  }

  if (has('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write((result.message || okMessage(result)) + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${e.stack || e.message}\n`);
    process.exit(2);
  });
}
