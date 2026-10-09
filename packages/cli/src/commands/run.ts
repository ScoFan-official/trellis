/**
 * `trellis run` — the unattended loop runner (design D5).
 *
 * Takes the frontier head, gives it an isolated worktree, hands it to one
 * headless worker, runs the ticket's own verification contract, and records
 * every step in a run ledger. Delivery is opt-in: without `--allow-push
 * <ref-glob>` the runner never touches a remote, so the loop is safe on a repo
 * whose delivery tier is still `hands-off` (the `supervised-delivery` tier with
 * CLAI-8 decides this by configuration instead, in the next slice).
 *
 * Why everything happens in the worktree: `.trellis/` is committed content, so
 * a worktree carries its own copy of the task tree. Claim, verify and archive
 * therefore land as commits on the ticket branch, and the orchestrating repo is
 * never mutated — no dirty `task.json`, no half-applied bookkeeping. When the
 * branch is merged by a human, the ticket closes there (PR ≠ 交付). The main
 * repo is read only: for the frontier, and for branch metadata.
 *
 * Stop lines:
 *   - a dependency cycle → stop, grab nothing (frontier exits non-zero)
 *   - N consecutive failures on the same ticket (default 3) → mark it
 *     `triage=ready-for-human` and halt the whole line
 *   - verified work with no push permission → stop at that ticket, leaving it
 *     open on its branch; pushing is someone else's call
 *
 * `runLoop` talks to the world only through `RunnerPorts`, so the policy is
 * testable without a repo, a worker, or a network. The real ports are the thin
 * adapters at the bottom.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { loadTaskRecord } from "@mindfoldhq/trellis-core/task";

import { listProviders, type Provider } from "./channel/adapters/index.js";
import { parseDuration } from "./channel/wait.js";
import { resolveSupportedPython } from "./init.js";
import { openLedger, type LedgerInput } from "./run/ledger.js";
import { oneShotWorker, type WorkerOutcome, type WorkerRequest } from "./run/worker.js";

const DEFAULT_MAX_TICKETS = 5;
const DEFAULT_FAIL_THRESHOLD = 3;
const DEFAULT_WORKER_TIMEOUT_MS = 30 * 60 * 1000;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface FrontierEntry {
  dir: string;
  title?: string;
  priority?: string;
  status?: string;
}

export interface FrontierSnapshot {
  ready: FrontierEntry[];
  blocked?: FrontierEntry[];
  cycles?: string[][];
  warnings?: string[];
}

/** Everything `runLoop` can do to the outside world. */
export interface RunnerPorts {
  task(args: string[], cwd?: string): CommandResult;
  git(args: string[], cwd?: string): CommandResult;
  gh(args: string[]): CommandResult;
  hasRemote(): boolean;
  /** Read one top-level string field of the main repo's copy of a ticket. */
  taskField(dir: string, field: string): string | null;
  /**
   * Whether the ticket's own branch exists but no longer carries the task dir —
   * i.e. a previous run already closed it there. The orchestrating copy lags
   * behind until the branch is merged, so this is the durable "nothing to do"
   * signal for a ticket the frontier still lists.
   */
  ticketClosedOnBranch(branch: string, dir: string): boolean;
  /**
   * Whether the ticket's worktree directory still holds content — a previous
   * attempt that died mid-flight. An empty directory is not a leftover (git
   * happily reuses it); a non-empty one is evidence a human has to judge.
   */
  worktreeOccupied(dir: string): boolean;
  worktreePath(dir: string): string;
  pathExists(target: string): boolean;
  ticketDocs(dir: string): string[];
  worker(req: WorkerRequest): Promise<WorkerOutcome>;
  ledgerAppend(input: LedgerInput): void;
  log(message: string): void;
}

export interface RunOptions {
  root: string;
  board?: string;
  maxTickets: number;
  untilEmpty: boolean;
  dryRun: boolean;
  provider?: Provider;
  agent?: string;
  model?: string;
  workerTimeoutMs: number;
  /** Comma-separated ref globs the runner may push. Absent = no push at all. */
  allowPush?: string;
  failThreshold: number;
}

export type StopReason =
  | "dry_run"
  | "frontier_empty"
  | "no_grabbable_ticket"
  | "single_ticket"
  | "max_tickets"
  | "cycle"
  | "frontier_error"
  | "fail_threshold"
  | "delivery_deferred"
  | "push_refused";

