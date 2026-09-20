/**
 * Subagent reviewer that spawns a separate `opencode run` process to look at
 * a command and render a verdict.
 *
 * The child is always launched with `--pure` and with `OPENCODE_CONFIG_CONTENT`
 * disabling the `bash` tool, so it can never execute the very command it is
 * reviewing: it is a text-only model call. The stdout stream carries
 * line-delimited JSON events; we keep the assistant `text` parts and parse a
 * BLOCK/ALLOW verdict out of the assembled reply.
 *
 * Any deviation (no text, timeout, non-zero exit, unparseable reply) resolves
 * to a fail-closed `block`.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { VerdictOpinion } from "../core/guard.js";

export interface OpenCodeReviewerOptions {
  command: string;
  /** Human-readable explanation of why the command tripped the guard. */
  findings: string;
  cwd: string;
  timeoutMs: number;
  /** Provider/model string in `provider/model` form; falls back to the parent's. */
  model?: string | null;
  /** Override for the `opencode` binary used by the parent agent. */
  opencodeBinary?: string;
}

const PROMPT_TEMPLATE = `You are a conservative command-safety reviewer for a coding agent.

The agent wants to run this shell command:

{{COMMAND}}

It was flagged for this reason:
{{FINDINGS}}

Review the command carefully. You have NO tools and must never attempt to run
the command. Reply with exactly one line, choosing one of:

ALLOW — the command is not destructive and clearly does what its surrounding
context suggests (listing, building, installing, generating outputs, curl
docs, git checks, reading logs).
BLOCK — the command is destructive, could delete or overwrite user data,
telemetry, secrets, infrastructure or source, is suspicious obfuscation, or
you are at all unsure.

If BLOCK, append a short reason after a colon, e.g. "BLOCK: deletes user data".
`;

function buildPrompt(command: string, findings: string): string {
  return PROMPT_TEMPLATE.replace("{{COMMAND}}", command).replace("{{FINDINGS}}", findings);
}

function findOpenCodeBinary(): string {
  return process.env.AGENT_SAFETY_OPENCODE_BIN ?? "opencode";
}

/** Security lockdown applied to the reviewer child: no bash tool at all. */
export function reviewerConfigContent(): string {
  return JSON.stringify({ tools: { bash: false } });
}

export function spawnOpenCodeReviewer(
  opts: OpenCodeReviewerOptions
): Promise<VerdictOpinion> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

    const finish = (verdict: VerdictOpinion["verdict"], reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ verdict, reason });
    };

    const cleanup = () => {
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* best-effort cleanup */
      }
    };

    const args = ["run", "--format", "json", "--pure"];
    if (opts.model) {
      args.push("--model", opts.model);
    }
    args.push(buildPrompt(opts.command, opts.findings));

    try {
      child = spawn(opts.opencodeBinary ?? findOpenCodeBinary(), args, {
        cwd: opts.cwd,
        // `opencode run` can hang reading an inherited stdin; point it at
        // /dev/null so the reviewer always has a clean input.
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: reviewerConfigContent(),
        },
      });
    } catch {
      finish("block", "reviewer process failed to launch");
      return;
    }
    if (!child) {
      finish("block", "reviewer process failed to launch");
      return;
    }

    const timer = setTimeout(() => {
      finish("block", "reviewer timed out; blocking by default");
    }, opts.timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    if (process.env.AGENT_SAFETY_DEBUG === "1") {
      process.stderr.write(`[ag-safety-reviewer pid=${child.pid} cmd=${opts.command}\n`);
      child.stdout.on("data", (d: string) => process.stderr.write(`[reviewer-out] ${d}`));
      child.stderr.on("data", (d: string) => process.stderr.write(`[reviewer-err] ${d}`));
    }
    child.stdout.on("data", (d: string) => {
      stdout += d;
      // A streamed BLOCK is authoritative and lets us stop the child early.
      const verdict = verdictFromText(stdout);
      if (verdict && verdict.verdict === "block") finish("block", verdict.reason);
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", () => finish("block", "reviewer process error"));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish("block", `reviewer exited with code ${code}`);
        return;
      }
      const verdict = verdictFromText(stdout);
      if (verdict) {
        finish(verdict.verdict, verdict.reason);
      } else {
        finish("block", "reviewer produced no usable verdict");
      }
    });
  });
}

/** Assemble assistant text parts from opencode `--format json` events, then parse. */
function verdictFromText(stdout: string): { verdict: VerdictOpinion["verdict"]; reason: string } | null {
  const chunks: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && parsed.type === "text" && isRecord(parsed.part)) {
        if (typeof parsed.part.text === "string") chunks.push(parsed.part.text);
      }
    } catch {
      continue;
    }
  }
  return parseVerdict(chunks.join(""));
}

function parseVerdict(text: string): { verdict: VerdictOpinion["verdict"]; reason: string } | null {
  const t = text.trim();
  if (!t) return null;
  // Fail-closed: any mention of BLOCK dominates, then ALLOW, else unparseable.
  if (/\bBLOCK\b/i.test(t)) {
    return { verdict: "block", reason: t.slice(0, 200) };
  }
  if (/\bALLOW\b/i.test(t)) {
    return { verdict: "allow", reason: t.slice(0, 200) };
  }
  return { verdict: "block", reason: `unparseable verdict: ${t.slice(0, 120)}` };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}