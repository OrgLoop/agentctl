# Releasing agentctl

## Quick Release

```bash
bash scripts/release.sh --patch|--minor|--major
```

This script handles the full release flow:

1. Calculates the new version from the current `package.json`
2. Creates a `release/vX.Y.Z` branch from `origin/main`
3. Bumps version via `npm version` (no git tag)
4. Prompts to edit `CHANGELOG.md` (or pass `--changelog "entry"`)
5. Runs `npm run build` and `npm test`
6. Commits and pushes the branch
7. Opens a PR via `gh-me`

## Post-Merge

After the release PR is merged:

```bash
git checkout main && git pull origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

The tag push triggers the npm publish workflow (GitHub Actions).

After publish is confirmed:

```bash
# Rebuild and relink locally
npm run build && npm link --force
agentctl --version  # verify
```

## Version Bump Guide

| Bump    | When                                         |
| ------- | -------------------------------------------- |
| `patch` | Bug fixes, docs improvements                 |
| `minor` | New features, non-breaking changes           |
| `major` | Breaking changes (discuss with Charlie first) |

## Key Notes

- **Never commit directly to main** — all changes go through PRs
- **Never force push** to any branch
- **Use `gh-me`** (not `gh`) for all GitHub operations
- npm provenance requires exact GitHub org casing (`OrgLoop` not `orgloop` in `package.json`)
- CLI version reads from `package.json` at runtime — no manual update needed
- Pre-push hooks run lint/typecheck/build/test — don't skip them