export interface RunResult {
  stopped: StopReason;
  attempted: number;
  archived: number;
  failed: number;
  ledgerFile?: string;
}

type TicketStep =
  | { kind: "archived" }
  | { kind: "failed"; reason: string }
  | { kind: "stop"; reason: StopReason; detail: string };

function firstLine(text: string): string {
  const line = (text ?? "").split("\n").find((l) => l.trim());
  return (line ?? "").trim().slice(0, 200);
}

/** A CLI count flag: absent means the default, present must be ≥ 1. */
function positiveInt(
  flag: string,
  value: unknown,
  fallback: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: true, value: fallback };
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return { ok: false, error: `${flag} must be a positive integer, got "${value}"` };
  }
  return { ok: true, value: parsed };
}

/**
 * Ref whitelist matcher. `*` does NOT cross `/`, so `feature/*` admits
 * `feature/ticket` but not `feature/a/b`. A whitelist that allows less than it
 * appears to allow is the safe direction for a loop nobody is watching.
 */
export function refAllowed(ref: string, globs: string): boolean {
  return globs
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean)
    .some((glob) => {
      const pattern = glob
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
      return new RegExp(`^${pattern}$`).test(ref);
    });
}

function plannedActions(opts: RunOptions): string[] {
  const delivery = opts.allowPush
    ? `delivery:push(${opts.allowPush})+pr`
    : "delivery:deferred(no --allow-push)";
  return [
    "frontier:head",
    "worktree:add",
    `worker:${opts.provider ?? opts.agent}:${opts.model ?? "default"}`,
    "verify:run-verify",
    delivery,
    "task:archive(on the ticket branch)",
  ];
}

/**
 * The brief the worker is handed. Platforms without a prompt-rewriting hook get
 * their context from the entry point, so the ticket's own documents travel with
 * the prompt instead of being assumed.
 */
function buildPrompt(dir: string, docs: string[], worktree: string): string {
  return [
    `You are the unattended implementation worker for Trellis ticket \`${dir}\`.`,
    `Your working directory is that ticket's own worktree: ${worktree}`,
    ``,
    `Read the ticket brief first — it carries the requirement, the acceptance`,
    `items and the test plan:`,
    ...docs.map((p) => `  ${p}`),
    ``,
    `Rules:`,
    `1. Implement the acceptance items. Keep the scope inside this ticket.`,
    `2. Commit your work on this branch with a message naming the ticket.`,
    `   Do NOT push, do NOT open PRs, never touch the default branch or tags.`,
    `3. Do not touch other tickets, \`.trellis/domains/\` boards or worklogs —`,
    `   board bookkeeping belongs to the orchestrating session, not to this`,
    `   worker, and a domain-layer anchor check will reject your commit anyway.`,
    `4. Before finishing, run the ticket's own contract:`,
    `   python ./.trellis/scripts/task.py run-verify ${dir}`,
    `   If it fails, fix it or say so plainly — do not record a passing run you`,
    `   did not observe.`,
  ].join("\n");
}

/** Curate the ticket's context lists so `start`'s empty-seed guard stays meaningful. */
function curateContext(dir: string, worktree: string, ports: RunnerPorts): void {
  for (const doc of ports.ticketDocs(dir)) {
    for (const list of ["implement", "check"]) {
      ports.task(
        ["add-context", dir, list, doc, `run-injected for ${dir}`],
        worktree,
      );
    }
  }
}

/**
 * Paths a fallback commit must never sweep in. The runner stages by explicit
 * pathspec (never `git add -A`), and anything matching these stops the ticket
 * instead — a board file or a secret in the working tree is a human's call, not
 * an unattended commit's.
 */
const PROTECTED_FRAGMENTS = [
  ".trellis/domains/",
  ".env",
  ".pem",
  ".key",
  "id_rsa",
  ".git-credentials",
  "credentials.json",
  ".keystore",
  "secret",
];

export function isProtectedPath(p: string): boolean {
  const lower = p.toLowerCase().replace(/\\/g, "/");
  return PROTECTED_FRAGMENTS.some((frag) => lower.includes(frag));
}

/** `git status --porcelain` → the changed paths, renames resolved to target. */
export function parsePorcelain(out: string): string[] {
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const body = line.slice(3);
    const target = body.includes(" -> ") ? (body.split(" -> ").pop() as string) : body;
    const trimmed = target.trim();
    files.push(
      trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1).replace(/\\"/g, '"')
        : trimmed,
    );
  }
  return files;
}

