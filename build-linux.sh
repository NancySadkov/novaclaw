#!/usr/bin/env bash
#
# build-linux.sh — one-command Linux build for NovaClaw.
#
# Goal: a stranger runs `git clone <repo> && bash build-linux.sh` on a Linux box and gets artifacts,
# or ONE actionable line naming the single thing to install. No AI in the loop, no build archaeology.
#
# This script is the EXECUTABLE COPY of novaclaw/BUILD-linux.md — every command below is measured
# there (Ubuntu 24.04.4, Bun 1.3.14, Node 24.18.0). Keep the two in sync: a change to one without the
# other re-creates the drift this exists to delete.
#
# Exit codes (so a caller — human or agent — can branch without parsing prose):
#   0   success
#   10  preflight failure   (a required tool/version/resource is missing)
#   20  build failure       (bun install / the CLI binary build)
#   30  package failure     (desktop prebuild/build/electron-builder, or an unresolved deb/rpm maintainer)
#   40  smoke failure       (the BUILT ARTIFACT did not serve, or left survivors)
#   64  usage error         (a bad flag)
#
# Contract highlights: `set -euo pipefail`, zero interactive prompts, no `sudo` (it TELLS you the apt
# line, never runs it). Preflight runs in full before any mutating work. One log (build-linux.log),
# a short progress line per phase on stdout, and on failure the phase + code + last ~20 log lines.
# It smokes the ARTIFACT (not the build). Idempotent and safe to re-run after a failure.

set -euo pipefail

# ---------------------------------------------------------------------------------------------------
# Location, log, and globals
# ---------------------------------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || {
  printf 'Could not cd to script directory %s\n' "$SCRIPT_DIR" >&2
  exit 1
}

LOG="$SCRIPT_DIR/build-linux.log"
# NOTE: the log is truncated at the start of preflight, not here — so `--help` and a bad-flag exit
# (which return before any real work) never create a log file.

START_EPOCH="$(date +%s)"

# Selected targets (set by flag parsing).
DO_BINARY=0
DO_SERVER_ONLY=0
DO_APPIMAGE=0
DO_DEB=0
DO_RPM=0
CHANNEL="dev"
BASELINE=0
FORCE=0
MAINTAINER="${NOVACLAW_MAINTAINER:-}"

# Runtime state.
ARCH=""
RPM_SKIP=0
declare -a SKIPPED=()
declare -a ARTIFACTS=()
declare -a PREFLIGHT_ERRORS=()

# Smoke bookkeeping (used by the EXIT trap so nothing is ever left running).
SMOKE_PGID=""
SMOKE_HOME=""

# ---------------------------------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------------------------------

progress() {
  local m="$*"
  printf '==> %s\n' "$m"
  printf '==> %s\n' "$m" >> "$LOG"
}

note() {
  local m="$*"
  printf '    %s\n' "$m"
  printf '    %s\n' "$m" >> "$LOG"
}

# fail <code> <phase> <message...> — print the phase, the exit code, the last ~20 log lines, and exit.
fail() {
  local code="$1" phase="$2"
  shift 2
  local msg="$*"
  printf '\n' >&2
  printf 'FAILED [%s] (exit %s): %s\n' "$phase" "$code" "$msg" >&2
  {
    printf '\n'
    printf 'FAILED [%s] (exit %s): %s\n' "$phase" "$code" "$msg"
  } >> "$LOG"
  printf -- '---- last 20 lines of %s ----\n' "$LOG" >&2
  tail -n 20 "$LOG" >&2 || true
  printf -- '------------------------------\n' >&2
  exit "$code"
}

have() { command -v "$1" > /dev/null 2>&1; }

# ---------------------------------------------------------------------------------------------------
# Cleanup: never leave a process or a temp dir behind (AGENTS.md pitfall #8 — kill by TREE).
# ---------------------------------------------------------------------------------------------------

