#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Fetch the binary assets that lib/speech/ needs but git does not carry.
#
# The JS in lib/speech/ is product code and is versioned. Its three binary
# dependencies are not: the ONNX Runtime wasm alone is 13 MB, and a binary in
# git history is permanent while a .gitignore entry is not. So they get fetched
# instead — and this script is where "fetched from where, exactly" lives.
#
# Written as a script rather than a README on purpose: a README that drifts out
# of date stays silent about it, and the ORT layout below already has one
# non-obvious trap (see ORT_FILES).
#
#   ./scripts/fetch-speech-assets.sh          fetch what is missing
#   ./scripts/fetch-speech-assets.sh --force  re-fetch everything
#   ./scripts/fetch-speech-assets.sh --check  report only, exit 1 if incomplete

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$PROJECT_ROOT/src/nevoflux/extensions/nevoflux-agent"
SPEECH_DIR="$EXT_DIR/lib/speech"

# Pinned deliberately. onnxruntime-web >= 1.19 ships only the shared-memory
# wasm build, which needs SharedArrayBuffer to instantiate; it works today only
# because Firefox grants SAB to moz-extension pages without cross-origin
# isolation. That is platform policy, not a spec guarantee — if it ever
# tightens, the fallback is 1.18.0, the last version to ship a non-shared
# `ort-wasm-simd.wasm`. See docs/design/p0b-results.md §3.2.
ORT_VERSION="${ORT_VERSION:-1.27.0}"

# All three, and the third one is the trap: `ort.wasm.bundle.min.mjs` still
# dynamically imports the Emscripten glue at runtime despite being the
# "bundle" build. Ship two of the three and ORT fails with
# "no available backend found", which reads like a configuration problem.
ORT_FILES=(
  "ort.wasm.bundle.min.mjs"
  "ort-wasm-simd-threaded.mjs"
  "ort-wasm-simd-threaded.wasm"
)

AGENT_REPO="${NEVOFLUX_AGENT_REPO:-$(cd "$PROJECT_ROOT/../nevoflux-agent" 2>/dev/null && pwd || true)}"
MODEL_CACHE="${NEVOFLUX_MODEL_DIR:-$HOME/.cache/nevoflux/models}"

FORCE=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --check) CHECK_ONLY=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

missing=0
have() { [ -s "$1" ] && [ "$FORCE" -eq 0 ]; }
note() { printf '  %-42s %s\n' "$1" "$2"; }

echo "speech assets → $SPEECH_DIR"

# ---------------------------------------------------------------- ORT

ort_needed=0
for f in "${ORT_FILES[@]}"; do
  have "$SPEECH_DIR/ort/$f" || ort_needed=1
done

if [ "$ort_needed" -eq 0 ]; then
  note "onnxruntime-web $ORT_VERSION" "present"
elif [ "$CHECK_ONLY" -eq 1 ]; then
  note "onnxruntime-web $ORT_VERSION" "MISSING"
  missing=1
else
  echo "  fetching onnxruntime-web@$ORT_VERSION …"
  # Into the extension's own node_modules: it already has a package.json, and
  # the devDependency there is what records the version for the next reader.
  (cd "$EXT_DIR" && npm install --no-save --no-audit --no-fund "onnxruntime-web@$ORT_VERSION" >/dev/null)
  mkdir -p "$SPEECH_DIR/ort"
  for f in "${ORT_FILES[@]}"; do
    src="$EXT_DIR/node_modules/onnxruntime-web/dist/$f"
    [ -s "$src" ] || { echo "  !! $f not in the package — did the layout change?" >&2; exit 1; }
    cp "$src" "$SPEECH_DIR/ort/$f"
  done
  note "onnxruntime-web $ORT_VERSION" "fetched"
fi

# ---------------------------------------------------------------- Silero VAD

if have "$SPEECH_DIR/silero-vad.onnx"; then
  note "silero-vad.onnx" "present"
elif [ -s "$MODEL_CACHE/silero-vad.onnx" ] && [ "$CHECK_ONLY" -eq 0 ]; then
  cp "$MODEL_CACHE/silero-vad.onnx" "$SPEECH_DIR/silero-vad.onnx"
  note "silero-vad.onnx" "copied from model cache"
else
  note "silero-vad.onnx" "MISSING — run \`just fetch-asr-models\` in nevoflux-agent"
  missing=1
fi

# ---------------------------------------------------------------- fixtures
#
# Speech for the file-as-microphone mode, so the uplink can be exercised on a
# machine with no microphone at all (a server, CI). Copied rather than
# duplicated into this repo: two copies of a test fixture drift, and then
# nobody knows which one the assertions were written against.

if [ -n "$AGENT_REPO" ] && [ -d "$AGENT_REPO/crates/asr/tests/fixtures" ]; then
  mkdir -p "$SPEECH_DIR/fixtures"
  copied=0
  for w in zh en; do
    src="$AGENT_REPO/crates/asr/tests/fixtures/$w.wav"
    if have "$SPEECH_DIR/fixtures/$w.wav"; then
      copied=$((copied + 1))
    elif [ -s "$src" ] && [ "$CHECK_ONLY" -eq 0 ]; then
      cp "$src" "$SPEECH_DIR/fixtures/$w.wav"
      copied=$((copied + 1))
    fi
  done
  if [ "$copied" -eq 2 ]; then
    note "fixtures/{zh,en}.wav" "present"
  else
    note "fixtures/{zh,en}.wav" "MISSING"
    missing=1
  fi
else
  note "fixtures/{zh,en}.wav" "MISSING — set NEVOFLUX_AGENT_REPO to the agent checkout"
  missing=1
fi

echo
if [ "$missing" -ne 0 ]; then
  echo "incomplete — lib/speech/ will not load until the above are resolved"
  exit 1
fi
echo "complete. Now: npm run import && npm run build:ui"
