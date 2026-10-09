/**
 * Integration test for `trellis run --dry-run` against the REAL task system.
 *
 * The unit harness scripts the frontier JSON; this one proves the two things
 * that only show up with real `task.py` output:
 *   - the frontier snapshot the runner parses is the shape `task.py frontier
 *     --json` actually prints (priority order, `--board` filter)
 *   - a dry run writes NOTHING at all: no ledger file, no `.runtime/runs`
 *     directory, no task state change (implement.md 切片 6 AC)
 *
 * Real templates are stamped into a throwaway repo. No worker is ever spawned.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../../src/commands/run.js";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/trellis/scripts",
);

function findPython(): string | null {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const PYTHON = findPython();

function testEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TRELLIS_WRITER: "qoder-TESTHOST-agent" };
}

function runTask(repo: string, ...args: string[]): void {
  const r = spawnSync(PYTHON as string, [".trellis/scripts/task.py", ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: testEnv(),
  });
  if (r.status !== 0) {
    throw new Error(`task.py ${args.join(" ")} failed: ${r.stdout}${r.stderr}`);
  }
}

function taskDir(repo: string, slug: string): string {
  const dir = fs
    .readdirSync(path.join(repo, ".trellis", "tasks"))
    .find((d) => d.includes(slug));
  if (!dir) throw new Error(`no task dir matching ${slug}`);
  return dir;
}

let repo = "";
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "run-dry-itest-"));
  fs.mkdirSync(path.join(repo, ".trellis"), { recursive: true });
  fs.cpSync(TEMPLATE_SCRIPTS, path.join(repo, ".trellis", "scripts"), {
    recursive: true,
  });
  const init = spawnSync(PYTHON as string, [".trellis/scripts/init_developer.py", "tester"], {
    cwd: repo,
    encoding: "utf-8",
    env: testEnv(),
  });
  if (init.status !== 0) {
    throw new Error(`init_developer failed: ${init.stderr}`);
  }
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe.skipIf(PYTHON === null)("trellis run --dry-run", () => {
  it("selects the highest-priority ready ticket from real frontier output", async () => {
    runTask(repo, "create", "Blocked later", "--slug", "zeta", "--no-start", "-d", "waits");
    runTask(repo, "create", "Head work", "--slug", "alpha", "--no-start", "-d", "ready first", "--priority", "P0");

    const blocked = taskDir(repo, "zeta");
    const head = taskDir(repo, "alpha");
    runTask(repo, "set-meta", blocked, "blocked_by", head);

    const original = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(" "));
    let result;
    try {
      result = await runCommand({ dryRun: true, provider: "claude" }, repo);
    } finally {
      console.log = original;
    }

    expect(result.stopped).toBe("dry_run");
    expect(result.attempted).toBe(0);
    const printed = logged.join("\n");
    expect(printed).toContain(head);
    expect(printed).not.toContain(blocked);
    expect(printed).toContain("verify:run-verify");
  });

  it("writes nothing: no ledger file, no runs directory, no state change", async () => {
    runTask(repo, "create", "Only work", "--slug", "alpha", "--no-start", "-d", "ready");
    const head = taskDir(repo, "alpha");
    const before = fs.readFileSync(
      path.join(repo, ".trellis", "tasks", head, "task.json"),
      "utf-8",
    );

    const original = console.log;
    console.log = () => undefined;
    try {
      await runCommand({ dryRun: true, provider: "claude", untilEmpty: true }, repo);
    } finally {
      console.log = original;
    }

    expect(fs.existsSync(path.join(repo, ".trellis", ".runtime", "runs"))).toBe(false);
    expect(
      fs.readFileSync(path.join(repo, ".trellis", "tasks", head, "task.json"), "utf-8"),
    ).toBe(before);
  });

  it("rejects an unknown provider before touching anything", async () => {
    await expect(
      runCommand({ provider: "gemini", dryRun: true }, repo),
    ).rejects.toThrow(/unknown --provider/);
    expect(fs.existsSync(path.join(repo, ".trellis", ".runtime", "runs"))).toBe(false);
  });

  it("demands a named worker instead of defaulting in the dark", async () => {
    await expect(runCommand({ dryRun: true }, repo)).rejects.toThrow(
      /needs --provider/,
    );
  });

  it("refuses a repo it does not drive", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "run-no-trellis-"));
    try {
      await expect(runCommand({ provider: "claude", dryRun: true }, bare)).rejects.toThrow(
        /no .trellis\/scripts\/task.py/,
      );
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