/**
 * Task-tree paths the runner must not fold into the work commit: claiming a
 * ticket rewrites its own `task.json` / `*.jsonl`, and `task.py archive` moves
 * exactly those files afterwards. Committing both in one commit makes the work
 * commit un-revertable (rename/delete conflict), and 「每票一 commit 可单独
 * revert」 is the whole point of the ledger.
 */
const BOOKKEEPING_PREFIXES = [".trellis/tasks/", ".trellis/.runtime/"];

function isBookkeeping(p: string): boolean {
  const norm = p.toLowerCase().replace(/\\/g, "/");
  return BOOKKEEPING_PREFIXES.some((frag) => norm.startsWith(frag));
}

type FallbackCommit =
  | { ok: true; paths: string[]; bookkeeping: number; oid: string }
  | { ok: false; reason: string };

/**
 * Commit what the worker left uncommitted. A sandboxed worker (codex
 * `workspace-write` keeps `.git` read-only) can write files but not commit
 * them; without this the ticket would fail for a reason that has nothing to do
 * with the work. Staging is by explicit pathspec so a stray protected file
 * stops the ticket rather than riding into the review.
 */
function runnerFallbackCommit(
  dir: string,
  worktree: string,
  ports: RunnerPorts,
): FallbackCommit {
  const status = ports.git(["status", "--porcelain"], worktree);
  if (status.status !== 0) {
    return { ok: false, reason: `status_failed(${firstLine(status.stderr || status.stdout)})` };
  }
  const changed = parsePorcelain(status.stdout);
  const paths = changed.filter((p) => !isBookkeeping(p));
  const bookkeeping = changed.length - paths.length;
  if (paths.length === 0) {
    return {
      ok: false,
      reason: changed.length === 0
        ? "no_work(worker neither committed nor changed the tree)"
        : `no_work(only task bookkeeping changed: ${changed.length} path(s); the worker committed nothing)`,
    };
  }
  const blocked = paths.filter(isProtectedPath);
  if (blocked.length > 0) {
    return {
      ok: false,
      reason: `protected_path_in_tree(${blocked.slice(0, 3).join(", ")}; stage by hand)`,
    };
  }

  const staged = ports.git(["add", "--", ...paths], worktree);
  if (staged.status !== 0) {
    return { ok: false, reason: `stage_failed(${firstLine(staged.stderr || staged.stdout)})` };
  }
  const committed = ports.git(
    ["commit", "-m", `run(${dir}): worker output committed by the runner`],
    worktree,
  );
  if (committed.status !== 0) {
    return { ok: false, reason: `commit_failed(${firstLine(committed.stderr || committed.stdout)})` };
  }

  const head = ports.git(["rev-parse", "HEAD"], worktree);
  return { ok: true, paths, bookkeeping, oid: head.stdout.trim() };
}

async function processOne(
  entry: FrontierEntry,
  opts: RunOptions,
  ports: RunnerPorts,
): Promise<TicketStep> {
  const dir = entry.dir;
  const branch = ports.taskField(dir, "branch");
  const base = ports.taskField(dir, "base_branch");
  if (!branch || !base) {
    return { kind: "failed", reason: "no_branch_metadata(set-branch/set-base-branch first)" };
  }

  const worktree = ports.worktreePath(dir);
  if (ports.worktreeOccupied(dir)) {
    return { kind: "failed", reason: `worktree_occupied(${worktree})` };
  }

  const hasBranch = ports.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const addArgs =
    hasBranch.status === 0
      ? ["worktree", "add", worktree, branch]
      : ["worktree", "add", worktree, "-b", branch, base];
  const added = ports.git(addArgs);
  if (added.status !== 0) {
    return { kind: "failed", reason: `worktree_add_failed(${firstLine(added.stderr || added.stdout)})` };
  }
  ports.ledgerAppend({ ticket: dir, action: "worktree", detail: worktree });
  if (!ports.pathExists(path.join(worktree, ".trellis", "scripts", "task.py"))) {
    // `get_repo_root()` walks up from cwd, so a worktree without its own
    // committed .trellis/ would silently aim at the orchestrating repo instead.
    ports.git(["worktree", "remove", "--force", worktree]);
    return { kind: "failed", reason: `worktree_has_no_trellis(commit .trellis on ${base} first)` };
  }

  try {
    return await runAttempt(dir, entry, branch, base, worktree, opts, ports);
  } finally {
    // The worktree is always transient — it would otherwise make the ticket
    // ungrabbable and the strike counter could never reach the threshold. The
    // evidence lives on the branch (one commit, revertable) and in the ledger;
    // a failed worker additionally keeps its own channel for inspection.
    // `--force` because an aborted worker leaves uncommitted junk, and
    // uncommitted work is not evidence.
    ports.git(["worktree", "remove", "--force", worktree]);
  }
}

