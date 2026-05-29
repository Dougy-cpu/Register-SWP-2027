#!/bin/bash
set -euo pipefail

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN secret is not set."
  exit 1
fi

BRANCH_NAME="${BRANCH_NAME:-${1:-}}"
if [ -z "$BRANCH_NAME" ]; then
  echo "Usage: BRANCH_NAME=sync/my-branch bash scripts/create-pr.sh"
  echo "  or:  bash scripts/create-pr.sh sync/my-branch"
  exit 1
fi

PR_TITLE="${PR_TITLE:-Sync: $BRANCH_NAME}"
PR_BODY="${PR_BODY:-Manual sync from Replit workspace on $(date '+%Y-%m-%d %H:%M UTC').}"
BASE_BRANCH="${BASE_BRANCH:-main}"
REPO="Dougy-cpu/CODEX-Register-HRAS"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required to create the GitHub API request body."
  exit 1
fi

JSON_PAYLOAD=$(node -e '
const [title, body, head, base] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ title, body, head, base }));
' "$PR_TITLE" "$PR_BODY" "$BRANCH_NAME" "$BASE_BRANCH")

echo "Creating PR: '$PR_TITLE'"
echo "  Branch: $BRANCH_NAME -> $BASE_BRANCH"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/pulls" \
  -d "$JSON_PAYLOAD")

HTTP_STATUS=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_STATUS" = "201" ]; then
  PR_URL=$(echo "$BODY" | grep -o '"html_url":[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
  echo ""
  echo "PR created successfully!"
  echo "  $PR_URL"
else
  echo "Failed to create PR (HTTP $HTTP_STATUS):"
  echo "$BODY" | grep -o '"message":[[:space:]]*"[^"]*"' | head -1 || echo "$BODY"
  exit 1
fi
