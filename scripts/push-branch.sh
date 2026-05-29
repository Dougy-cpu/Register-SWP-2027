#!/bin/bash
set -euo pipefail

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN secret is not set."
  exit 1
fi

ALLOW_DIRTY=0
BRANCH_NAME=""

for arg in "$@"; do
  case "$arg" in
    --allow-dirty)
      ALLOW_DIRTY=1
      ;;
    *)
      if [ -z "$BRANCH_NAME" ]; then
        BRANCH_NAME="$arg"
      else
        echo "ERROR: Unexpected argument: $arg"
        echo "Usage: bash scripts/push-branch.sh [--allow-dirty] [branch-name]"
        exit 1
      fi
      ;;
  esac
done

BRANCH_NAME="${BRANCH_NAME:-sync/$(date +%Y-%m-%d-%H%M%S)}"
REMOTE_URL="https://Dougy-cpu:${GITHUB_TOKEN}@github.com/Dougy-cpu/CODEX-Register-HRAS.git"

if ! git diff --quiet || ! git diff --cached --quiet; then
  if [ "$ALLOW_DIRTY" != "1" ]; then
    echo "ERROR: There are uncommitted changes."
    echo "To include the current Replit workspace changes, run:"
    echo "  bash scripts/push-branch.sh --allow-dirty $BRANCH_NAME"
    exit 1
  fi

  COMMIT_MESSAGE="${COMMIT_MESSAGE:-Manual Replit sync: $BRANCH_NAME}"
  echo "Committing current workspace changes before push."
  git add -A
  if git ls-files --error-unmatch .replit >/dev/null 2>&1; then
    git restore --staged .replit || true
    echo "Leaving .replit unstaged because it can contain Replit environment values."
  fi
  if git diff --cached --quiet; then
    echo "No staged changes found after git add."
  else
    git commit -m "$COMMIT_MESSAGE"
  fi
fi

echo "Pushing current committed state to branch: $BRANCH_NAME"
git push "$REMOTE_URL" "HEAD:refs/heads/$BRANCH_NAME"

echo ""
echo "Branch pushed: $BRANCH_NAME"
echo "Open a PR at: https://github.com/Dougy-cpu/CODEX-Register-HRAS/compare/$BRANCH_NAME"
echo ""
echo "To open a PR from this branch, run:"
echo "  BRANCH_NAME=\"$BRANCH_NAME\" bash scripts/create-pr.sh"