cleanup() {
  if [ -n "$SMOKE_PGID" ]; then
    # Negative PID = whole process group. The compiled `serve` can spawn MCP children; killing only
    # the root would orphan them, so we started it in its own group and kill the group.
    kill -TERM "-$SMOKE_PGID" 2> /dev/null || true
    sleep 1
    kill -KILL "-$SMOKE_PGID" 2> /dev/null || true
    SMOKE_PGID=""
  fi
  if [ -n "$SMOKE_HOME" ] && [ -d "$SMOKE_HOME" ]; then
    rm -rf "$SMOKE_HOME" 2> /dev/null || true
    SMOKE_HOME=""
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------------------------------

usage() {
  cat << 'EOF'
build-linux.sh — build NovaClaw on Linux.

Usage: bash build-linux.sh [targets] [options]

Targets (default: --binary):
  --binary         Self-contained executable with the web UI embedded (needs Node for the Vite step).
  --server-only    The API binary without the bundled UI. The one build that needs NO Node at all.
  --appimage       Desktop .AppImage (needs Node).
  --deb            Desktop .deb   (needs Node + a maintainer; see --maintainer).
  --rpm            Desktop .rpm   (needs Node + a maintainer + rpmbuild; skipped with a reason if rpmbuild is absent).
  --all            --binary + --appimage + --deb + --rpm.

Options:
  --channel <dev|beta|prod>   Desktop app id / product name / data dir (default: dev).
  --maintainer "<Name <email>>"  Deb/rpm maintainer. Falls back to $NOVACLAW_MAINTAINER, then to the
                                 desktop package.json author. Required for --deb/--rpm; else exit 30.
  --baseline       Build an x86-64 binary WITHOUT AVX2 (older/emulated CPUs).
  --force          Pass through the low-RAM heavy-guard (NOVACLAW_SKIP_HEAVY_GUARD=1).
  -h, --help       This help.

Exit codes: 0 ok · 10 preflight · 20 build · 30 package · 40 smoke · 64 usage.
EOF
}

# ---------------------------------------------------------------------------------------------------
# Flag parsing
# ---------------------------------------------------------------------------------------------------

TARGET_SELECTED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --binary) DO_BINARY=1; TARGET_SELECTED=1 ;;
    --server-only) DO_SERVER_ONLY=1; TARGET_SELECTED=1 ;;
    --appimage) DO_APPIMAGE=1; TARGET_SELECTED=1 ;;
    --deb) DO_DEB=1; TARGET_SELECTED=1 ;;
    --rpm) DO_RPM=1; TARGET_SELECTED=1 ;;
    --all) DO_BINARY=1; DO_APPIMAGE=1; DO_DEB=1; DO_RPM=1; TARGET_SELECTED=1 ;;
    --channel)
      shift || true
      CHANNEL="${1:-}"
      ;;
    --channel=*) CHANNEL="${1#*=}" ;;
    --maintainer)
      shift || true
      MAINTAINER="${1:-}"
      ;;
    --maintainer=*) MAINTAINER="${1#*=}" ;;
    --baseline) BASELINE=1 ;;
    --force) FORCE=1 ;;
    -h | --help) usage; exit 0 ;;
    *)
      printf 'Unknown flag: %s\n\n' "$1" >&2
      usage >&2
      exit 64
      ;;
  esac
  # Guard the loop-bottom shift: a value-consuming flag (--channel/--maintainer) given as the FINAL
  # argument already consumed the last token internally, leaving $#=0. Under `set -e` a bare `shift`
  # with no args returns non-zero and aborts with exit 1 (outside the documented code set); `|| true`
  # lets control fall through to the --channel validation, which emits the proper exit 64.
  shift || true
done

[ "$TARGET_SELECTED" -eq 1 ] || DO_BINARY=1

case "$CHANNEL" in
  dev | beta | prod) ;;
  *)
    printf 'Invalid --channel "%s" (expected dev, beta or prod).\n' "$CHANNEL" >&2
    exit 64
    ;;
esac

# --binary and --server-only both write dist/novaclaw-linux-<arch>/bin/novaclaw; the embedded binary is
# a superset, so if both are asked for, build the embedded one and drop the redundant server-only.
if [ "$DO_BINARY" -eq 1 ] && [ "$DO_SERVER_ONLY" -eq 1 ]; then
  DO_SERVER_ONLY=0
  SKIPPED+=("server-only — subsumed by --binary (same output path; embedded binary is a superset)")
fi

