#!/usr/bin/env bash
# nevoflux-cleanup.sh — Linux post-update cleanup for NevoFlux.
#
# Removes stale add-on caches (and any shadowing agent xpi) from every NevoFlux
# profile so an update never keeps serving the old sidebar bundle, and
# (optionally) refreshes the user skills directory from the skills bundled in
# this install.
#
# Robust by design: a fresh first install has none of these paths — every step
# is best-effort and MUST NOT error when a target is missing.
#
# Usage:
#   ./nevoflux-cleanup.sh [--replace-skills | --keep-skills] [--no-kill]
#   With no skills flag it prompts when run interactively; non-interactively
#   (e.g. from an installer) with no flag it defaults to KEEP (never destructive).

set -u  # deliberately NOT -e: individual steps guard themselves and must not abort.

REPLACE_SKILLS=0
KEEP_SKILLS=0
NO_KILL=0
for arg in "$@"; do
  case "$arg" in
    --replace-skills) REPLACE_SKILLS=1 ;;
    --keep-skills)    KEEP_SKILLS=1 ;;
    --no-kill)        NO_KILL=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[nevoflux-cleanup] unknown option: $arg" >&2 ;;
  esac
done

log() { echo "[nevoflux-cleanup] $*"; }

# --- 1. Make sure the browser is fully closed -------------------------------
if [ "$NO_KILL" -eq 0 ]; then
  if pgrep -x nevoflux >/dev/null 2>&1; then
    log "Closing running NevoFlux..."
    pkill -x nevoflux 2>/dev/null || true
    sleep 2
  fi
fi

# --- 2. Clean stale add-on caches in every profile --------------------------
# Profile root is build/vendor dependent; probe every plausible location.
HOME_DIR="${HOME:-/root}"
PROFILE_ROOTS=(
  "$HOME_DIR/.mozilla/nevoflux"
  "$HOME_DIR/.nevoflux"
)
PROFILE_TARGETS=(
  "extensions/agent@nevoflux.com.xpi"
  "extensions/agent@nevoflux.com"
  "addonStartup.json.lz4"
  "startupCache"
  "extensions.json"
)

cleaned=0
for root in "${PROFILE_ROOTS[@]}"; do
  [ -d "$root" ] || continue
  # Each profile is a sub-directory of the root (dir names contain a '.').
  for p in "$root"/*/; do
    [ -d "$p" ] || continue
    log "Cleaning profile: $p"
    for rel in "${PROFILE_TARGETS[@]}"; do
      rm -rf -- "${p%/}/$rel" 2>/dev/null || true
    done
    cleaned=$((cleaned + 1))
  done
done
if [ "$cleaned" -eq 0 ]; then
  log "No existing NevoFlux profiles found (fresh install) — nothing to clean."
else
  log "Cleaned add-on caches in $cleaned profile(s)."
fi

# --- 3. Optional: refresh user skills from the bundled defaults --------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLED_SKILLS="$(cd "$SCRIPT_DIR/../defaults/skills" 2>/dev/null && pwd || echo "")"
# Linux user skills dir: ~/.config/nevoflux/skills
USER_SKILLS="${XDG_CONFIG_HOME:-$HOME_DIR/.config}/nevoflux/skills"

has_entries() { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; }

copy_bundled() {
  mkdir -p "$USER_SKILLS" 2>/dev/null || true
  # copy contents (not the dir itself); tolerate an empty source
  cp -a "$BUNDLED_SKILLS/." "$USER_SKILLS/" 2>/dev/null || true
}

if [ -z "$BUNDLED_SKILLS" ] || [ ! -d "$BUNDLED_SKILLS" ]; then
  log "No bundled skills found next to this script — skipping skills step."
elif ! has_entries "$USER_SKILLS"; then
  log "Seeding skills into $USER_SKILLS ..."
  copy_bundled
else
  do_replace=0
  if [ "$REPLACE_SKILLS" -eq 1 ]; then
    do_replace=1
  elif [ "$KEEP_SKILLS" -eq 1 ]; then
    do_replace=0
  elif [ -t 0 ]; then
    printf '[nevoflux-cleanup] Existing skills found at %s. Replace them with the bundled ones? (y/N) ' "$USER_SKILLS"
    read -r ans
    case "$ans" in y|Y|yes|YES) do_replace=1 ;; *) do_replace=0 ;; esac
  else
    log "Existing skills kept (non-interactive; pass --replace-skills to overwrite)."
  fi

  if [ "$do_replace" -eq 1 ]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    backup="${USER_SKILLS}.bak-${stamp}"
    if mv -- "$USER_SKILLS" "$backup" 2>/dev/null; then
      log "Backed up existing skills -> $backup"
    else
      log "Backup failed; clearing in place instead."
      rm -rf -- "${USER_SKILLS:?}/"* 2>/dev/null || true
    fi
    copy_bundled
    log "Replaced skills from bundled defaults."
  fi
fi

log "Done."
exit 0
