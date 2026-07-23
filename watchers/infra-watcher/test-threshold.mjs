#!/usr/bin/env node

/**
 * Test script: Simulate critical threshold conditions
 * 
 * This generates fake data to test alert thresholds and WhatsApp delivery.
 * 
 * Usage:
 *   node test-threshold.mjs --scenario critical-domain
 *   node test-threshold.mjs --scenario critical-disk
 *   node test-threshold.mjs --scenario critical-memory
 *   node test-threshold.mjs --scenario multiple-alerts
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenario = process.argv.includes('--scenario') 
  ? process.argv[process.argv.indexOf('--scenario') + 1] 
  : 'critical-domain';

// Threshold detection function (same as in daily-digest.mjs)
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
        // Parse disk: "92% /" pattern from df output
        const diskMatch = line.match(/\s+([0-9.]+)%\s+\/$/);
        const diskPercent = diskMatch ? parseFloat(diskMatch[1]) : null;
        if (diskPercent && diskPercent > 90) {
          alerts.push({ severity: 'critical', message: `🔴 ${s.host} disk at ${diskPercent}% — CRITICAL` });
        }
        
        const memMatch = line.match(/Memory[:\s]+([0-9.]+)%/);
        const memPercent = memMatch ? parseFloat(memMatch[1]) : null;
        if (memPercent && memPercent > 90) {
          alerts.push({ severity: 'critical', message: `🔴 ${s.host} memory at ${memPercent}% — CRITICAL` });
        }
        
        const cpuMatch = line.match(/CPU[:\s]+([0-9.]+)%/);
        const cpuPercent = cpuMatch ? parseFloat(cpuMatch[1]) : null;
        if (cpuPercent && cpuPercent > 90) {
          alerts.push({ severity: 'warning', message: `🟡 ${s.host} CPU at ${cpuPercent}% — check load` });
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
  
  if (hasCritical) {
    lines.push('🚨 *CRITICAL ALERTS* 🚨');
    alerts.filter(a => a.severity === 'critical').forEach(a => lines.push(a.message));
    lines.push('');
  }
  
  lines.push('**INFRA DIGEST** 🔧');
  lines.push(`*${new Date(data.timestamp).toLocaleDateString()}*\n`);

  if (data.checks.vultr_instances) {
    lines.push('**VULTR INSTANCES** (' + data.checks.vultr_instances.length + ' active)');
    data.checks.vultr_instances.forEach(inst => {
      lines.push(`🟢 ${inst.label} — ${inst.vcpu}vCPU, ${inst.ram_mb}MB RAM, ${inst.disk_gb}GB`);
    });
    lines.push('');
  }

  if (data.checks.domains) {
    lines.push('**DOMAINS**');
    data.checks.domains.forEach(d => {
      const emoji = d.severity === 'ok' ? '🟢' : d.severity === 'warning' ? '🟡' : '🔴';
      lines.push(`${emoji} ${d.domain} — ${d.daysLeft}d left`);
    });
    lines.push('');
  }

  if (data.checks.ssh_summary && data.checks.ssh_summary.length > 0) {
    lines.push('**SSH CHECK**');
    data.checks.ssh_summary.forEach(s => {
      lines.push(`--- ${s.host} ---`);
      lines.push(s.output);
    });
    lines.push('');
  }

  const warnings = alerts.filter(a => a.severity === 'warning');
  if (warnings.length > 0) {
    lines.push('**WARNINGS**');
    warnings.forEach(w => lines.push(w.message));
    lines.push('');
  }

  const status = hasCritical ? '🚨 ACTION REQUIRED' : 'All systems nominal.';
  lines.push('**STATUS:** ' + status);

  return lines.join('\n');
}

// Generate test data based on scenario
function generateTestData(scenario) {
  const baseData = {
    timestamp: new Date().toISOString(),
    checks: {
      vultr_instances: [
        { label: 'SIGAP GERINDRA', region: 'sgp', status: 'active', power_status: 'running', server_status: 'ok', vcpu: 1, ram_mb: 1024, disk_gb: 25 },
        { label: 'GRADIEN', region: 'sgp', status: 'active', power_status: 'running', server_status: 'ok', vcpu: 1, ram_mb: 1024, disk_gb: 25 }
      ],
      domains: [
        { domain: 'motorhondalampung.com', ok: true, expiresAt: '2027-07-15T14:11:03.000Z', daysLeft: 358, severity: 'ok' },
        { domain: 'gradien.co', ok: true, expiresAt: '2026-09-02T23:59:59.000Z', daysLeft: 42, severity: 'warning' }
      ],
      ssh_summary: [
        {
          host: 'GRADIEN',
          output: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda2        23G   12G   11G  53% /\nMemory: 65% used\nCPU: 15.0% busy'
        }
      ]
    },
    errors: []
  };

  // Modify based on scenario
  switch (scenario) {
    case 'critical-domain':
      baseData.checks.domains[1].daysLeft = 5;
      baseData.checks.domains[1].severity = 'critical';
      baseData.checks.domains[1].expiresAt = '2026-07-28T23:59:59.000Z';
      break;

    case 'critical-disk':
      baseData.checks.ssh_summary[0].output = 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda2        23G   21G   2G  92% /\nMemory: 65% used\nCPU: 15.0% busy';
      break;

    case 'critical-memory':
      baseData.checks.ssh_summary[0].output = 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda2        23G   12G   11G  53% /\nMemory: 92% used\nCPU: 15.0% busy';
      break;

    case 'multiple-alerts':
      baseData.checks.domains[1].daysLeft = 3;
      baseData.checks.domains[1].severity = 'critical';
      baseData.checks.ssh_summary[0].output = 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda2        23G   21G   2G  95% /\nMemory: 88% used\nCPU: 92.0% busy';
      break;
  }

  return baseData;
}

const testData = generateTestData(scenario);
const formatted = formatDigest(testData);

console.log('TEST SCENARIO:', scenario);
console.log('=====================================\n');
console.log(formatted);
console.log('\n=====================================');
console.log('JSON Output:\n', JSON.stringify(testData, null, 2));