async function runAttempt(
  dir: string,
  entry: FrontierEntry,
  branch: string,
  base: string,
  worktree: string,
  opts: RunOptions,
  ports: RunnerPorts,
): Promise<TicketStep> {
  ports.task(["set-worktree", dir, worktree], worktree);

  curateContext(dir, worktree, ports);

  const started = ports.task(["start", dir], worktree);
  if (started.status !== 0) {
    return { kind: "failed", reason: `start_refused(${firstLine(started.stderr || started.stdout)})` };
  }
  ports.ledgerAppend({ ticket: dir, action: "ticket_start", detail: `priority=${entry.priority ?? "-"} branch=${branch}` });

  const docs = ports.ticketDocs(dir).map((doc) => path.join(worktree, ".trellis", "tasks", dir, path.basename(doc)));
  const outcome = await ports.worker({
    ticket: dir,
    cwd: worktree,
    prompt: buildPrompt(dir, docs, worktree),
    provider: opts.provider,
    agent: opts.agent,
    model: opts.model,
    timeoutMs: opts.workerTimeoutMs,
    files: docs,
  });
  if (!outcome.ok) {
    return {
      kind: "failed",
      reason: `worker_failed(${firstLine(outcome.error ?? "no reason")}; channel kept by the worker for inspection)`,
    };
  }

  const report = firstLine(outcome.text);
  let oid = ports.git(["rev-parse", "HEAD"], worktree).stdout.trim();
  let commits = Number.parseInt(
    (ports.git(["rev-list", "--count", `${base}..HEAD`], worktree).stdout || "").trim(),
    10,
  );
  let stagedByRunner = "";

  if (!Number.isFinite(commits) || commits === 0) {
    const fallback = runnerFallbackCommit(dir, worktree, ports);
    if (!fallback.ok) {
      return {
        kind: "failed",
        reason: `${fallback.reason} (worker reported: ${report || "nothing"})`,
      };
    }
    stagedByRunner =
      `runner staged ${fallback.paths.length} path(s)` +
      (fallback.bookkeeping > 0
        ? `, left ${fallback.bookkeeping} task-bookkeeping path(s) for the archive commit`
        : "") +
      "; ";
    oid = fallback.oid;
    commits = Number.parseInt(
      (ports.git(["rev-list", "--count", `${base}..HEAD`], worktree).stdout || "0").trim(),
      10,
    );
  }

  ports.ledgerAppend({
    ticket: dir,
    action: "worker",
    worker: outcome.worker,
    commit: oid,
    detail: `${stagedByRunner}${commits} commit(s) ahead of ${base}; report: ${report || "-"}`,
  });

  const verify = ports.task(["run-verify", dir, "--json"], worktree);
  let verified = false;
  let verifyReason: string | undefined;
  try {
    const parsed = JSON.parse(verify.stdout) as { verified?: boolean; reason?: string };
    verified = parsed.verified === true;
    verifyReason = parsed.reason;
  } catch {
    verifyReason = "unreadable_output";
  }
  ports.ledgerAppend({
    ticket: dir,
    action: "verify",
    commit: oid,
    command: "task.py run-verify --json",
    exit: verify.status,
    reason: verified ? undefined : (verifyReason ?? `exit_${verify.status}`),
  });
  if (!verified) {
    return { kind: "failed", reason: `verify_failed(${verifyReason ?? `exit_${verify.status}`})` };
  }

  if (ports.hasRemote()) {
    if (!opts.allowPush) {
      ports.ledgerAppend({
        ticket: dir,
        action: "delivery",
        commit: oid,
        reason: "deferred: no --allow-push (supervised-delivery/CLAI-8 decides this by config)",
      });
      return {
        kind: "stop",
        reason: "delivery_deferred",
        detail: `${dir} verified at ${oid} but the runner may not push — the work stands on ${branch}, unarchived, waiting for delivery`,
      };
    }
    if (!refAllowed(branch, opts.allowPush)) {
      ports.ledgerAppend({
        ticket: dir,
        action: "delivery",
        commit: oid,
        reason: `rejected: ${branch} outside --allow-push(${opts.allowPush})`,
      });
      return {
        kind: "stop",
        reason: "push_refused",
        detail: `push of ${branch} is outside the whitelist — adjudicate by hand; the line stops here`,
      };
    }
    const pushed = ports.git(["push", "-u", "origin", branch], worktree);
    if (pushed.status !== 0) {
      return { kind: "failed", reason: `push_failed(${firstLine(pushed.stderr || pushed.stdout)})` };
    }
    const pr = ports.gh([
      "pr",
      "create",
      "--head",
      branch,
      "--base",
      base,
      "--title",
      entry.title ?? dir,
      "--body",
      `Unattended run for ticket \`${dir}\`. Verify: \`python ./.trellis/scripts/task.py run-verify ${dir}\`.`,
      "--ready",
    ]);
    if (pr.status !== 0) {
      return { kind: "failed", reason: `pr_open_failed(${firstLine(pr.stderr || pr.stdout)})` };
    }
    const url = firstLine(pr.stdout);
    ports.task(["set-pr", dir, url], worktree);
    ports.ledgerAppend({ ticket: dir, action: "delivery", commit: oid, detail: url });
  } else {
    // WORKLOG-PROTOCOL 第 0 铁律 degradation: with no remote there is nothing to
    // push, so the commit on the ticket branch IS the accounting.
    ports.ledgerAppend({
      ticket: dir,
      action: "delivery",
      commit: oid,
      reason: "degraded_no_remote: commit is the record",
    });
  }

  // Clear the pointer before the archive commit so the merged branch carries no
  // reference to a directory that will not exist.
  ports.task(["set-worktree", dir, "-"], worktree);
  const archived = ports.task(["archive", dir], worktree);
  if (archived.status !== 0) {
    return { kind: "failed", reason: `archive_refused(${firstLine(archived.stderr || archived.stdout)})` };
  }
  ports.ledgerAppend({ ticket: dir, action: "archived", commit: oid });
  return { kind: "archived" };
}

