#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -x

if ! [ -z "$ZEN_L10N_CURR_DIR" ]; then
  cd $ZEN_L10N_CURR_DIR
fi

# remove "\r" from ./locales/supported-languages
# note: it's fine if it fails
sed -i 's/\r$//' ./locales/supported-languages

CURRENT_DIR=$(pwd)

git config --global init.defaultBranch main
git config --global fetch.prune true

cd $CURRENT_DIR

LAST_FIREFOX_L10N_COMMIT=$(cat ./build/firefox-cache/l10n-last-commit-hash)

# Self-hosted runners on this network see intermittent TLS handshake /
# connection-timeout failures reaching github.com. A single failed `git
# clone`/`git fetch` here used to be fatal (no retry, and `set -e` wasn't
# even active yet), which surfaced later as a confusing rsync "No such
# file or directory" (exit 23) instead of a clear network-retry failure.
# Retry with backoff before giving up.
retry_git() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -lt 5 ]; then
      echo "::warning::git command failed (attempt $attempt/5): $*. Retrying in $((attempt * 15))s..."
      sleep $((attempt * 15))
    fi
  done
  return 1
}

cd ./locales
if [ -d "firefox-l10n/.git" ]; then
  echo "firefox-l10n already cloned, fetching updates..."
  cd firefox-l10n
  retry_git git fetch --depth 1 origin $LAST_FIREFOX_L10N_COMMIT || echo "Warning: git fetch failed after retries, using existing local data"
else
  rm -rf firefox-l10n
  if ! retry_git git clone --depth 1 https://github.com/mozilla-l10n/firefox-l10n; then
    echo "::error::Failed to clone mozilla-l10n/firefox-l10n after 5 attempts"
    exit 1
  fi
  cd firefox-l10n
  # Fetch the specific commit needed (shallow clone only has HEAD)
  if ! retry_git git fetch --depth 1 origin $LAST_FIREFOX_L10N_COMMIT; then
    echo "::error::Failed to fetch commit $LAST_FIREFOX_L10N_COMMIT after 5 attempts"
    exit 1
  fi
fi
git checkout $LAST_FIREFOX_L10N_COMMIT
cd $CURRENT_DIR

rsyncExists=$(command -v rsync)

if [ -z "$rsyncExists" ]; then
  echo "rsync not found, using cp instead"
else
  echo "rsync found!"
fi

set -e

get_code_for_language() {
  # Get the language code from locales/language-maps
  langId=$1
  code=$(grep "^$langId:" ./locales/language-maps | cut -d':' -f2)
  if [ -z "$code" ]; then
    code=$langId
  fi
  echo $code
}

update_language() {
  langId=$(get_code_for_language $1)
  cd ./locales
  cd $1

  echo "Updating $langId"
  # move the contents from ../firefox-l10n/$langId to ./locales/$langId
  # if rsync exists, use it
  # if not, use cp
  if [ -z "$rsyncExists" ]; then
    cp -r $CURRENT_DIR/locales/firefox-l10n/$langId/* .
  else
    rsync -av --progress ../firefox-l10n/$langId/ . --exclude .git
  fi

  cd $CURRENT_DIR
}

export PATH=~/tools/git-cinnabar:$PATH
for lang in $(cat ./locales/supported-languages); do
  update_language $lang
done
cd $CURRENT_DIR

# Move all the files to the correct location

python3 scripts/copy_language_pack.py en-US
for lang in $(cat ./locales/supported-languages); do
  python3 scripts/copy_language_pack.py $lang
done

wait

echo "Cleaning up"
rm -rf ~/tools
rm -rf ~/.git-cinnabar

for lang in $(cat ./locales/supported-languages); do
  # remove every file except if it starts with "zen"
  find ./locales/$lang -type f -not -name "zen*" -delete
done

# Keep firefox-l10n clone for reuse in future builds
# rm -rf ./locales/firefox-l10n
