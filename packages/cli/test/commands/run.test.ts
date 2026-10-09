/**
 * Policy tests for the D5 loop runner (`src/commands/run.ts`).
 *
 * The runner is a state machine around three external actors — the frontier,
 * one headless worker per ticket, and git/remote delivery — so these tests
 * drive `runLoop` through fake ports and assert what it actually DID: which
 * task.py verbs it ran and against which repo, what it pushed, what the ledger
 * recorded, and when it stopped the line instead of pushing on.
 *
 * No repo, no worker, no network. `run.dry-run.integration.test.ts` covers the
 * real frontier output shape.
 */

import { describe, expect, it } from "vitest";

import {
  normalizeOptions,
  refAllowed,
  runLoop,
  type FrontierEntry,
  type RunOptions,
  type RunnerPorts,
} from "../../src/commands/run.js";
import type { LedgerInput } from "../../src/commands/run/ledger.js";
import type { WorkerOutcome, WorkerRequest } from "../../src/commands/run/worker.js";

const ROOT = "/repo";
const wtOf = (dir: string): string => `${ROOT}/.trellis/.runtime/worktrees/${dir}`;
const OID = "abc1234def5678";

interface Script {
  ready?: FrontierEntry[];
  cycles?: string[][];
  /** dir → task.json field → value; overrides the branch/base defaults. */
  fields?: Record<string, Record<string, string | null>>;
  remote?: boolean;
  /** `false` always fails; an array is consumed one worker call at a time. */
  workerOk?: boolean | boolean[];
  verifyVerified?: boolean;
  /** Directories whose worktree already exists before the run starts. */
  existingWorktrees?: string[];
  /** Directories whose branch already archived them (a previous run). */
  closedOnBranch?: string[];
}

interface Harness {
  ports: RunnerPorts;
  taskCalls: { args: string[]; cwd?: string }[];
  gitCalls: { args: string[]; cwd?: string }[];
  ghCalls: string[][];
  workerRequests: WorkerRequest[];
  pushed: string[][];
  ledger: LedgerInput[];
  logs: string[];
  worktreeAdds: number;
}

function baseOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    root: ROOT,
    maxTickets: 5,
    untilEmpty: true,
    dryRun: false,
    provider: "claude",
    workerTimeoutMs: 60000,
    failThreshold: 3,
    ...overrides,
  };
}

