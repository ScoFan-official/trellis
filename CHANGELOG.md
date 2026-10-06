# Changelog — oh-my-trellis (fork of mindfold-ai/trellis)

Versions are `UPSTREAM_BASE-ohmy.N`: the suffix increments for our changes on a given upstream base; syncing to a new upstream release resets `-ohmy.N` to `-ohmy.1`.

## 0.6.17-ohmy.1

Upstream base: `v0.6.17` (tagged `upstream-0.6.17`, commit `833a5846`).

- Devin Phase 2 (`implement`/`check`) runs as `run_subagent` dispatches, main session orchestrates only — new `oh-my` workflow template (managed default) with `[Devin]` dispatch blocks.
- `.trellis/agents/{implement,check}.md` ship mattpocock-flavored role cards (TDD red-green, Standards+Spec two-axis review).
- `.devin` counts as a sub-agent platform in `task_store.py` (JSONL manifests seeded at create, `start` gate applies).
- Devin templates: updated `trellis-start` routing table, `trellis-check` dispatch note, new `oh-my-update` workflow (release-check → summary → confirm → `npm i -g` → `trellis update` → `npx skills add`).
- CLI identity: package `oh-my-trellis`, bins `trellis` + `oh-my-trellis`, update/upgrade checks `ScoFan-official/trellis` GitHub releases.
- Default spec/workflow source points at `gh:ScoFan-official/oh-my-trellis` (repo root; `--registry` explicit form unchanged).
- `docs/fork-sync.md` upstream-sync runbook; `publish.yml` dormant (workflow_dispatch only).
