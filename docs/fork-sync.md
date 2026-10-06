# Fork Sync — oh-my-trellis

This fork (`ScoFan-official/trellis`, published as `oh-my-trellis`) tracks
`mindfold-ai/trellis` upstream. All fork-specific customization is concentrated
in `packages/cli` and is committed with the `[oh-my]` prefix so the delta is
greppable: `git log --oneline --grep '^\[oh-my\]'`.

## Baseline

- Base release: upstream `0.6.17`
- Baseline tag: `upstream-0.6.17` → `833a5846d18ad7a5ccd8c41c876d89cc936f5fd9`
- Fork commits live on top of upstream `main` (currently a few commits past the
  tag — that's fine; the tag records the *release* baseline, not the merge
  point).

## The `[oh-my]` surface

Customization lives in these files (all under `packages/cli/` unless noted):

| Area | Files |
|---|---|
| Agent role cards | `src/templates/trellis/agents/{implement,check}.md` |
| Task store | `src/templates/trellis/scripts/common/task_store.py` (`.devin` in `_SUBAGENT_CONFIG_DIRS` + comments) |
| `oh-my` workflow | `src/templates/trellis/workflow-oh-my.md`, `src/utils/workflow-resolver.ts` (`OH_MY_WORKFLOW_ID` / `DEFAULT_WORKFLOW_ID`) |
| Managed workflow id | `src/commands/init.ts`, `src/commands/workflow.ts`, `src/commands/update.ts`, `src/configurators/workflow.ts` (oh-my is hash-managed; `native` is user-managed in this fork) |
| Devin templates | `src/templates/devin/` (start override, oh-my-update workflow, check skill dispatch note in `src/configurators/devin.ts`) |
| CLI identity | `packages/cli/package.json`, `src/commands/upgrade.ts`, `src/commands/update.ts` (GitHub releases lookup), `src/cli/index.ts` (help text) |
| Tests | `test/` — a few upstream tests assert `native`-managed semantics and are patched to the fork's `oh-my` contract |
| Docs | `docs/fork-sync.md` (this file) |

`packages/core` is intentionally untouched — the fork keeps the
`@mindfoldhq/trellis-core` dependency verbatim.

## Sync procedure

1. `git fetch upstream`
2. Review upstream commits since the last sync:
   `git log --oneline HEAD..upstream/main`
3. Merge (preferred — preserves `[oh-my]` commits and is easier to audit):
   `git merge upstream/main` — or rebase if you prefer a linear history:
   `git rebase upstream/main`
4. Resolve conflicts **only inside the `[oh-my]` surface** listed above. If a
   conflict lands outside it, the fork delta leaked — re-scope it back into
   `packages/cli` before continuing.
5. Rerun the template diff checks (the customizations must still be present):
   - `git diff upstream/main -- packages/cli/src/templates/trellis/agents/` shows only the role-card rewrite
   - `git diff upstream/main -- packages/cli/src/templates/trellis/scripts/common/task_store.py` shows only the `.devin` block + comment lines
   - `packages/cli/src/templates/trellis/workflow.md` (native) shows **no** diff — the fork workflow lives in `workflow-oh-my.md`
6. Rebuild and test:
   `pnpm install && pnpm --filter oh-my-trellis build && pnpm --filter oh-my-trellis test`
   Then the e2e: `cd packages/cli && pnpm pack`, `npm i -g ./oh-my-trellis-*.tgz`, and in a scratch dir
   `trellis init --devin -y` — verify `.trellis/workflow.md` contains `[Devin]` blocks and `.devin/workflows/oh-my-update.md` exists.
7. When upstream publishes a new release, re-tag the baseline:
   `git fetch upstream --tags` → locate the release commit →
   `git tag upstream-<version> <sha>` — and bump the fork version's base
   component (`<upstream>-ohmy.N`).

## Versioning

Fork releases are `<upstream-version>-ohmy.<N>` (e.g. `0.6.17-ohmy.1`):
SemVer-prerelease-shaped, monotonic per upstream base, and clearly not an
upstream version. On a new upstream base, reset `N` to 1.

## Release channel

CLI distribution is via GitHub release tarballs on `ScoFan-official/trellis`
(channel A). The CLI's update check and `trellis upgrade` query
`api.github.com/repos/ScoFan-official/trellis/releases` — not npm. The
default registry/marketplace source points at the fork
(`gh:ScoFan-official/oh-my-trellis/marketplace`); custom
`--workflow-source` / `--registry` overrides are unchanged upstream plumbing.

`.github/workflows/publish.yml` is upstream's npm pipeline and is dormant on
the fork: its `on:` block was changed to `workflow_dispatch` only, because
upstream's triggers (`release: published`, `v*` tag push) both fire on a fork
release. `verify-packed-cli` also expects cli version == core version, which
`-ohmy.N` intentionally breaks. Fork releases are manual `.tgz` uploads on
the GitHub release; re-enable the triggers when channel B (npm) ships.