function harness(script: Script = {}): Harness {
  const h: Harness = {
    taskCalls: [],
    gitCalls: [],
    ghCalls: [],
    workerRequests: [],
    pushed: [],
    ledger: [],
    logs: [],
    worktreeAdds: 0,
    ports: undefined as unknown as RunnerPorts,
  };

  const created = new Set<string>();
  const existing = new Set<string>(script.existingWorktrees ?? []);
  // A ticket archived by this run is closed on its branch; `closedOnBranch`
  // seeds the same fact from an earlier run.
  const archivedDirs = new Set<string>(script.closedOnBranch ?? []);
  const workerResults: boolean[] =
    typeof script.workerOk === "boolean" || script.workerOk === undefined
      ? []
      : [...script.workerOk];
  let workerCalls = 0;

  const ok = (stdout = ""): { status: number; stdout: string; stderr: string } => ({
    status: 0,
    stdout,
    stderr: "",
  });

  const ports: RunnerPorts = {
    task(args, cwd) {
      h.taskCalls.push({ args, cwd });
      if (args[0] === "frontier") {
        return ok(
          JSON.stringify({
            ready: script.ready ?? [],
            blocked: [],
            cycles: script.cycles ?? [],
          }),
        );
      }
      if (args[0] === "run-verify") {
        const verified = script.verifyVerified ?? true;
        return {
          status: verified ? 0 : 1,
          stdout: JSON.stringify({ verified, results: [] }),
          stderr: "",
        };
      }
      if (args[0] === "archive") {
        archivedDirs.add(args[1] as string);
      }
      return ok();
    },
    git(args, cwd) {
      h.gitCalls.push({ args, cwd });
      const verb = args[0];
      if (verb === "rev-parse" && args[1] === "--verify") return { status: 1, stdout: "", stderr: "" };
      if (verb === "worktree" && args[1] === "add") {
        h.worktreeAdds += 1;
        created.add(args[2] as string);
        return ok();
      }
      if (verb === "worktree" && args[1] === "remove") {
        created.delete(args[args.length - 1] as string);
        return ok();
      }
      if (verb === "rev-parse") return ok(`${OID}\n`);
      if (verb === "rev-list") return ok("1\n");
      if (verb === "push") {
        h.pushed.push(args);
        return ok();
      }
      if (verb === "remote") return ok(script.remote ? "origin\thttps://example.invalid/o/r.git (fetch)\n" : "");
      return ok();
    },
    gh(args) {
      h.ghCalls.push(args);
      return { status: 0, stdout: "https://github.com/o/r/pull/9\n", stderr: "" };
    },
    hasRemote() {
      return script.remote === true;
    },
    taskField(dir, field) {
      const table = script.fields?.[dir];
      if (table) return table[field] ?? null;
      if (field === "branch") return `feature/${dir}`;
      if (field === "base_branch") return "main";
      return null;
    },
    worktreePath: wtOf,
    ticketClosedOnBranch: (_branch, dir) => archivedDirs.has(dir),
    pathExists(target) {
      // Separator-agnostic: the runner builds these with path.join, which uses
      // native separators on Windows while the fixture paths are POSIX.
      const normalized = target.replace(/\\/g, "/");
      for (const wt of [...created, ...existing]) {
        if (normalized === wt || normalized.startsWith(`${wt}/`)) return true;
      }
      return false;
    },
    ticketDocs(dir) {
      return [`${ROOT}/.trellis/tasks/${dir}/prd.md`, `${ROOT}/.trellis/tasks/${dir}/implement.md`];
    },
    async worker(req): Promise<WorkerOutcome> {
      h.workerRequests.push(req);
      workerCalls += 1;
      const okFlag =
        workerResults.length > 0 ? workerResults[workerCalls - 1] : (script.workerOk ?? true);
      return okFlag === false
        ? { ok: false, worker: "worker-1", text: "", error: "worker boom: provider exited 1" }
        : { ok: true, worker: "worker-1", text: "implemented and committed" };
    },
    ledgerAppend: (input) => h.ledger.push(input),
    log: (message) => h.logs.push(message),
  };

  h.ports = ports;
  return h;
}

describe("refAllowed — the push whitelist", () => {
  it("matches one segment and refuses a nested ref", () => {
    expect(refAllowed("feature/ticket", "feature/*")).toBe(true);
    expect(refAllowed("feature/a/b", "feature/*")).toBe(false);
  });

  it("matches a bare task slug exactly", () => {
    expect(refAllowed("09-30-deap-draft-evaluation", "09-30-deap-draft-evaluation")).toBe(true);
    expect(refAllowed("09-30-other", "09-30-deap-draft-evaluation")).toBe(false);
  });

  it("accepts a comma list and ignores surrounding blanks", () => {
    expect(refAllowed("oh-my/x", " feature/* , oh-my/* ")).toBe(true);
    expect(refAllowed("release/x", "feature/*,oh-my/*")).toBe(false);
  });

  it("treats regex metacharacters as literals", () => {
    expect(refAllowed("a.b", "a.b")).toBe(true);
    expect(refAllowed("axb", "a.b")).toBe(false);
  });
});