# Node is needed for everything except a pure server-only build.
NEEDS_NODE=0
if [ "$DO_BINARY" -eq 1 ] || [ "$DO_APPIMAGE" -eq 1 ] || [ "$DO_DEB" -eq 1 ] || [ "$DO_RPM" -eq 1 ]; then
  NEEDS_NODE=1
fi
ANY_DESKTOP=0
if [ "$DO_APPIMAGE" -eq 1 ] || [ "$DO_DEB" -eq 1 ] || [ "$DO_RPM" -eq 1 ]; then
  ANY_DESKTOP=1
fi

# ---------------------------------------------------------------------------------------------------
# Preflight — all of it, before any mutating work. Every failure is ONE line: what is missing + the fix.
# ---------------------------------------------------------------------------------------------------

: > "$LOG" # one log per run — truncate here, after the no-op exits (help/usage) can no longer fire.

pf() { PREFLIGHT_ERRORS+=("$*"); }

# OS + architecture.
if [ "$(uname -s)" != "Linux" ]; then
  pf "This script builds NovaClaw on Linux; detected $(uname -s). Run it on a Linux host."
fi
case "$(uname -m)" in
  x86_64 | amd64) ARCH="x64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
  *)
    ARCH="$(uname -m)"
    pf "Unsupported architecture '$ARCH' (expected x86_64 or aarch64)."
    ;;
esac

# bun — EXACT 1.3.14 (the repo's packageManager; runs everything except the Vite steps).
if ! have bun; then
  pf 'bun 1.3.14 is required. Install: curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"'
else
  BUN_VER="$(bun --version 2>/dev/null | tr -d '[:space:]')"
  if [ "$BUN_VER" != "1.3.14" ]; then
    pf "bun 1.3.14 is required (found ${BUN_VER:-none}). Install: curl -fsSL https://bun.sh/install | bash -s \"bun-v1.3.14\""
  fi
fi

# node — >= 20.19 (24 recommended). Skipped for a pure server-only build.
if [ "$NEEDS_NODE" -eq 1 ]; then
  node_fix="Install Node 24: curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-${ARCH}.tar.xz && sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1  (or nvm/NodeSource). Or build with --server-only, which needs no Node."
  if ! have node; then
    pf "Node >= 20.19 is required (not found). $node_fix"
  else
    NODE_VER="$(node --version 2>/dev/null | sed 's/^v//')"
    NODE_MAJOR="${NODE_VER%%.*}"
    NODE_REST="${NODE_VER#*.}"
    NODE_MINOR="${NODE_REST%%.*}"
    if ! { [ "${NODE_MAJOR:-0}" -gt 20 ] 2> /dev/null || { [ "${NODE_MAJOR:-0}" -eq 20 ] 2> /dev/null && [ "${NODE_MINOR:-0}" -ge 19 ] 2> /dev/null; }; }; then
      pf "Node >= 20.19 is required (found ${NODE_VER:-unknown}; Node 18 fails Vite with 'crypto.hash is not a function'). $node_fix"
    fi
  fi
fi

# git, curl, unzip — source, the health probe, and the bun installer.
have git || pf "git is required. Install: sudo apt-get install -y git  (or your distro's package manager)."
have curl || pf "curl is required. Install: sudo apt-get install -y curl  (or your distro's package manager)."
have unzip || pf "unzip is required (the bun installer needs it). Install: sudo apt-get install -y unzip."

# Free disk. bun install is ~800 MB; a desktop package pulls Electron and writes 100-200 MB artifacts.
REQ_GIB=5
[ "$ANY_DESKTOP" -eq 1 ] && REQ_GIB=8
REQ_KB=$((REQ_GIB * 1024 * 1024))
AVAIL_KB="$(df -Pk "$SCRIPT_DIR" 2> /dev/null | awk 'NR==2 {print $4}')"
if [ -n "${AVAIL_KB:-}" ] && [ "$AVAIL_KB" -lt "$REQ_KB" ] 2> /dev/null; then
  AVAIL_GIB=$((AVAIL_KB / 1024 / 1024))
  pf "Need >= ${REQ_GIB} GiB free on the build filesystem; only ${AVAIL_GIB} GiB available. Free up disk or build fewer targets."
