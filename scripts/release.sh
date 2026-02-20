#!/usr/bin/env bash
set -euo pipefail

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

# Ensure clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Bump version
NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version)
echo "Bumped to $NEW_VERSION"

# Build and test
npm run build
npm test

# Link locally
npm link

# Commit and tag
git add package.json package-lock.json
git commit --author="Doink (OpenClaw) <charlie+doink@kindo.ai>" -m "release: $NEW_VERSION

Co-Authored-By: Charlie Hulcher <charlie@kindo.ai>"
git tag "v$NEW_VERSION"

# Push with tag (triggers publish workflow)
git push origin main --tags

echo ""
echo "✅ Released $NEW_VERSION — publish workflow triggered."