describe("runLoop — the success path", () => {
  it("takes the frontier head, works in its worktree, verifies and archives there", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha", priority: "P0" }] });
    const result = await runLoop(baseOptions(), h.ports);

    expect(result).toMatchObject({
      stopped: "no_grabbable_ticket",
      attempted: 1,
      archived: 1,
      failed: 0,
    });
    expect(h.worktreeAdds).toBe(1);
    const add = h.gitCalls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
    expect(add?.args).toEqual(["worktree", "add", wtOf("01-01-alpha"), "-b", "feature/01-01-alpha", "main"]);
    expect(h.workerRequests[0]?.cwd).toBe(wtOf("01-01-alpha"));
    // No remote at all: the commit on the ticket branch is the accounting, so
    // archiving there is legal and nothing is pushed.
    expect(h.pushed).toEqual([]);
    const archive = h.taskCalls.find((c) => c.args[0] === "archive");
    expect(archive?.cwd).toBe(wtOf("01-01-alpha"));
    expect(h.ledger.map((l) => l.action)).toEqual([
      "run_start",
      "worktree",
      "ticket_start",
      "worker",
      "verify",
      "delivery",
      "archived",
      "stop",
    ]);
  });

  it("clears the worktree pointer before the archive commit", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }] });
    await runLoop(baseOptions(), h.ports);

    const order = h.taskCalls.map((c) => `${c.args[0]} ${c.args.slice(1).join(" ")}`);
    const clear = order.indexOf("set-worktree 01-01-alpha -");
    const archive = order.findIndex((line) => line.startsWith("archive "));
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(archive).toBeGreaterThan(clear);
  });

  it("stops after one ticket without --until-empty", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }, { dir: "01-02-beta" }] });
    const result = await runLoop(baseOptions({ untilEmpty: false }), h.ports);

    expect(result.stopped).toBe("single_ticket");
    expect(result.attempted).toBe(1);
    expect(h.worktreeAdds).toBe(1);
  });

  it("caps attempts at --max-tickets", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }, { dir: "01-02-beta" }, { dir: "01-03-gamma" }] });
    const result = await runLoop(baseOptions({ maxTickets: 2 }), h.ports);

    expect(result.attempted).toBe(2);
    expect(result.stopped).toBe("max_tickets");
  });

  it("moves on to the next ticket after archiving one", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }, { dir: "01-02-beta" }] });
    const result = await runLoop(baseOptions(), h.ports);

    expect(result).toMatchObject({ stopped: "no_grabbable_ticket", attempted: 2, archived: 2 });
    expect(h.worktreeAdds).toBe(2);
    expect(h.workerRequests.map((r) => r.ticket)).toEqual(["01-01-alpha", "01-02-beta"]);
  });

  it("curates context before claiming, inside the worktree", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }] });
    await runLoop(baseOptions(), h.ports);

    const verbs = h.taskCalls.map((c) => c.args[0]);
    expect(verbs.indexOf("add-context")).toBeGreaterThanOrEqual(0);
    expect(verbs.indexOf("add-context")).toBeLessThan(verbs.indexOf("start"));
    const injected = h.taskCalls.filter((c) => c.args[0] === "add-context");
    expect(injected.map((c) => c.args[2]).sort()).toEqual(["check", "check", "implement", "implement"]);
    expect(injected.every((c) => c.cwd === wtOf("01-01-alpha"))).toBe(true);
  });
});