export async function runLoop(opts: RunOptions, ports: RunnerPorts): Promise<RunResult> {
  const strikes = new Map<string, number>();
  const delivered = new Set<string>();
  let attempted = 0;
  let archived = 0;
  let failed = 0;

  ports.ledgerAppend({
    ticket: "-",
    action: "run_start",
    detail: `board=${opts.board ?? "-"} max=${opts.maxTickets} push=${opts.allowPush ?? "off"} dry=${opts.dryRun}`,
  });

  for (;;) {
    const front = ports.task(
      opts.board ? ["frontier", "--json", "--board", opts.board] : ["frontier", "--json"],
    );
    let snapshot: FrontierSnapshot;
    try {
      snapshot = JSON.parse(front.stdout) as FrontierSnapshot;
    } catch {
      const detail = firstLine(front.stderr || front.stdout) || "no output";
      ports.ledgerAppend({ ticket: "-", action: "stop", reason: `frontier_unreadable: ${detail}` });
      ports.log(`Stopped: frontier output unreadable — ${detail}`);
      return { stopped: "frontier_error", attempted, archived, failed };
    }

    const cycles = snapshot.cycles ?? [];
    if (cycles.length > 0) {
      const detail = `dependency cycle: ${cycles.map((c) => c.join(" ↔ ")).join("; ")}`;
      ports.ledgerAppend({ ticket: "-", action: "stop", reason: detail });
      ports.log(`Stopped: ${detail}`);
      return { stopped: "cycle", attempted, archived, failed };
    }

    if (attempted >= opts.maxTickets) {
      ports.ledgerAppend({ ticket: "-", action: "stop", reason: "max_tickets reached" });
      return { stopped: "max_tickets", attempted, archived, failed };
    }

    const ready = snapshot.ready ?? [];
    const candidates: FrontierEntry[] = [];
    const skipped: string[] = [];
    for (const entry of ready) {
      if (opts.dryRun) {
        candidates.push(entry);
        break;
      }
      if (delivered.has(entry.dir)) {
        skipped.push(`${entry.dir}: closed earlier this run`);
        continue;
      }
      // A ticket already carrying a review pointer is pending a human decision;
      // its branch is out of the runner's hands.
      if (ports.taskField(entry.dir, "pr_url")) {
        skipped.push(`${entry.dir}: pr_url set (pending review)`);
        continue;
      }
      const branch = ports.taskField(entry.dir, "branch");
      if (branch && ports.ticketClosedOnBranch(branch, entry.dir)) {
        skipped.push(`${entry.dir}: already archived on ${branch}`);
        continue;
      }
      if (ports.worktreeOccupied(entry.dir)) {
        skipped.push(`${entry.dir}: worktree still holds content`);
        continue;
      }
      candidates.push(entry);
      break;
    }

    if (candidates.length === 0) {
      const reason = skipped.length > 0 ? "no_grabbable_ticket" : "frontier_empty";
      ports.ledgerAppend({
        ticket: "-",
        action: "stop",
        reason: skipped.length > 0 ? `nothing grabbable: ${skipped.join("; ")}` : "frontier empty",
      });
      if (skipped.length > 0) ports.log(`Stopped: ${skipped.join("; ")}`);
      return { stopped: reason, attempted, archived, failed };
    }

    const head = candidates[0] as FrontierEntry;
    if (opts.dryRun) {
      ports.log(JSON.stringify({ ticket: head.dir, actions: plannedActions(opts) }, null, 2));
      return { stopped: "dry_run", attempted, archived, failed };
    }

    attempted += 1;
    ports.log(`→ ${head.dir} (${head.priority ?? "-"})`);
    const step = await processOne(head, opts, ports);

    if (step.kind === "stop") {
      ports.ledgerAppend({ ticket: head.dir, action: "stop", reason: step.detail });
      ports.log(`Stopped (${step.reason}): ${step.detail}`);
      return { stopped: step.reason, attempted, archived, failed };
    }

    if (step.kind === "failed") {
      failed += 1;
      const count = (strikes.get(head.dir) ?? 0) + 1;
      strikes.set(head.dir, count);
      ports.log(`✗ ${head.dir}: ${step.reason} (strike ${count}/${opts.failThreshold})`);
      if (count >= opts.failThreshold) {
        // Marked in the orchestrating repo: that is the copy a human reads when
        // the frontier line is handed back to them.
        ports.task(["set-meta", head.dir, "triage", "ready-for-human"]);
        ports.ledgerAppend({
          ticket: head.dir,
          action: "blocked",
          reason: `${count} consecutive failures: ${step.reason}`,
          detail: "marked triage=ready-for-human; the whole line halts",
        });
        ports.log(`Stopped: ${head.dir} failed ${count} times in a row — handed to a human.`);
        return { stopped: "fail_threshold", attempted, archived, failed };
      }
      continue;
    }

    strikes.delete(head.dir);
    delivered.add(head.dir);
    archived += 1;
    ports.log(`✓ ${head.dir} archived on its branch`);
    if (!opts.untilEmpty) {
      ports.ledgerAppend({ ticket: "-", action: "stop", reason: "one ticket (--until-empty not set)" });
      return { stopped: "single_ticket", attempted, archived, failed };
    }
  }
}

