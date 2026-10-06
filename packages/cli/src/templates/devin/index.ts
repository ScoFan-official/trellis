/**
 * Devin-specific templates (oh-my-trellis fork).
 *
 * Upstream Trellis has no Devin template directory — the Devin file set is
 * rendered entirely from `common/commands` + `common/skills`. This fork adds
 * Devin-only overrides here so the shared common templates stay untouched and
 * upstream merges keep their shape:
 *
 *   workflows/trellis-start.md — overrides the common `start` command with
 *     Laber's dispatch routing (Phase 2 runs via `run_subagent`, not inline).
 *   workflows/oh-my-update.md  — the oh-my-trellis update workflow.
 *
 * Files are read relative to this directory at runtime, so they must be plain
 * assets in `dist/templates/devin/` (copied by scripts/copy-templates.js).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readTemplate(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), "utf-8");
}

/** `.devin/workflows/trellis-start.md` — Devin dispatch routing variant. */
export const trellisStartWorkflowTemplate = readTemplate(
  "workflows/trellis-start.md",
);

/** `.devin/workflows/oh-my-update.md` — oh-my-trellis update workflow. */
export const ohMyUpdateWorkflowTemplate = readTemplate(
  "workflows/oh-my-update.md",
);