describe("runLoop — the stop lines", () => {
  it("grabs nothing when the dependency graph has a cycle", async () => {
    const h = harness({ cycles: [["01-01-alpha", "01-02-beta"]], ready: [{ dir: "01-01-alpha" }] });
    const result = await runLoop(baseOptions(), h.ports);

    expect(result.stopped).toBe("cycle");
    expect(result.attempted).toBe(0);
    expect(h.worktreeAdds).toBe(0);
    expect(h.ledger.some((l) => l.action === "stop" && /cycle/.test(l.reason ?? ""))).toBe(true);
  });

  it("halts the line after three consecutive failures on one ticket", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }], workerOk: false });
    const result = await runLoop(baseOptions(), h.ports);

    expect(result.stopped).toBe("fail_threshold");
    expect(result.failed).toBe(3);
    expect(result.archived).toBe(0);
    // The human-facing mark lands in the ORCHESTRATING repo (no cwd): that is
    // the copy the board reads when the line is handed back.
    const marked = h.taskCalls.find((c) => c.args[0] === "set-meta");
    expect(marked?.args).toEqual(["set-meta", "01-01-alpha", "triage", "ready-for-human"]);
    expect(marked?.cwd).toBeUndefined();
    expect(h.ledger.some((l) => l.action === "blocked" && /worker_failed/.test(l.reason ?? ""))).toBe(true);
  });

  it("resets strikes once the retried ticket passes", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }], workerOk: [false, false, true] });
    const result = await runLoop(baseOptions(), h.ports);

    expect(result.archived).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.stopped).toBe("no_grabbable_ticket");
    expect(h.taskCalls.some((c) => c.args[0] === "set-meta")).toBe(false);
  });

  it("never delivers on a failed verification contract", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }], remote: true, verifyVerified: false });
    const result = await runLoop({ ...baseOptions({ allowPush: "feature/*" }), failThreshold: 1 }, h.ports);

    expect(result.stopped).toBe("fail_threshold");
    expect(h.pushed).toEqual([]);
    expect(h.ghCalls).toEqual([]);
    expect(h.taskCalls.some((c) => c.args[0] === "archive")).toBe(false);
    expect(h.ledger.some((l) => l.action === "verify" && l.exit !== 0)).toBe(true);
  });

  it("stops at the ticket rather than pushing without a whitelist", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }], remote: true });
    const result = await runLoop(baseOptions(), h.ports);

    expect(result.stopped).toBe("delivery_deferred");
    expect(result.attempted).toBe(1);
    expect(result.archived).toBe(0);
    expect(h.pushed).toEqual([]);
    expect(h.taskCalls.some((c) => c.args[0] === "archive")).toBe(false);
    expect(h.ledger.find((l) => l.action === "delivery")?.reason).toMatch(/deferred/);
  });

  it("refuses and halts when the ticket branch is outside the whitelist", async () => {
    const h = harness({
      ready: [{ dir: "01-01-alpha" }],
      remote: true,
      fields: { "01-01-alpha": { branch: "main", base_branch: "develop" } },
    });
    const result = await runLoop(baseOptions({ allowPush: "feature/*" }), h.ports);

    expect(result.stopped).toBe("push_refused");
    expect(h.pushed).toEqual([]);
    expect(h.taskCalls.some((c) => c.args[0] === "archive")).toBe(false);
    expect(h.ledger.some((l) => l.action === "delivery" && /rejected/.test(l.reason ?? ""))).toBe(true);
  });

  it("pushes, opens a ready PR and records the pointer when the whitelist admits the ref", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }], remote: true });
    const result = await runLoop(baseOptions({ allowPush: "feature/*" }), h.ports);

    expect(result.archived).toBe(1);
    expect(h.pushed).toEqual([["push", "-u", "origin", "feature/01-01-alpha"]]);
    expect(h.ghCalls[0]?.slice(0, 2)).toEqual(["pr", "create"]);
    expect(h.ghCalls[0]).toContain("--ready");
    const setPr = h.taskCalls.find((c) => c.args[0] === "set-pr");
    expect(setPr?.args[1]).toBe("01-01-alpha");
    expect(setPr?.args[2]).toBe("https://github.com/o/r/pull/9");
    expect(setPr?.cwd).toBe(wtOf("01-01-alpha"));
  });

  it("leaves a ticket that already has a review pointer untouched", async () => {
    const h = harness({
      ready: [{ dir: "01-01-alpha" }],
      remote: true,
      fields: { "01-01-alpha": { pr_url: "https://github.com/o/r/pull/1" } },
    });
    const result = await runLoop(baseOptions(), h.ports);

    expect(result.stopped).toBe("no_grabbable_ticket");
    expect(result.attempted).toBe(0);
    expect(h.worktreeAdds).toBe(0);
  });

  it("skips a ticket a previous run already archived on its branch", async () => {
    // The orchestrating copy lags until the branch is merged, so the frontier
    // still lists it. Reading the branch is what keeps the loop from re-grabbing
    // work nobody asked for and striking out on a task dir that is not there.
    const h = harness({ ready: [{ dir: "01-01-alpha" }], closedOnBranch: ["01-01-alpha"] });
    const result = await runLoop(baseOptions(), h.ports);

    expect(result.stopped).toBe("no_grabbable_ticket");
    expect(result.attempted).toBe(0);
    expect(h.worktreeAdds).toBe(0);
    expect(h.ledger.some((l) => l.action === "stop" && /already archived on/.test(l.reason ?? "")))
      .toBe(true);
  });

  it("does not stack a worktree onto one that is still there", async () => {
    // A kept worktree means nobody cleaned up a previous attempt yet — skipping
    // it is not a failure, and re-adding on top would clobber the evidence.
    const h = harness({
      ready: [{ dir: "01-01-alpha" }],
      existingWorktrees: [wtOf("01-01-alpha")],
    });
    const result = await runLoop({ ...baseOptions(), failThreshold: 1 }, h.ports);

    expect(h.worktreeAdds).toBe(0);
    expect(result.stopped).toBe("no_grabbable_ticket");
    expect(result.attempted).toBe(0);
    expect(result.failed).toBe(0);
    expect(h.ledger.some((l) => l.action === "stop" && /worktree still present/.test(l.reason ?? "")))
      .toBe(true);
  });

  it("refuses to invent a ref for a ticket without branch metadata", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }], fields: { "01-01-alpha": {} } });
    const result = await runLoop({ ...baseOptions(), failThreshold: 1 }, h.ports);

    expect(result.stopped).toBe("fail_threshold");
    expect(h.worktreeAdds).toBe(0);
    expect(h.ledger.some((l) => l.action === "blocked" && /no_branch_metadata/.test(l.reason ?? ""))).toBe(
      true,
    );
  });
});

