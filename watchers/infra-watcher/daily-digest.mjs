#!/usr/bin/env node

/**
 * infra-watcher daily digest — cron-safe wrapper
 * 
 * This script runs the daily infra checks and outputs a formatted digest.
 * It's designed to be called by cron jobs with no MCP/subagent context.
 * 
 * Usage:
 *   node daily-digest.mjs
 *   node daily-digest.mjs --json
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonOutput = process.argv.includes('--json');

async function runDigest() {
  const results = {
    timestamp: new Date().toISOString(),
    checks: {},
    errors: []
  };

  // 1. Vultr instances
  try {
    const output = execSync(`node ${path.join(__dirname, 'vultr-status.mjs')} --json`, { encoding: 'utf8' });
    results.checks.vultr_instances = JSON.parse(output);
  } catch (e) {
    results.errors.push(`Vultr instances check failed: ${e.message}`);
  }

  // 2. Domain expiry
  try {
    const output = execSync(`node ${path.join(__dirname, 'domain-check.mjs')} --json`, { encoding: 'utf8' });
    results.checks.domains = JSON.parse(output);
  } catch (e) {
    results.errors.push(`Domain check failed: ${e.message}`);
  }

  // 3. SSH check — iterate every instance in instances.json
  try {
    const sshKey = path.join(process.env.HOME, '.ssh', 'infra_watcher_ed25519');
    if (fs.existsSync(sshKey)) {
      const instances = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'Documents/Code/OpenClaw/openclaw-multi-agents', 'instances.json'), 'utf8'));
      results.checks.ssh_summary = [];

      for (const inst of instances) {
        const host = inst.ip || inst.host;
        if (!host) continue;

        try {
          const output = execSync(
            `ssh -i ${sshKey} -p ${inst.ssh_port || 22} -o BatchMode=yes -o ConnectTimeout=6 ${inst.ssh_user}@${host} summary`,
            { encoding: 'utf8', timeout: 10000 }
          );
          results.checks.ssh_summary.push({
            host: inst.name,
            output: output.trim()
          });
        } catch (e) {
          results.errors.push(`SSH to ${inst.name} failed: ${e.message}`);
        }
      }
    }
  } catch (e) {
    results.errors.push(`SSH setup failed: ${e.message}`);
  }

  return results;
}

function checkThresholds(data) {
  const alerts = [];
  
  // Domain expiry thresholds: 🔴 ≤7d, 🟡 ≤14d, 🟢 >14d
  if (data.checks.domains) {
    data.checks.domains.forEach(d => {
      if (d.daysLeft <= 7) {
        alerts.push({ severity: 'critical', message: `🔴 ${d.domain} expires in ${d.daysLeft}d — URGENT RENEWAL NEEDED` });
      } else if (d.daysLeft <= 14) {
        alerts.push({ severity: 'warning', message: `🟡 ${d.domain} expires in ${d.daysLeft}d — renew soon` });
      }
    });
  }
  
  // SSH thresholds: disk/mem/cpu >90% = critical
  if (data.checks.ssh_summary && Array.isArray(data.checks.ssh_summary)) {
    data.checks.ssh_summary.forEach(s => {
      const lines = s.output.split('\n');
      lines.forEach(line => {
        // Parse disk: "92% /" pattern from df output (space + percent + space + /)
        const diskMatch = line.match(/\s+([0-9.]+)%\s+\/$/);
        const diskPercent = diskMatch ? parseFloat(diskMatch[1]) : null;
        if (diskPercent && diskPercent > 90) {
          alerts.push({ severity: 'critical', message: `🔴 ${s.host} disk at ${diskPercent}% — CRITICAL` });
        } else if (diskPercent && diskPercent > 80) {
          alerts.push({ severity: 'warning', message: `🟡 ${s.host} disk at ${diskPercent}% — monitor closely` });
        }
        
        const memMatch = line.match(/Memory[:\s]+([0-9.]+)%/);
        const memPercent = memMatch ? parseFloat(memMatch[1]) : null;
        if (memPercent && memPercent > 90) {
          alerts.push({ severity: 'critical', message: `🔴 ${s.host} memory at ${memPercent}% — CRITICAL` });
        } else if (memPercent && memPercent > 80) {
          alerts.push({ severity: 'warning', message: `🟡 ${s.host} memory at ${memPercent}% — monitor closely` });
        }
        
        const cpuMatch = line.match(/CPU[:\s]+([0-9.]+)%/);
        const cpuPercent = cpuMatch ? parseFloat(cpuMatch[1]) : null;
        if (cpuPercent && cpuPercent > 90) {
          alerts.push({ severity: 'warning', message: `🟡 ${s.host} CPU at ${cpuPercent}% — check load` });
        } else if (cpuPercent && cpuPercent > 80) {
          alerts.push({ severity: 'warning', message: `🟡 ${s.host} CPU at ${cpuPercent}% — elevated` });
        }
      });
    });
  }
  
  return alerts;
}

function formatDigest(data) {
  const lines = [];
  const alerts = checkThresholds(data);
  const hasCritical = alerts.some(a => a.severity === 'critical');
  
  // Alert banner if critical issues
  if (hasCritical) {
    lines.push('🚨 *CRITICAL ALERTS* 🚨');
    alerts.filter(a => a.severity === 'critical').forEach(a => lines.push(a.message));
    lines.push('');
  }
  
  lines.push('**INFRA DIGEST** 🔧');
  lines.push(`*${new Date(data.timestamp).toLocaleDateString()}*\n`);

  // Vultr instances
  if (data.checks.vultr_instances) {
    lines.push('**VULTR INSTANCES** (' + data.checks.vultr_instances.length + ' active)');
    data.checks.vultr_instances.forEach(inst => {
      lines.push(`🟢 ${inst.label} — ${inst.vcpu}vCPU, ${inst.ram_mb}MB RAM, ${inst.disk_gb}GB`);
    });
    lines.push('');
  }

  // Domains
  if (data.checks.domains) {
    lines.push('**DOMAINS**');
    data.checks.domains.forEach(d => {
      const emoji = d.severity === 'ok' ? '🟢' : d.severity === 'warning' ? '🟡' : '🔴';
      lines.push(`${emoji} ${d.domain} — ${d.daysLeft}d left`);
    });
    lines.push('');
  }

  // SSH summary
  if (data.checks.ssh_summary && data.checks.ssh_summary.length > 0) {
    lines.push('**SSH CHECK**');
    data.checks.ssh_summary.forEach(s => {
      lines.push(`--- ${s.host} ---`);
      lines.push(s.output);
    });
    lines.push('');
  }

  // Errors
  if (data.errors.length > 0) {
    lines.push('**ERRORS**');
    data.errors.forEach(e => lines.push(`⚠️ ${e}`));
    lines.push('');
  }

  // Non-critical warnings
  const warnings = alerts.filter(a => a.severity === 'warning');
  if (warnings.length > 0) {
    lines.push('**WARNINGS**');
    warnings.forEach(w => lines.push(w.message));
    lines.push('');
  }

  const status = hasCritical ? '🚨 ACTION REQUIRED' : 'All systems nominal.' + (data.checks.domains?.some(d => d.severity !== 'ok') ? ' ⚠️ Check domain renewals.' : '');
  lines.push('**STATUS:** ' + status);

  return lines.join('\n');
}

async function main() {
  const data = await runDigest();
  const alerts = checkThresholds(data);
  const hasCritical = alerts.some(a => a.severity === 'critical');
  const hasWarnings = alerts.some(a => a.severity === 'warning');

  // Only send if there are alerts (critical or warning)
  if (!hasCritical && !hasWarnings) {
    if (jsonOutput) {
      console.log(JSON.stringify({ status: 'ok', message: 'All systems nominal' }, null, 2));
    }
    // Exit silently for non-JSON mode — no message sent
    process.exit(0);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatDigest(data));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
