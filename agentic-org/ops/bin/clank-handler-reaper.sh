#!/bin/bash
# Kill leaked Daimon engine-broker handlers. A handler is spawned per engine turn
# and should exit with it; a known Daimon bug leaves some spinning a full CPU
# forever. The daily container recreate used to clear them; the org no longer
# restarts daily, so on 2026-10-02 58 of them pushed load to 60 on 2 CPUs and
# every turn and the release build timed out. A turn is capped at 30 minutes
# (turn_limits timeout_ms 1800000), so
# a bare handler older than 45 minutes cannot belong to a live turn. At 1200s
# this killed live 20-30 minute writer turns all through 2026-10-04.
# Only bare `/opt/daimon/bin/daimon-engine-broker` processes whose parent is
# itself a broker are touched; --relay/--client and the root broker never are.
set -u
MAX_AGE=${MAX_AGE:-2700}
n=0
while read -r pid ppid age args; do
  [ "$args" = "/opt/daimon/bin/daimon-engine-broker" ] || continue
  [ "$age" -gt "$MAX_AGE" ] || continue
  pargs=$(ps -o args= -p "$ppid" 2>/dev/null)
  [ "$pargs" = "/opt/daimon/bin/daimon-engine-broker" ] || continue
  kill -KILL "$pid" 2>/dev/null && n=$((n+1))
done < <(ps -eo pid=,ppid=,etimes=,args=)
[ "$n" -gt 0 ] && echo "reaped $n leaked engine handler(s) older than ${MAX_AGE}s"
exit 0