// -----------------------------------------------------------------------------
// Real ports — thin adapters over subprocess and fs. No policy lives here.
// -----------------------------------------------------------------------------

function run(cmd: string, args: string[], cwd: string): CommandResult {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf-8" });
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { status: 127, stdout: "", stderr: `${cmd}: not found on PATH` };
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function realPorts(
  root: string,
  ledgerAppend: (input: LedgerInput) => void,
  log: (message: string) => void = (message): void => {
    console.log(message);
  },
): RunnerPorts {
  const python = resolveSupportedPython().command;
  const taskPy = path.join(root, ".trellis", "scripts", "task.py");

  return {
    task(args, cwd) {
      // task.py is resolved from the main repo so the interpreter and script
      // version stay one thing; `cwd` decides which task tree it operates on.
      const script = cwd ? path.join(cwd, ".trellis", "scripts", "task.py") : taskPy;
      return run(python, [script, ...args], cwd ?? root);
    },
    git(args, cwd) {
      return run("git", args, cwd ?? root);
    },
    gh(args) {
      return run("gh", args, root);
    },
    hasRemote() {
      return run("git", ["remote"], root).stdout.trim().length > 0;
    },
    taskField(dir, field) {
      try {
        const record = loadTaskRecord({
          taskDir: path.join(root, ".trellis", "tasks", dir),
          cwd: root,
        }) as unknown as Record<string, unknown>;
        const value = record[field];
        return typeof value === "string" && value.length > 0 ? value : null;
      } catch {
        return null;
      }
    },
    worktreePath(dir) {
      return path.join(root, ".trellis", ".runtime", "worktrees", dir);
    },
    ticketClosedOnBranch(branch, dir) {
      const ref = run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root);
      if (ref.status !== 0) return false;
      const onBranch = run(
        "git",
        ["cat-file", "-e", `${branch}:.trellis/tasks/${dir}/task.json`],
        root,
      );
      return onBranch.status !== 0;
    },
    worktreeOccupied(dir) {
      const target = path.join(root, ".trellis", ".runtime", "worktrees", dir);
      try {
        return fs.readdirSync(target).length > 0;
      } catch {
        return false;
      }
    },
    pathExists(target) {
      return fs.existsSync(target);
    },
    ticketDocs(dir) {
      const taskDir = path.join(root, ".trellis", "tasks", dir);
      return ["prd.md", "design.md", "implement.md"]
        .map((name) => path.join(taskDir, name))
        .filter((p) => fs.existsSync(p));
    },
    worker: oneShotWorker,
    ledgerAppend,
    log,
  };
}

