#!/usr/bin/env node
// Provider-agnostic domain expiry check via WHOIS. Reads domain names from
// domains_to_watch.json (repo root) and reports days-until-expiry for each,
// sorted soonest-first. No registrar credential needed - expiry is public
// WHOIS data, so this covers Hostinger, DomaiNesia, or any other registrar
// with the same script.
//
// Usage:
//   node domain-check.mjs              # full report, human-readable
//   node domain-check.mjs --json       # machine-readable
//   node domain-check.mjs example.com  # check a single domain, ignore the list

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIST_PATH = join(__dirname, '..', '..', 'domains_to_watch.json');

const EXPIRY_PATTERNS = [
  /Registry Expiry Date:\s*(.+)/i,
  /Registrar Registration Expiration Date:\s*(.+)/i,
  /Expiry Date:\s*(.+)/i,
  /Expiration Date:\s*(.+)/i,
  /Expiration Time:\s*(.+)/i,
  /paid-till:\s*(.+)/i,
  /renewal date:\s*(.+)/i,
];

const WARN_TIERS = [
  { days: 7, severity: 'critical', emoji: '🔴' },
  { days: 14, severity: 'warning', emoji: '🟡' },
  { days: 30, severity: 'warning', emoji: '🟡' },
];

function runWhois(domain) {
  return new Promise((resolve, reject) => {
    execFile('whois', [domain], { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // whois exits non-zero for some registries even on a valid response; use stdout regardless
      if (stdout) return resolve(stdout);
      reject(err || new Error('empty whois response'));
    });
  });
}

function parseExpiry(whoisText) {
  for (const re of EXPIRY_PATTERNS) {
    const m = whoisText.match(re);
    if (m) {
      const d = new Date(m[1].trim());
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

async function checkDomain(domain) {
  try {
    const text = await runWhois(domain);
    const expiry = parseExpiry(text);
    if (!expiry) {
      return { domain, ok: false, error: 'could not parse expiry date from whois output' };
    }
    const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
    let severity = 'ok';
    for (const tier of WARN_TIERS) {
      if (daysLeft <= tier.days) { severity = tier.severity; break; }
    }
    return { domain, ok: true, expiresAt: expiry.toISOString(), daysLeft, severity };
  } catch (err) {
    return { domain, ok: false, error: String(err.message || err) };
  }
}

function loadDomainList() {
  try {
    const raw = JSON.parse(readFileSync(LIST_PATH, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('domains_to_watch.json must be a JSON array');
    return raw;
  } catch (err) {
    console.error(`Could not read ${LIST_PATH}: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const singleDomain = args.find((a) => !a.startsWith('--'));

  const domains = singleDomain ? [singleDomain] : loadDomainList();
  const results = await Promise.all(domains.map(checkDomain));
  results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity);
  });

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const r of results) {
    if (!r.ok) {
      console.log(`⚠️  ${r.domain}: ${r.error}`);
      continue;
    }
    const tier = WARN_TIERS.find((t) => r.daysLeft <= t.days);
    const emoji = tier ? tier.emoji : '🟢';
    console.log(`${emoji} ${r.domain}: expires ${r.expiresAt.slice(0, 10)} (${r.daysLeft} days left)`);
  }
}

main();
