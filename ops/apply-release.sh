#!/bin/sh
# Server-side cutover. Invoked only after staging/install/preflight succeeds.
set -eu
app=$1
release=$2
case "$app" in /*) ;; *) echo 'app path must be absolute' >&2; exit 1;; esac
case "$release" in "$app"/backups/releases/*) ;; *) echo 'invalid release path' >&2; exit 1;; esac
release_id=${release#"$app"/backups/releases/}
case "$release_id" in ''|*[!A-Za-z0-9_-]*) echo 'invalid release identifier' >&2; exit 1;; esac
candidate=$release/candidate
previous=$release/previous
journal=$release/journal
paths='apps packages scripts ops assets node_modules package.json bun.lock ecosystem.config.json tsconfig.json README.md docs'
for path in $paths; do test -e "$candidate/$path"; done
test -f "$app/.env"
mkdir "$previous" "$journal"
lock=$app/backups/.deploy-lock
mkdir "$lock" || { echo 'Another deployment is active (or its lock needs inspection).' >&2; exit 1; }

pm2() { sudo -u appsvc env PM2_HOME=/var/lib/appsvc/.pm2 HOME=/var/lib/appsvc /usr/local/bin/pm2 "$@"; }
run_bun() { sudo -u appsvc env HOME=/var/lib/appsvc /opt/bun/bin/bun "$@"; }
stopped=0
committed=0
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$stopped" = 1 ] && [ "$committed" = 0 ]; then
    echo 'Release failed; restoring previous code. Database and session files are preserved.' >&2
    # Never change code underneath a process we cannot stop.
    if ! pm2 stop ingress-guard >/dev/null; then
      echo 'Rollback blocked: could not stop the process. Previous files remain in the release directory.' >&2
      exit 1
    fi
    for path in $paths; do
      [ -f "$journal/$path" ] || continue
      if [ -e "$previous/$path" ]; then
        rm -rf -- "$app/$path"
        mv "$previous/$path" "$app/$path"
      elif [ "$(cat "$journal/$path")" = new ]; then
        rm -rf -- "$app/$path"
      fi
    done
    pm2 start "$app/ecosystem.config.json" --only ingress-guard >/dev/null || {
      echo 'Previous code restored, but restart failed; inspect PM2 before retrying.' >&2; exit 1;
    }
  fi
  rmdir "$lock"
  [ "$status" -ne 0 ] || status=1
  exit "$status"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM
# Validate under the deployment lock, before any interruption of the running version.
run_bun --env-file="$app/.env" "$candidate/ops/preflight.ts" "$app"
pm2 stop ingress-guard >/dev/null
stopped=1
# A failed or missing database backup must stop the release before any code moves.
run_bun --env-file="$app/.env" "$app/scripts/backup.ts" "$app/backups"
for path in $paths; do
  if [ -e "$app/$path" ]; then
    echo old > "$journal/$path"
    mv "$app/$path" "$previous/$path"
  else
    echo new > "$journal/$path"
  fi
  mv "$candidate/$path" "$app/$path"
done
pm2 start "$app/ecosystem.config.json" --only ingress-guard >/dev/null
healthy=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  if pm2 jlist | run_bun --env-file="$app/.env" "$app/ops/check-runtime.ts"; then healthy=1; break; fi
done
[ "$healthy" = 1 ] || { echo 'Candidate failed startup checks' >&2; exit 1; }
pm2 save >/dev/null
committed=1
rmdir "$lock"
trap - EXIT HUP INT TERM
echo "Release verified. Previous code retained at $previous"
