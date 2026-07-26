#!/usr/bin/env node
// Deploy/update a forced-command SSH script across every server listed in
// instances.json, in one shot, instead of doing it by hand per server.
//
// This is a SHARED tool — it deploys whichever agent's script + key you point
// it at. It has no agent-specific logic of its own, and it never lets one
// agent's key/script pair collide with another's. If you're syncing
// infra-watcher's readonly-check.sh, you get infra-watcher's key installed
// with infra-watcher's command= restriction. Same for infra-ops. Nothing
// about running this for one agent touches the other agent's key or script
// on the server.
//
// Usage:
//   node shared/sync-forced-command.mjs \
//     --script watchers/infra-watcher/remote/readonly-check.sh \
//     --pubkey ~/.ssh/infra_watcher_ed25519.pub \
//     --remote-path /opt/infra-watcher/readonly-check.sh \
//     --key-comment infra-watcher@mac-mini
//
//   node shared/sync-forced-command.mjs \
//     --script ops/infra-ops/remote/ops-check.sh \
//     --pubkey ~/.ssh/infra_ops_ed25519.pub \
//     --remote-path /opt/infra-ops/ops-check.sh \
//     --key-comment infra-ops@mac-mini
//
// Optional:
//   --only <name>     only sync the instances.json entry with this "name"
//                      (repeatable: --only foo --only bar)
//   --dry-run         print what would happen, run nothing
//   --instances-file  path to instances.json (default: repo root instances.json)
//
// What it does per server (idempotent — safe to re-run after editing the
// script or adding a server):
//   1. scp the script to <remote-path> (always overwrites — this is how you
//      "update the verb list": edit the local script, re-run this tool)
//   2. chmod 755 it
//   3. ensure exactly one authorized_keys line exists for this pubkey, with
//      the command="<remote-path>",no-port-forwarding,... restriction —
//      replaces a stale line for the same key if the remote-path changed,
//      never touches other keys' lines (including the other agent's)
//   4. verify by running the deployed script with no args (should return
//      whatever the script's default verb produces, not an error)
//
// What it deliberately does NOT do:
//   - does not generate keypairs (ssh-keygen is a manual, one-time step —
//     see each agent's remote/DEPLOY.md)
//   - does not decide which verbs exist (that's the script's job)
//   - does not read/know about any other agent's config

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = { only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--script") args.script = argv[++i];
    else if (a === "--pubkey") args.pubkey = argv[++i];
    else if (a === "--remote-path") args.remotePath = argv[++i];
    else if (a === "--key-comment") args.keyComment = argv[++i];
    else if (a === "--only") args.only.push(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--instances-file") args.instancesFile = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p;
}

function usage() {
  console.log(`
Usage:
  node shared/sync-forced-command.mjs \\
    --script <path-to-local-script> \\
    --pubkey <path-to-local-.pub-file> \\
    --remote-path <fixed-path-on-server> \\
    --key-comment <comment-suffix-for-authorized_keys>
    [--only <instance-name>]... [--dry-run] [--instances-file <path>]

Deploys the given forced-command script to every server in instances.json
(or just the ones named via --only), and wires the given public key into
authorized_keys restricted to that script. Safe to re-run.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.script || !args.pubkey || !args.remotePath || !args.keyComment) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const scriptPath = path.resolve(repoRoot, args.script);
  const pubkeyPath = expandHome(args.pubkey);
  const instancesPath = args.instancesFile
    ? path.resolve(args.instancesFile)
    : path.join(repoRoot, "instances.json");

  if (!existsSync(scriptPath)) {
    console.error(`Script not found: ${scriptPath}`);
    process.exit(1);
  }
  if (!existsSync(pubkeyPath)) {
    console.error(`Public key not found: ${pubkeyPath}`);
    console.error(`Generate it first (see the agent's remote/DEPLOY.md) — this tool never generates keys.`);
    process.exit(1);
  }
  if (!existsSync(instancesPath)) {
    console.error(`instances.json not found at ${instancesPath}`);
    process.exit(1);
  }

  const instances = JSON.parse(readFileSync(instancesPath, "utf8"));
  const pubkeyRaw = readFileSync(pubkeyPath, "utf8").trim();
  // A .pub file is "<type> <base64-blob> [comment]" — keep only type+blob and
  // apply --key-comment ourselves, so we don't end up with the file's own
  // trailing comment duplicated alongside --key-comment.
  const [keyType, keyBlob] = pubkeyRaw.split(/\s+/);
  const pubkeyContent = `${keyType} ${keyBlob}`;
  const remoteDir = path.posix.dirname(args.remotePath);
  const authorizedKeysLine =
    `command="${args.remotePath}",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ` +
    `${pubkeyContent} ${args.keyComment}`;

  const targets = args.only.length
    ? instances.filter((i) => args.only.includes(i.name))
    : instances;

  if (args.only.length) {
    const missing = args.only.filter((n) => !instances.some((i) => i.name === n));
    if (missing.length) {
      console.error(`--only named instance(s) not found in instances.json: ${missing.join(", ")}`);
      process.exit(1);
    }
  }

  if (!targets.length) {
    console.error("No matching instances to sync.");
    process.exit(1);
  }

  console.log(`Syncing ${scriptPath} -> ${args.remotePath} on ${targets.length} server(s)${args.dryRun ? " [DRY RUN]" : ""}\n`);

  let failures = 0;

  for (const inst of targets) {
    const ip = inst.ip || inst.host;
    if (!ip) {
      console.log(`[${inst.name}] SKIP — no ip/host in instances.json (only provider/instance_id present; resolve via provider API first)`);
      continue;
    }
    const user = inst.ssh_user || "root";
    const port = inst.ssh_port || 22;
    // Deliberately NOT using inst.ssh_key_path here — this tool always deploys
    // via whatever key currently has access to the box (the operator's own
    // key, passed implicitly via ssh-agent / default identity), because the
    // agent's own forced-command key doesn't exist on the server yet the
    // first time this runs. Bootstrapping access is the operator's job.
    const target = `${user}@${ip}`;

    console.log(`[${inst.name}] (${target}:${port})`);

    const run = (cmd, cmdArgs) => {
      if (args.dryRun) {
        console.log(`  DRY: ${cmd} ${cmdArgs.join(" ")}`);
        return "";
      }
      return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    };

    try {
      run("ssh", [
        "-p", String(port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
        target, `mkdir -p ${remoteDir}`,
      ]);

      run("scp", [
        "-P", String(port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
        scriptPath, `${target}:${args.remotePath}`,
      ]);

      run("ssh", [
        "-p", String(port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
        target, `chmod 755 ${args.remotePath}`,
      ]);

      // Idempotent authorized_keys update: strip any existing line for this
      // exact pubkey (by matching the key material, not the comment or the
      // command= path, so a changed remote-path still gets replaced cleanly),
      // then append the current line. Other keys/lines are left untouched.
      const keyMaterial = keyBlob; // the base64 blob, stable identifier regardless of comment
      const updateScript = [
        "set -eu",
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
        "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
        `grep -v '${keyMaterial}' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp || true`,
        `echo '${authorizedKeysLine}' >> ~/.ssh/authorized_keys.tmp`,
        "mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys",
        "chmod 600 ~/.ssh/authorized_keys",
      ].join(" && ");

      run("ssh", [
        "-p", String(port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
        target, updateScript,
      ]);

      if (!args.dryRun) {
        const verify = execFileSync("ssh", [
          "-i", pubkeyPath.replace(/\.pub$/, ""),
          "-p", String(port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
          "-o", "StrictHostKeyChecking=accept-new",
          target,
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        console.log(`  OK — deployed and verified (default verb output: ${verify.trim().split("\n")[0]}...)`);
      } else {
        console.log("  OK — dry run, nothing executed");
      }
    } catch (err) {
      failures++;
      const msg = err.stderr ? err.stderr.toString().trim() : err.message;
      console.error(`  FAILED: ${msg}`);
    }
    console.log("");
  }

  if (failures) {
    console.error(`${failures}/${targets.length} server(s) failed. Fix access/connectivity and re-run — this tool is idempotent, safe to retry.`);
    process.exit(1);
  }
  console.log(`All ${targets.length} server(s) synced successfully.`);
}

main();