describe("normalizeOptions — the CLI surface refuses ambiguity", () => {
  it("requires a named worker", () => {
    const out = normalizeOptions({ dryRun: true }, ROOT);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/needs --provider/);
  });

  it("rejects a provider with no adapter", () => {
    const out = normalizeOptions({ provider: "gemini" }, ROOT);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/unknown --provider/);
  });

  it("accepts an agent definition in place of a provider", () => {
    const out = normalizeOptions({ agent: "reviewer" }, ROOT);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.options.agent).toBe("reviewer");
  });

  it("defaults the thresholds the contract names", () => {
    const out = normalizeOptions({ provider: "claude" }, ROOT);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.options.maxTickets).toBe(5);
      expect(out.options.failThreshold).toBe(3);
      expect(out.options.allowPush).toBeUndefined();
    }
  });

  it("refuses a non-positive count instead of looping forever", () => {
    for (const raw of [{ provider: "claude", maxTickets: "0" }, { provider: "claude", maxTickets: "-2" }]) {
      const out = normalizeOptions(raw, ROOT);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toMatch(/--max-tickets/);
    }
    const failures = normalizeOptions({ provider: "claude", maxFailures: "x" }, ROOT);
    expect(failures.ok).toBe(false);
  });

  it("parses durations and board filters", () => {
    const out = normalizeOptions(
      { provider: "claude", board: "deap", timeout: "20m", allowPush: " feature/* " },
      ROOT,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.options.board).toBe("deap");
      expect(out.options.workerTimeoutMs).toBe(20 * 60 * 1000);
      expect(out.options.allowPush).toBe("feature/*");
    }
  });
});

describe("runLoop — dry run", () => {
  it("names the head and mutates nothing", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha", priority: "P0" }] });
    const result = await runLoop(baseOptions({ dryRun: true }), h.ports);

    expect(result.stopped).toBe("dry_run");
    expect(result.attempted).toBe(0);
    expect(h.worktreeAdds).toBe(0);
    expect(h.workerRequests).toEqual([]);
    expect(h.gitCalls).toEqual([]);
    expect(h.taskCalls.every((c) => c.args[0] === "frontier")).toBe(true);
    expect(h.logs.join("\n")).toContain("01-01-alpha");
  });

  it("prints the delivery mode it would use", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }], remote: true });
    await runLoop(baseOptions({ dryRun: true, allowPush: "feature/*" }), h.ports);

    const printed = h.logs.find((line) => line.startsWith("{"));
    expect(printed).toContain("delivery:push(feature/*)+pr");
  });

  it("says delivery stays deferred when no whitelist was given", async () => {
    const h = harness({ ready: [{ dir: "01-01-alpha" }] });
    await runLoop(baseOptions({ dryRun: true }), h.ports);

    const printed = h.logs.find((line) => line.startsWith("{"));
    expect(printed).toContain("delivery:deferred(no --allow-push)");
  });
});