fi

# rpmbuild is an OPTIONAL packager: if --rpm was asked for and it is absent, SKIP the target with a
# reason rather than failing the whole run (blocker #5).
if [ "$DO_RPM" -eq 1 ] && ! have rpmbuild; then
  RPM_SKIP=1
  SKIPPED+=("rpm — 'rpmbuild' not found. Install: sudo apt-get install -y rpm  (then re-run to build it).")
fi

# Which desktop targets will ACTUALLY be produced, now that RPM_SKIP is known — distinct from
# ANY_DESKTOP (computed from flags alone above). A --rpm skipped for a missing rpmbuild must NOT
# trigger the long electron-vite desktop build, and if it was the ONLY target we must fail preflight
# rather than "succeed" with zero artifacts.
ANY_DESKTOP_EFFECTIVE=0
if [ "$DO_APPIMAGE" -eq 1 ] || [ "$DO_DEB" -eq 1 ] || { [ "$DO_RPM" -eq 1 ] && [ "$RPM_SKIP" -eq 0 ]; }; then
  ANY_DESKTOP_EFFECTIVE=1
fi
CLI_SELECTED=0
if [ "$DO_BINARY" -eq 1 ] || [ "$DO_SERVER_ONLY" -eq 1 ]; then
  CLI_SELECTED=1
fi
# Nothing producible (every selected target was skipped, e.g. `--rpm` alone with no rpmbuild): fail
# preflight with one actionable line rather than running a full build for zero artifacts and exit 0.
if [ "$CLI_SELECTED" -eq 0 ] && [ "$ANY_DESKTOP_EFFECTIVE" -eq 0 ]; then
  pf "No target can be produced: every selected target was skipped (e.g. --rpm with no rpmbuild). Install the missing packager (sudo apt-get install -y rpm) or choose another target."
fi

if [ "${#PREFLIGHT_ERRORS[@]}" -gt 0 ]; then
  printf '\nPreflight failed — fix these, then re-run:\n' >&2
  for e in "${PREFLIGHT_ERRORS[@]}"; do
    printf '  - %s\n' "$e" >&2
    printf '  - %s\n' "$e" >> "$LOG"
  done
  fail 10 "preflight" "${#PREFLIGHT_ERRORS[@]} requirement(s) not met (listed above)."
fi
progress "Preflight OK (arch ${ARCH}, channel ${CHANNEL}$([ "$NEEDS_NODE" -eq 1 ] && echo ", node $(node --version 2>/dev/null)" || echo ", node not required"))"

# ---------------------------------------------------------------------------------------------------
# Maintainer resolution (deb/rpm). Fail fast (exit 30) BEFORE the long build if it cannot be resolved.
# ---------------------------------------------------------------------------------------------------

# Whether a maintainer is actually needed (rpm may have been skipped above).
NEED_MAINTAINER=0
[ "$DO_DEB" -eq 1 ] && NEED_MAINTAINER=1
[ "$DO_RPM" -eq 1 ] && [ "$RPM_SKIP" -eq 0 ] && NEED_MAINTAINER=1

if [ "$NEED_MAINTAINER" -eq 1 ] && [ -z "$MAINTAINER" ]; then
  # Derive from the desktop package.json author (bun is guaranteed present by preflight). electron-builder
  # itself derives the same value, but passing it explicitly makes the build deterministic.
  MAINTAINER="$(bun -e 'try{const p=require("./packages/desktop/package.json");const a=p&&p.author;let o="";if(a&&typeof a==="object"){if(a.name&&a.email)o=a.name+" <"+a.email+">";}else if(typeof a==="string"){o=a;}process.stdout.write(o);}catch(e){}' 2> /dev/null || true)"
fi
if [ "$NEED_MAINTAINER" -eq 1 ] && [ -z "$MAINTAINER" ]; then
  fail 30 "package" 'A .deb/.rpm needs a maintainer. Pass --maintainer "Your Name <you@example.com>" or set NOVACLAW_MAINTAINER, or add an author email to packages/desktop/package.json.'
fi

# ---------------------------------------------------------------------------------------------------
# Heavy-guard passthrough (#7). The desktop prebuild refuses under low RAM on non-Windows; --force
# lets the caller override it. The guard prints its own text, which the log tail surfaces on failure.
# ---------------------------------------------------------------------------------------------------

