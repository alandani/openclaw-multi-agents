#!/bin/sh
# Forced-command target for the infra-ops mutate-capable SSH key. Installed
# identically on every managed server and wired up via authorized_keys as:
#
#   command="/opt/infra-ops/ops-check.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... infra-ops@mac-mini
#
# sshd puts whatever the client asked to run into $SSH_ORIGINAL_COMMAND. That
# string is split into words (verb + args) via `set --`, which is plain
# whitespace word-splitting — it does NOT invoke a shell, so characters like
# ; | & ` $() stay inert literal bytes inside a word, never executed as
# commands. `set -f` disables pathname globbing so a `*` or `?` in the
# original command can't expand against files on the server either. Every
# argument is then validated against a strict charset before being passed,
# as a single argv element, straight to the target binary (systemctl,
# docker, ...) — never through `sh -c` or `eval` — so shell injection isn't
# possible regardless of what a compromised/malicious client sends.
#
# Scope: this is v1 — it covers AGENT.md's Category A (read-only) and the
# most common Category B action (service/container restart-reload). The
# harder-to-safely-parameterize categories (arbitrary rsync, free-form SQL,
# wp search-replace, ad hoc file edits) are deliberately NOT implemented
# here yet — unrecognized verbs are rejected, same as anything else not on
# this list. ops/infra-ops/AGENT.md's self-policed allowlist still governs
# those until a safe, parameterized form is designed for them.
#
# The confirmation gate (AGENT.md "Mandatory Confirmation Gate") happens at
# the agent/LLM layer, before this script is ever invoked — by the time a
# Category B verb reaches here, confirmation has already happened. This
# script's job is narrower and absolute: make sure only these exact verbs,
# with validated arguments, can run at all — nothing else, confirmed or not.

set -euf

# --- arg validation ---------------------------------------------------------

# systemd unit / docker name charset, plus '@' for systemd template units
# (app@1.service). Never empty, never starting with '-' (flag injection into
# the target binary).
valid_name() {
  case "$1" in
    '') return 1 ;;
    -*) return 1 ;;
    *[!A-Za-z0-9_.@-]*) return 1 ;;
    *) return 0 ;;
  esac
}

# digits only, 1-4 chars (caps requested log lines at 9999)
valid_lines() {
  case "$1" in
    '') return 1 ;;
    *[!0-9]*) return 1 ;;
    ?????*) return 1 ;;
    *) return 0 ;;
  esac
}

# relative-ish path for docker compose project dirs: no '..', no leading '-'
valid_dir() {
  case "$1" in
    '') return 1 ;;
    -*) return 1 ;;
    *..*) return 1 ;;
    *[!A-Za-z0-9_./-]*) return 1 ;;
    *) return 0 ;;
  esac
}

reject() {
  echo "rejected: $1" >&2
  exit 1
}

# --- Category A: read-only, always allowed ----------------------------------

service_status() {
  valid_name "${1:-}" || reject "invalid or missing service name"
  systemctl status "$1" --no-pager
}

service_logs() {
  valid_name "${1:-}" || reject "invalid or missing service name"
  n="${2:-50}"
  valid_lines "$n" || reject "invalid line count"
  journalctl -u "$1" -n "$n" --no-pager
}

docker_ps() {
  docker ps -a
}

docker_logs() {
  valid_name "${1:-}" || reject "invalid or missing container name"
  n="${2:-50}"
  valid_lines "$n" || reject "invalid line count"
  docker logs --tail "$n" "$1"
}

compose_ps() {
  valid_dir "${1:-}" || reject "invalid or missing compose project dir"
  (cd "$1" && docker compose ps)
}

procs() {
  top -bn1 | head -30
}

uptime_check() {
  uptime
}

# --- Category B: service/container restart-reload ---------------------------
# Confirmation already happened at the agent layer before this ran.

service_restart() {
  valid_name "${1:-}" || reject "invalid or missing service name"
  systemctl restart "$1"
}

service_reload() {
  valid_name "${1:-}" || reject "invalid or missing service name"
  systemctl reload "$1"
}

docker_restart() {
  valid_name "${1:-}" || reject "invalid or missing container name"
  docker restart "$1"
}

compose_restart() {
  valid_dir "${1:-}" || reject "invalid or missing compose project dir"
  if [ -n "${2:-}" ]; then
    valid_name "$2" || reject "invalid service name"
    (cd "$1" && docker compose restart "$2")
  else
    (cd "$1" && docker compose restart)
  fi
}

supervisor_restart() {
  valid_name "${1:-}" || reject "invalid or missing program name"
  supervisorctl restart "$1"
}

help() {
  cat <<'EOF'
infra-ops forced-command wrapper — supported verbs:

Read-only (Category A):
  service-status <service>
  service-logs <service> [lines=50]
  docker-ps
  docker-logs <container> [lines=50]
  compose-ps <dir>
  procs
  uptime

Mutating — confirmation is enforced at the agent layer, before this ever
runs (Category B):
  service-restart <service>
  service-reload <service>
  docker-restart <container>
  compose-restart <dir> [service]
  supervisor-restart <program>

Everything else is rejected — not yet implemented in this wrapper. See
ops/infra-ops/AGENT.md's self-policed allowlist for what's still manual
(deploy/update, database/WordPress, package install, file transfer).
EOF
}

# --- dispatch ----------------------------------------------------------------
# Plain word-splitting on $SSH_ORIGINAL_COMMAND (not a shell re-parse — `set
# -f` above already killed globbing) so verb/args separate on whitespace only.
raw="${SSH_ORIGINAL_COMMAND:-}"
# shellcheck disable=SC2086
set -- $raw

if [ "$#" -eq 0 ]; then
  help
  exit 0
fi

verb="$1"
shift

case "$verb" in
  service-status)     service_status "$@" ;;
  service-logs)       service_logs "$@" ;;
  docker-ps)          docker_ps ;;
  docker-logs)        docker_logs "$@" ;;
  compose-ps)         compose_ps "$@" ;;
  procs)              procs ;;
  uptime)             uptime_check ;;
  service-restart)    service_restart "$@" ;;
  service-reload)     service_reload "$@" ;;
  docker-restart)     docker_restart "$@" ;;
  compose-restart)    compose_restart "$@" ;;
  supervisor-restart) supervisor_restart "$@" ;;
  help)               help ;;
  *)
    echo "rejected: unknown verb '$verb' (run the 'help' verb for the list)" >&2
    exit 1
    ;;
esac
