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
