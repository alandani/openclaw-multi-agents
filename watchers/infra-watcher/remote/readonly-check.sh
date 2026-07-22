#!/bin/sh
# Forced-command target for the infra-watcher SSH key. Installed identically on
# every monitored server and wired up via authorized_keys as:
#
#   command="/opt/infra-watcher/readonly-check.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... infra-watcher@mac-mini
#
# sshd puts whatever the client asked to run into $SSH_ORIGINAL_COMMAND — that
# value is NEVER eval'd or passed to a shell here. It is only matched against a
# fixed set of known verbs below; anything else is rejected. This is what makes
# the key safe to hand to an automated caller: even a fully compromised client
# can only ever trigger one of the read-only branches below, never arbitrary
# commands, sudo, or writes.

set -eu

verb="${SSH_ORIGINAL_COMMAND:-summary}"

disk() {
  df -hP -x tmpfs -x devtmpfs -x squashfs
}

mem() {
  free -m
}

cpu() {
  # two /proc/stat samples, 1s apart, awk computes %busy - no top/mpstat dependency
  read -r _ u1 n1 s1 i1 w1 _ < /proc/stat
  sleep 1
  read -r _ u2 n2 s2 i2 w2 _ < /proc/stat
  awk -v u1="$u1" -v n1="$n1" -v s1="$s1" -v i1="$i1" -v w1="$w1" \
      -v u2="$u2" -v n2="$n2" -v s2="$s2" -v i2="$i2" -v w2="$w2" \
      'BEGIN {
         t1=u1+n1+s1+i1+w1; t2=u2+n2+s2+i2+w2;
         idle1=i1+w1; idle2=i2+w2;
         dt=t2-t1; di=idle2-idle1;
         if (dt>0) printf "cpu_busy_pct=%.1f\n", 100*(dt-di)/dt;
         else print "cpu_busy_pct=0.0";
       }'
}

cpanel() {
  if [ -x /usr/local/cpanel/cpanel ]; then
    whmapi1 --output=jsonpretty loadavg 2>/dev/null || echo "cpanel present, loadavg read failed"
  else
    echo "no cpanel installed"
  fi
}

summary() {
  echo "--- disk ---"; disk
  echo "--- mem ---"; mem
  echo "--- cpu ---"; cpu
}

case "$verb" in
  disk) disk ;;
  mem) mem ;;
  cpu) cpu ;;
  cpanel) cpanel ;;
  summary) summary ;;
  *)
    echo "rejected: unknown verb '$verb' (allowed: disk, mem, cpu, cpanel, summary)" >&2
    exit 1
    ;;
esac
