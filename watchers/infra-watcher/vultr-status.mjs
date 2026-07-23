#!/usr/bin/env node
// Direct Vultr REST API fallback for instance list/status. Exists because
// the Vultr MCP server (rsp2k/mcp-vultr) has no tool to list instances or
// get instance status - only sub-operations that need an instance_id you
// already have (bandwidth, ipv4/ipv6, start/stop/reboot). Instance listing
// is exposed only as an MCP *resource* (instances://instance/list), which
// OpenClaw's agent tooling cannot read (tools/call only) - so this script
// is the practical way to get that one data point, same "MCP-first, not
// MCP-only" pattern already used for domain expiry via WHOIS.
//
// Usage:
//   node vultr-status.mjs           # human-readable
//   node vultr-status.mjs --json    # machine-readable

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const execFileP = promisify(execFile);

function loadApiKey() {
  if (process.env.VULTR_API_KEY) return process.env.VULTR_API_KEY;
  // Fall back to the repo's own .env rather than depending on the calling
  // shell/cron job having exported it - avoids the env-var-visibility
  // gotcha already documented in CLAUDE.md.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, '..', '..', '.env');
  const text = readFileSync(envPath, 'utf8');
  const m = text.match(/^VULTR_API_KEY=(\S+)/m);
  return m ? m[1] : null;
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error('VULTR_API_KEY not set (checked env and repo .env)');
  process.exit(1);
}

// Shells out to curl rather than using Node's own fetch: on this machine,
// Node's fetch reliably times out/unreaches on this exact host (both IPv4
// and IPv6) while curl to the identical URL succeeds - almost certainly a
// per-process network filter (e.g. GlobalProtect VPN client), not a Vultr
// or code issue. Same execFile-a-CLI-tool pattern domain-check.mjs uses.
const { stdout } = await execFileP(
  'curl',
  ['-s', '-H', `Authorization: Bearer ${apiKey}`, 'https://api.vultr.com/v2/instances'],
  { timeout: 15000, maxBuffer: 1024 * 1024 }
);
const { instances = [] } = JSON.parse(stdout);

const summary = instances.map((i) => ({
  label: i.label || i.hostname || i.id,
  region: i.region,
  status: i.status,
  power_status: i.power_status,
  server_status: i.server_status,
  vcpu: i.vcpu_count,
  ram_mb: i.ram,
  disk_gb: i.disk,
}));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`${summary.length} Vultr instance(s):`);
  for (const i of summary) {
    const healthy = i.power_status === 'running' && i.server_status !== 'locked';
    console.log(
      `${healthy ? '🟢' : '🔴'} ${i.label} (${i.region}): power=${i.power_status}, server=${i.server_status}, ${i.vcpu} vCPU / ${i.ram_mb}MB RAM / ${i.disk_gb}GB disk`
    );
  }
}
