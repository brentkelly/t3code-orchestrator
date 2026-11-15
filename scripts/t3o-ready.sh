#!/bin/sh
# T3o: board worker readiness for this project, registered in t3o.json as resources.readiness.
# The worker runs a copy of this file from a temp dir with the cwd at its checkout, so the
# checkout comes from T3O_READY_CHECKOUT or the cwd, never from this file's own path.
#   sh scripts/t3o-ready.sh          quick, read-only (what the worker runs)
#   sh scripts/t3o-ready.sh --full   also installs, loads node-pty and launches chromium
set -u

checkout=${T3O_READY_CHECKOUT:-$(pwd)}

not_ready() {
  echo "  fail  $1"
  echo "        fix: $2"
  echo "NOT READY: $3"
  exit 1
}

case "${1:-}" in
  "" | --full) ;;
  *) echo "usage: sh scripts/t3o-ready.sh [--full]" >&2; exit 2 ;;
esac

cd "$checkout" 2>/dev/null || not_ready "checkout $checkout is not a directory" \
  "set T3O_READY_CHECKOUT, or run from the checkout" "no checkout"

pin=$(sed -n 's/.*"node": *"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -n 1)
command -v node >/dev/null 2>&1 || not_ready "node not found on PATH" \
  "install Node ${pin:-from package.json engines.node} and put it on the worker's PATH" "node missing"
node -e 'process.exit(process.features.typescript ? 0 : 1)' 2>/dev/null || not_ready \
  "node $(node --version) cannot run TypeScript" "install Node ${pin:-from package.json engines.node}" \
  "node too old"

if [ ! -f scripts/t3o-ready.ts ]; then
  head=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  not_ready "checkout at $head predates the readiness script (no scripts/t3o-ready.ts)" \
    "git -C $checkout pull --ff-only origin t3o" "checkout predates scripts/t3o-ready.ts"
fi

exec node scripts/t3o-ready.ts "$@"
