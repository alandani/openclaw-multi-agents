# Deploying the infra-watcher SSH key

This has to be done manually per server — I have no existing credential to reach
any of these 5 boxes yet (tested `ssh -i ~/.ssh/id_ed25519` against all of them,
all came back `Permission denied`). Use whatever access you already have (Vultr
web console, an existing key, etc.) to run the steps below once per server.

A dedicated keypair was generated locally at:
- Private: `~/.ssh/infra_watcher_ed25519` (stays on the Mac Mini, never leaves it)
- Public: `~/.ssh/infra_watcher_ed25519.pub`

It is passphrase-less (needed for non-interactive/automated calls) but restricted
at the SSH layer via a forced command — see `readonly-check.sh` in this folder.
Even if this key alone leaked, it cannot do anything beyond `disk`/`mem`/`cpu`/
`cpanel`/`summary` reads on the specific server it's installed on.

## Per-server steps (repeat for all 5)

1. Copy `readonly-check.sh` to the server and place it at a fixed path:
   ```
   scp watchers/infra-watcher/remote/readonly-check.sh root@<server-ip>:/opt/infra-watcher/readonly-check.sh
   ```
   (create `/opt/infra-watcher/` first if it doesn't exist: `ssh root@<ip> mkdir -p /opt/infra-watcher`)

2. Make it executable:
   ```
   ssh root@<server-ip> chmod 755 /opt/infra-watcher/readonly-check.sh
   ```

3. Append this line to `/root/.ssh/authorized_keys` on the server (this is the
   part that actually restricts the key — do not add it without the `command=...`
   prefix, or you get an unrestricted root shell instead):
   ```
   command="/opt/infra-watcher/readonly-check.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILUYSdmFShK4j349Bl3qFx662+Xfq8jMinOdkhxv6v4h infra-watcher@mac-mini
   ```

## Servers to install this on

| Name | IP |
|---|---|
| SIGAP GERINDRA | 149.28.152.242 |
| ULAK WAYKANAN | 139.180.141.216 |
| ERP BUMIADIL | 139.180.216.195 |
| HAMS ERP31 | 149.28.142.7 |
| GRADIEN | 139.180.142.26 |

## Verifying after install (run from the Mac Mini)

```
ssh -i ~/.ssh/infra_watcher_ed25519 root@<server-ip> disk
ssh -i ~/.ssh/infra_watcher_ed25519 root@<server-ip> mem
ssh -i ~/.ssh/infra_watcher_ed25519 root@<server-ip> cpu
ssh -i ~/.ssh/infra_watcher_ed25519 root@<server-ip>          # no verb -> summary
```

Also confirm the restriction actually holds — this should be rejected, not run:
```
ssh -i ~/.ssh/infra_watcher_ed25519 root@<server-ip> "rm -rf /"
# expect: "rejected: unknown verb 'rm -rf /' ..." and nothing deleted
```

Once at least one server is verified, tell me and I'll re-run the SSH test suite
against all 5 and wire this into `instances.json` / the OpenClaw skill.