/** Normalize commander's loose option bag into a validated `RunOptions`. */
export function normalizeOptions(
  raw: Record<string, unknown>,
  root: string,
): { ok: true; options: RunOptions } | { ok: false; error: string } {
  const provider = typeof raw.provider === "string" && raw.provider ? raw.provider : undefined;
  const agent = typeof raw.agent === "string" && raw.agent ? raw.agent : undefined;
  if (provider && !listProviders().includes(provider as Provider)) {
    return {
      ok: false,
      error: `unknown --provider "${provider}" (known: ${listProviders().join(", ")})`,
    };
  }
  if (!provider && !agent) {
    return {
      ok: false,
      error:
        `needs --provider <${listProviders().join("|")}> or --agent <name> — ` +
        "an unattended run must name the worker it is delegating to",
    };
  }

  const maxTickets = positiveInt("--max-tickets", raw.maxTickets, DEFAULT_MAX_TICKETS);
  if (!maxTickets.ok) return maxTickets;
  const failThreshold = positiveInt("--max-failures", raw.maxFailures, DEFAULT_FAIL_THRESHOLD);
  if (!failThreshold.ok) return failThreshold;

  const timeout = parseDuration(typeof raw.timeout === "string" ? raw.timeout : undefined);

  return {
    ok: true,
    options: {
      root,
      board: typeof raw.board === "string" && raw.board ? raw.board : undefined,
      maxTickets: maxTickets.value,
      untilEmpty: raw.untilEmpty === true,
      dryRun: raw.dryRun === true,
      provider: provider as Provider | undefined,
      agent,
      model: typeof raw.model === "string" && raw.model ? raw.model : undefined,
      workerTimeoutMs: timeout ?? DEFAULT_WORKER_TIMEOUT_MS,
      allowPush:
        typeof raw.allowPush === "string" && raw.allowPush.trim() ? raw.allowPush.trim() : undefined,
      failThreshold: failThreshold.value,
    },
  };
}

export async function runCommand(
  raw: Record<string, unknown>,
  root: string = process.cwd(),
): Promise<RunResult> {
  if (!fs.existsSync(path.join(root, ".trellis", "scripts", "task.py"))) {
    throw new Error(
      "no .trellis/scripts/task.py here — `trellis run` drives a Trellis-managed repo",
    );
  }
  const normalized = normalizeOptions(raw, root);
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }
  const opts = normalized.options;

  // A dry run must not create the runs/ directory either, so it gets a sink
  // instead of a ledger.
  const ledger = opts.dryRun ? null : openLedger(opts.root);
  const append: (input: LedgerInput) => void = ledger
    ? (input): void => {
        ledger.append(input);
      }
    : (): void => undefined;
  const ports = realPorts(opts.root, append);
  const result = await runLoop(opts, ports);
  return ledger ? { ...result, ledgerFile: ledger.file } : result;
}