if [ "$FORCE" -eq 1 ]; then
  export NOVACLAW_SKIP_HEAVY_GUARD=1
  note "--force: heavy-guard bypass enabled (NOVACLAW_SKIP_HEAVY_GUARD=1)."
fi

# ---------------------------------------------------------------------------------------------------
# Build phase (exit 20 on failure)
# ---------------------------------------------------------------------------------------------------

progress "Installing dependencies (bun install)"
if ! bun install >> "$LOG" 2>&1; then
  fail 20 "build" "bun install failed."
fi

BINARY_PATH=""

# The CLI binary (embedded UI, or server-only). --skip-install avoids the two tree-mutating `bun add`s
# in build.ts (blocker #6). --single = host platform only.
build_cli() {
  local kind="$1" # "binary" or "server-only"
  local -a args=(build --single --skip-install)
  [ "$BASELINE" -eq 1 ] && args+=(--baseline)
  if [ "$kind" = "server-only" ]; then
    args+=(--skip-embed-web-ui)
    progress "Building server-only binary (no embedded UI, no Node needed)"
  else
    progress "Building self-contained binary with embedded UI"
  fi
  if ! NOVACLAW_CHANNEL="$CHANNEL" bun run --cwd packages/novaclaw "${args[@]}" >> "$LOG" 2>&1; then
    fail 20 "build" "CLI ${kind} build failed (bun run --cwd packages/novaclaw ${args[*]})."
  fi
  BINARY_PATH="packages/novaclaw/dist/novaclaw-linux-${ARCH}/bin/novaclaw"
  if [ ! -x "$BINARY_PATH" ]; then
    fail 20 "build" "expected binary not found at ${BINARY_PATH} after a successful build."
  fi
  ARTIFACTS+=("$BINARY_PATH")
}

if [ "$DO_BINARY" -eq 1 ]; then
  build_cli "binary"
elif [ "$DO_SERVER_ONLY" -eq 1 ]; then
  build_cli "server-only"
fi

# ---------------------------------------------------------------------------------------------------
# Desktop packaging phase (exit 30 on failure)
# ---------------------------------------------------------------------------------------------------

