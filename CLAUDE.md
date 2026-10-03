# Agent Track

A Claude Code mod (plugin of function hooks): a live progress board for sessions, subagents, todo lists and project checklists.

## Every change bumps the version

The desktop app offers **Update** only when the version goes up, so every pushed change that touches what the plugin ships (`hooks/`, `types/`, `.claude-plugin/`) raises the semver version, in the same commit:

- **patch** (1.1.0 → 1.1.1) for fixes and small tweaks
- **minor** (1.1.0 → 1.2.0) for new features
- **major** (1.x → 2.0.0) for breaking changes, such as a renamed config file or option

Change it in **both** `.claude-plugin/plugin.json` (`version`) and `.claude-plugin/marketplace.json` (`plugins[0].version`). `node scripts/check-version.mjs HEAD~1` checks both, and the Check workflow runs it on every push and pull request.

## Checks before pushing

```
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
tsc -p .
claude plugin test .
node scripts/check-version.mjs origin/main
```

`tsc` needs `.claude/types/claude-code.d.ts` (git-ignored): Claude Code writes it, or copy it from the plugin-authoring skill's `types/claude-code.d.ts`.

## Finishing a change: PR and auto-merge

The marketplace serves `main`, so a change is finished only when it is on `main`. When a change is done and the checks above pass, without asking first:

1. push the branch and open a pull request into `main`;
2. wait for the Check workflow on it to pass (fix and push again if it fails);
3. merge the pull request yourself (merge commit), then tell the user it is live.

A merge that raises the version publishes the GitHub release by itself (`.github/workflows/release.yml`: tag `v<version>`, the zip from `scripts/pack.mjs`, generated notes), so pull request titles should read well as release notes.

Ask before merging only when the change is risky or the user said not to merge.
