/**
 * One-shot headless worker for the loop runner.
 *
 * Same primitives as `channel run` (ephemeral channel → spawn → send → wait on
 * the event stream), but it RETURNS an outcome instead of printing and setting
 * `process.exitCode`: a loop needs `ok / text / worker` per ticket, and a
 * failed worker must not end the process that is about to try again.
 *
 * A failed channel is kept for inspection exactly like `channel run` does —
 * it stays `ephemeral`, so `channel prune --ephemeral` reclaims it.
 */

import crypto from "node:crypto";
import fs from "node:fs";

import type { Provider } from "../channel/adapters/index.js";
import { createChannel } from "../channel/create.js";
import { channelRm } from "../channel/rm.js";
import { channelSend } from "../channel/send.js";
import { channelSpawn } from "../channel/spawn.js";
import { channelDir, eventsPath } from "../channel/store/paths.js";
import type { ChannelEvent } from "../channel/store/events.js";
import { watchEvents } from "../channel/store/watch.js";

export interface WorkerRequest {
  /** Task dir name; used to name the channel and to label the ledger. */
  ticket: string;
  /** Working directory the worker runs in — the ticket's worktree. */
  cwd: string;
  prompt: string;
  provider?: Provider;
  agent?: string;
  model?: string;
  timeoutMs: number;
  /** Context files handed to the worker (ticket docs + spec indexes). */
  files?: string[];
  jsonls?: string[];
}

export interface WorkerOutcome {
  ok: boolean;
  worker: string;
  /** The worker's last user-visible message, when there was one. */
  text: string;
  /** Set when the worker failed: kept channel dir for inspection. */
  channelDir?: string;
  error?: string;
}

function channelNameFor(ticket: string): string {
  const slug = ticket
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const rand = crypto.randomBytes(4).toString("hex");
  return `run-${slug || "ticket"}-${rand}`;
}

/** Last `message` event authored by this worker, read back off the store. */
function finalMessage(channelName: string, workerName: string): string {
  const file = eventsPath(channelName);
  if (!fs.existsSync(file)) return "";
  const body = fs.readFileSync(file, "utf-8");
  let candidate: ChannelEvent | undefined;
  for (const raw of body.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const ev = JSON.parse(raw) as ChannelEvent;
      if (ev.kind === "message" && ev.by === workerName) candidate = ev;
    } catch {
      // A torn tail line is expected while the supervisor is mid-write.
    }
  }
  return (candidate as { text?: string } | undefined)?.text ?? "";
}

async function waitForTerminal(
  channelName: string,
  workerName: string,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    for await (const ev of watchEvents(
      channelName,
      { self: "main", from: [workerName] },
      { signal: abort.signal },
    )) {
      if (ev.kind === "done") return { ok: true };
      if (ev.kind === "error") {
        const msg = (ev as { message?: string }).message ?? "(no message)";
        return { ok: false, error: `worker ${workerName} reported error: ${msg}` };
      }
      if (ev.kind === "killed") {
        const reason = (ev as { reason?: string }).reason ?? "(unknown)";
        return { ok: false, error: `worker ${workerName} killed: ${reason}` };
      }
    }
    return {
      ok: false,
      error: `timeout after ${timeoutMs}ms waiting for ${workerName} done`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function oneShotWorker(
  req: WorkerRequest,
): Promise<WorkerOutcome> {
  const name = channelNameFor(req.ticket);
  let workerName = "";

  await createChannel(name, {
    by: "main",
    cwd: req.cwd,
    ephemeral: true,
    origin: "run",
  });

  try {
    const spawned = await channelSpawn(name, {
      agent: req.agent,
      provider: req.provider,
      cwd: req.cwd,
      model: req.model,
      timeoutMs: req.timeoutMs,
      files: req.files,
      jsonls: req.jsonls,
    });
    workerName = spawned.worker;

    await channelSend(name, { as: "main", to: workerName, text: req.prompt });

    const wait = await waitForTerminal(name, workerName, req.timeoutMs);
    const text = finalMessage(name, workerName);
    if (!wait.ok) {
      return {
        ok: false,
        worker: workerName,
        text,
        channelDir: channelDir(name),
        error: wait.error,
      };
    }
    await channelRm(name, { force: true });
    return { ok: true, worker: workerName, text };
  } catch (err) {
    return {
      ok: false,
      worker: workerName,
      text: "",
      channelDir: channelDir(name),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