if [ "$ANY_DESKTOP_EFFECTIVE" -eq 1 ]; then
  progress "Desktop prebuild (icons, metainfo, Node server sidecar) — channel ${CHANNEL}"
  if ! ( cd packages/desktop && NOVACLAW_CHANNEL="$CHANNEL" bun run prebuild ) >> "$LOG" 2>&1; then
    fail 30 "package" "desktop prebuild failed (a low-RAM heavy-guard refusal is the usual non-error cause — re-run with --force; see the log tail)."
  fi
  progress "Desktop build (electron-vite build) — channel ${CHANNEL}"
  if ! ( cd packages/desktop && NOVACLAW_CHANNEL="$CHANNEL" bun run build ) >> "$LOG" 2>&1; then
    fail 30 "package" "desktop build (electron-vite build) failed."
  fi

  # One electron-builder call per target, matching BUILD-linux.md, so a per-target reason is clear and
  # one failure does not obscure the others' status.
  eb_run() {
    local eb_target="$1" # AppImage | deb | rpm
    local -a mflag=()
    if [ "$eb_target" = "deb" ] || [ "$eb_target" = "rpm" ]; then
      mflag=(-c.linux.maintainer="$MAINTAINER")
    fi
    progress "Packaging ${eb_target}"
    if ! ( cd packages/desktop && NOVACLAW_CHANNEL="$CHANNEL" bunx electron-builder --linux "$eb_target" \
      --config electron-builder.config.ts --publish never "${mflag[@]}" ) >> "$LOG" 2>&1; then
      fail 30 "package" "electron-builder --linux ${eb_target} failed."
    fi
  }

  [ "$DO_APPIMAGE" -eq 1 ] && eb_run "AppImage"
  [ "$DO_DEB" -eq 1 ] && eb_run "deb"
  if [ "$DO_RPM" -eq 1 ]; then
    if [ "$RPM_SKIP" -eq 1 ]; then
      note "Skipping rpm (rpmbuild absent) — see the summary."
    else
      eb_run "rpm"
    fi
  fi

  # Discover the artifacts electron-builder actually wrote (its names encode arch/version).
  shopt -s nullglob
  if [ "$DO_APPIMAGE" -eq 1 ]; then for f in packages/desktop/dist/*.AppImage; do ARTIFACTS+=("$f"); done; fi
  if [ "$DO_DEB" -eq 1 ]; then for f in packages/desktop/dist/*.deb; do ARTIFACTS+=("$f"); done; fi
  if [ "$DO_RPM" -eq 1 ] && [ "$RPM_SKIP" -eq 0 ]; then for f in packages/desktop/dist/*.rpm; do ARTIFACTS+=("$f"); done; fi
  shopt -u nullglob
fi

# ---------------------------------------------------------------------------------------------------
# Smoke phase — smoke the ARTIFACT, not the build (exit 40 on failure).
#
# Mirrors packages/novaclaw/script/build.ts:159-182 (smokeServer): boot the JUST-BUILT binary on an
# ephemeral port with a throwaway home and NOVACLAW_OFFLINE=1, poll /api/health for {"healthy":true},
# then kill the process TREE and assert no survivors. Loopback + NO password: /api/health sits BEHIND
# auth (packages/server/src/middleware/authorization.ts — only PTY tickets and 3 manifest assets are
# exempt), so setting a password without sending a credential would 401. build.ts's proven smoke binds
# loopback with no password for exactly this reason; we do the same.
#
# The desktop artifacts (.AppImage/.deb/.rpm) are Electron GUI apps and cannot be booted on a headless
# build box (BUILD-linux.md leaves the GUI unverified), so only the CLI binary is smoked.
# ---------------------------------------------------------------------------------------------------

smoke_binary() {
  local bin="$1"

  progress "Smoke: ${bin} --version"
  local ver
  if ! ver="$("$bin" --version 2>> "$LOG")"; then
    fail 40 "smoke" "the built binary failed to run '--version'."
  fi
  note "reported version: $(printf '%s' "$ver" | tr -d '\r\n')"

  # An ephemeral free port, the same way build.ts does (Bun.serve({port:0})).
  local port
  port="$(bun -e 'const s=Bun.serve({port:0,fetch:()=>new Response()});const p=s.port;s.stop(true);console.log(p)' 2>> "$LOG" || true)"
  if [ -z "$port" ]; then
    fail 40 "smoke" "could not allocate an ephemeral port."
  fi

  SMOKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/novaclaw-smoke-XXXXXX")"

  progress "Smoke: booting supervised '${bin} serve' on 127.0.0.1:${port} (home ${SMOKE_HOME})"
  # Own process group so the supervisor and its server/MCP descendants die together. This deliberately
  # exercises the managed-by-default path; a bare-child smoke would miss a broken restart command.
  set -m
  # Clear inherited server auth for the child only (env -u), so the temp-home smoke is fully hermetic.
  # A fresh --home neutralizes the STORED password, but @novaclaw/server reads NOVACLAW_SERVER_PASSWORD
  # straight from the ambient env (auth.ts) and it WINS over the store — so an operator building in a
  # shell that exports it would make /api/health require a credential we never send → 401 → a false
  # smoke failure (exit 40) on a perfectly good binary.
  env -u NOVACLAW_SERVER_PASSWORD -u NOVACLAW_SERVER_USERNAME \
    NOVACLAW_OFFLINE=1 NOVACLAW_HOME="$SMOKE_HOME" \
    "$bin" serve --port "$port" --home "$SMOKE_HOME" >> "$LOG" 2>&1 &
  local spid=$!
  set +m
  SMOKE_PGID="$spid"

  # Poll for health (cold start measured ~6.7s; budget 60s). Stop early if the server dies.
  local ok=0 i body
  for ((i = 0; i < 120; i++)); do
    if ! kill -0 "$spid" 2> /dev/null; then
      break # server process exited before becoming healthy
    fi
    # Bound every probe (like build.ts's AbortSignal.timeout(10_000)) so a booted-but-stalled server
    # — port bound, handler hung — fails the probe and lets the loop's liveness check run again,
    # instead of curl blocking forever on an accepted-but-unanswered connection (the 60s budget is
    # only real if each probe returns).
    body="$(curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${port}/api/health" 2> /dev/null || true)"
    case "$body" in
      *'"healthy":true'*) ok=1; break ;;
    esac
    sleep 0.5
  done

  if [ "$ok" -ne 1 ]; then
    cleanup
    fail 40 "smoke" "the built server did not report {\"healthy\":true} at /api/health within 60s."
  fi
  note "health: /api/health returned $body"

  # Blocker #8: graph memory (@ladybugdb/wasm-core) is a DESKTOP dependency, so the standalone server
  # cannot resolve it. Surface it honestly — a note, NOT a failure.
  if grep -qi "kb-memory failed to open" "$LOG" 2> /dev/null; then
    note "note: 'kb-memory failed to open' in the log — graph memory is disabled in the standalone server (a desktop-only dependency). Everything else works. (blocker #8)"
  fi

  # Kill the TREE and assert no survivors.
  progress "Smoke: killing the server process tree and asserting no survivors"
  kill -TERM "-$spid" 2> /dev/null || true
  sleep 1
  kill -KILL "-$spid" 2> /dev/null || true
  sleep 1
  if kill -0 "-$spid" 2> /dev/null; then
    fail 40 "smoke" "server survivors remain after SIGKILL of the process group (a process leak)."
  fi
  SMOKE_PGID=""
  note "no survivors."

  rm -rf "$SMOKE_HOME" 2> /dev/null || true
  SMOKE_HOME=""
  progress "Smoke passed."
}

if [ -n "$BINARY_PATH" ]; then
  smoke_binary "$BINARY_PATH"
else
  SKIPPED+=("smoke — no CLI binary was built (desktop-only invocation); the GUI artifact cannot be booted headless.")
fi

# ---------------------------------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------------------------------

END_EPOCH="$(date +%s)"
ELAPSED=$((END_EPOCH - START_EPOCH))
MINS=$((ELAPSED / 60))
SECS=$((ELAPSED % 60))

sha_of() {
  if have sha256sum; then sha256sum "$1" 2> /dev/null | awk '{print $1}'; else echo "n/a (sha256sum absent)"; fi
}
size_of() { du -h "$1" 2> /dev/null | awk '{print $1}'; }

printf '\n'
printf '===================== NovaClaw Linux build summary =====================\n'
printf 'channel: %s    arch: %s    wall time: %dm%02ds\n' "$CHANNEL" "$ARCH" "$MINS" "$SECS"
printf '\n'
if [ "${#ARTIFACTS[@]}" -gt 0 ]; then
  printf 'Artifacts:\n'
  for a in "${ARTIFACTS[@]}"; do
    [ -e "$a" ] || continue
    printf '  %s\n' "$a"
    printf '    size:   %s\n' "$(size_of "$a")"
    printf '    sha256: %s\n' "$(sha_of "$a")"
  done
else
  printf 'Artifacts: (none)\n'
fi
printf '\n'
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  printf 'Skipped:\n'
  for s in "${SKIPPED[@]}"; do printf '  - %s\n' "$s"; done
else
  printf 'Skipped: (nothing)\n'
fi
printf '\n'
printf 'Full log: %s\n' "$LOG"

# ---------------------------------------------------------------------------------------------------
# Tree-clean assertion — the build must not have mutated tracked files.
# ---------------------------------------------------------------------------------------------------

if have git && git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  # This script's own log lives at the repo root and is a runtime artifact, not build churn — exclude it
  # so the assertion reports on what the BUILD touched (e.g. an unexpected bun.lock rewrite).
  DIRTY="$(git status --porcelain 2> /dev/null | grep -v 'build-linux\.log$' || true)"
  if [ -n "$DIRTY" ]; then
    printf '\nWARNING: the working tree changed during the build:\n'
    printf '%s\n' "$DIRTY"
    printf '(Build outputs under dist/ and out/ are gitignored; anything above is unexpected churn.)\n'
  else
    printf '\nWorking tree clean (git status --porcelain empty).\n'
  fi
fi

printf '=======================================================================\n'
exit 0
