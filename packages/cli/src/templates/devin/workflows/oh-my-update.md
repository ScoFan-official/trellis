---
description: Update oh-my-trellis (CLI, Trellis templates, skills, specs) to the latest fork release.
---

# oh-my-trellis Update

Update this project's oh-my-trellis stack: the global `oh-my-trellis`/`trellis` CLI, `.trellis/` templates, `.devin/` skills and `.trellis/spec/` — in that order, with a confirmation gate before anything changes.

## Step 1: Check versions

```bash
trellis --version
gh api repos/ScoFan-official/trellis/releases/latest
```

Record:

- `current` = the version `trellis --version` prints (e.g. `0.6.17-ohmy.1`)
- `latest` = `tag_name` from the release response, minus a leading `v`
- `tarball` = the `browser_download_url` of the `.tgz` asset in `assets`

If `gh` is unavailable or the API call fails, stop and report — do not guess the latest version.

## Step 2: Summarize the update

Before touching anything, present:

- version delta: `<current> → <latest>` (or "already up to date" — then stop)
- changelog summary: the first section of the release `body`, condensed to a few bullets
- affected layers: Trellis templates (`.trellis/`), skills (`.devin/skills/`), specs (`.trellis/spec/`)

## Step 3: Confirm

Ask the user to confirm the update. Do not proceed on silence; on a "no", stop and report nothing was changed.

## Step 4: Apply, in order

```bash
npm i -g <tarball>   # the release .tgz asset URL from Step 1
trellis update       # refresh .trellis/ + .devin/ managed templates
npx skills add ScoFan-official/oh-my-trellis --agent devin --copy
trellis init -r gh:ScoFan-official/oh-my-trellis/marketplace -t agent-workflow --append
```

Run each step only if the previous succeeded; on failure stop and report which step failed.

## Step 5: Report

- old version → new version (`trellis --version` again to verify)
- per-layer result: CLI / Trellis templates / skills / specs — updated | skipped | failed
- leftover `.new` files: `find . -name '*.new'` — list them and remind the user to diff-and-merge
