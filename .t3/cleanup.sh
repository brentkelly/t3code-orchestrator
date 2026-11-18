#!/bin/sh
# Removes t3o's own test leftovers from the temp folders. t3o never runs this: install it
# with cron on machines where t3o's tests run, e.g. hourly (crontab -e):
#
#   0 * * * * /path/to/t3o/.t3/cleanup.sh >> "$HOME/.local/state/t3o-cleanup.log" 2>&1
#
# It looks in ${TMPDIR:-/tmp}, /tmp and $HOME/tmp (cron may not set the TMPDIR the tests
# used) and deletes entries there that this user owns, last modified over 24 hours ago,
# and named like a t3o test leftover. A test run's own folder (t3o-tr-<pid>) goes only
# once that pid has exited. Chromium/Playwright profiles are left alone: a live browser
# may still use one. T3O_CLEANUP_DIRS (space-separated) replaces the folder list.
set -u

uid=$(id -u)
dirs=${T3O_CLEANUP_DIRS:-"${TMPDIR:-/tmp} /tmp $HOME/tmp"}
count=0
total_kib=0
seen=" "

# Leftover names from before each test run had its own folder.
is_legacy() {
  case "$1" in
    t3o-retire-test-* | t3o-ci-* | t3o-sweep-* | t3-orchestration-v2-replay-* | \
      t3o-worker-gitdir-* | t3o-setup-* | t3o-gc-* | t3o-project-file-* | t3o-shims-* | \
      t3o-owner-* | t3o-67-* | gitenv-* | *-t3code-git-manager-* | later-release-* | \
      later-feature-*)
      return 0
      ;;
  esac
  return 1
}

is_dead_run() {
  pid=${1#t3o-tr-}
  case "$pid" in
    '' | *[!0-9]*) return 1 ;;
  esac
  ! ps -p "$pid" > /dev/null 2>&1
}

for dir in $dirs; do
  [ -d "$dir" ] || continue
  real=$(cd "$dir" && pwd -P) || continue
  case "$seen" in *" $real "*) continue ;; esac
  seen="$seen$real "

  # A here-doc, not a pipe, so the loop runs in this shell and its counts survive it.
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    name=${path##*/}
    case "$name" in
      t3o-tr-*) is_dead_run "$name" || continue ;;
      *) is_legacy "$name" || continue ;;
    esac
    kib=$(du -sk "$path" 2> /dev/null | cut -f1)
    if rm -rf "$path" 2> /dev/null && [ ! -e "$path" ]; then
      count=$((count + 1))
      total_kib=$((total_kib + ${kib:-0}))
      echo "removed $path (${kib:-0} KiB)"
    else
      echo "could not remove $path" >&2
    fi
  done << LIST
$(find "$real" -mindepth 1 -maxdepth 1 -user "$uid" -mmin +1440 -print)
LIST
done

echo "t3o cleanup: removed $count entries, $((total_kib / 1024)) MiB"
