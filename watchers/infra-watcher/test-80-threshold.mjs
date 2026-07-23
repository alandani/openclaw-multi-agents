#!/usr/bin/env node

const data = {
  checks: {
    ssh_summary: [
      {
        host: 'GRADIEN',
        output: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda2        23G   18G   5G  85% /\nMemory: 82% used\nCPU: 85.0% busy'
      }
    ]
  }
};

function checkThresholds(data) {
  const alerts = [];
  
  if (data.checks.ssh_summary && Array.isArray(data.checks.ssh_summary)) {
    data.checks.ssh_summary.forEach(s => {
      const lines = s.output.split('\n');
      lines.forEach(line => {
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

const alerts = checkThresholds(data);
console.log('Test: Disk 85%, Memory 82%, CPU 85%\n');
alerts.forEach(a => console.log(`[${a.severity.toUpperCase()}] ${a.message}`));
