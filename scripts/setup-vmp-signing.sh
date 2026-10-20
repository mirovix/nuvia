#!/usr/bin/env bash
# One-time setup of castlabs EVS, which VMP-signs the Windows and macOS builds so
# Widevine plays Spotify in them (issue #1). Run it in a terminal:
#
#   bash scripts/setup-vmp-signing.sh
#
# It creates the free EVS account (castlabs emails you a confirmation code),
# checks the account name and password work, and stores them as the repository
# secrets EVS_ACCOUNT_NAME and EVS_PASSWD that the release workflow signs with.
# Nothing is written to disk by this script; the password is never shown.
set -euo pipefail
REPO="${REPO:-mirovix/nuvia}"

# The GitHub CLI: a `gh` that is not GitHub's (a Python tool of the same name) is skipped.
GH=""
for candidate in "$(command -v gh || true)" "$HOME"/.local/opt/github-cli-*/bin/gh; do
  if [ -x "$candidate" ] && "$candidate" --version 2>/dev/null | grep -q '^gh version'; then GH="$candidate"; break; fi
done
[ -n "$GH" ] || { echo "The GitHub CLI (gh) is needed: https://cli.github.com"; exit 1; }
"$GH" auth status >/dev/null 2>&1 || { echo "Sign in to GitHub first: $GH auth login"; exit 1; }

echo "== Installing the castlabs EVS tools"
python3 -m pip install --user --quiet --upgrade castlabs-evs

echo
echo "== 1/3 Creating your castlabs EVS account (free)"
echo "It asks for an account name, a password, your email, name and organization"
echo "(you can write 'personal'), then for the code castlabs emails you."
echo "Already have an account? Press Ctrl+C here and run again with: SKIP_SIGNUP=1 bash $0"
echo
if [ -z "${SKIP_SIGNUP:-}" ]; then python3 -m castlabs_evs.account signup; fi

echo
echo "== 2/3 Checking the account"
read -r -p "EVS account name: " EVS_ACCOUNT_NAME
read -r -s -p "EVS password (not shown): " EVS_PASSWD; echo
# Through the environment, not the command line, where other programs could read it.
if ! EVS_ACCOUNT_NAME="$EVS_ACCOUNT_NAME" EVS_PASSWD="$EVS_PASSWD" python3 -m castlabs_evs.account -n reauth >/dev/null; then
  echo "castlabs did not accept that account name and password. Nothing was saved; run the script again."
  exit 1
fi
echo "The account works."

echo
echo "== 3/3 Saving it as GitHub secrets of $REPO"
printf '%s' "$EVS_ACCOUNT_NAME" | "$GH" secret set EVS_ACCOUNT_NAME --repo "$REPO"
printf '%s' "$EVS_PASSWD" | "$GH" secret set EVS_PASSWD --repo "$REPO"
unset EVS_PASSWD
echo
echo "Done: the next release is VMP-signed for Windows and macOS."
