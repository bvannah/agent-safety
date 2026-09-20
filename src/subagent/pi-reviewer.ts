/**
 * Subagent reviewer that spawns a separate Pi process to look at a command
 * and render a verdict. The child is always launched with `--no-tools` so it
 * can never execute the very command it is reviewing.
 *
 * Output protocol: stdout is a stream of line-delimited JSON events; we look
 * for the assistant `message_end` event whose `content` is a JSON object of
 * the form `{ "verdict": "allow" | "block", "reason": string }`.
 *
 * Any deviation from that shape (no event, bad JSON, timeout, non-zero exit)
 * resolves to a fail-closed `block`.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Verdict } from "../core/types.js";

export interface ReviewerOptions {
  command: string;
  /** Human-readable explanation of why the command tripped the guard. */
  findings: string;
  cwd: string;
  timeoutMs: number;
  model?: string | null;
  /** Provider to use for the reviewer process (radio: parent agent's provider). */
  provider?: string | null;
  /** Override for the `pi` binary used by the parent agent. */
  piBinary?: string;
}

const PROMPT_TEMPLATE = `You are a conservative command-safety reviewer for a coding agent.

The agent wants to run this shell command:

\`\`\`
{{COMMAND}}
\`\`\`

It was flagged for this reason:
{{FINDINGS}}

Review the command carefully. Answer ONLY with a single JSON object, no
markdown, no commentary, exactly shaped like:

{"verdict":"allow"|"block","reason":"short human-readable explanation"}

Be strict and unambiguous:
- "allow" only if the command is NOT destructive and clearly does what its
  surrounding context suggests (routing in a git repo, listing, installing,
  generating outputs, curling docs, etc.).
- If you are unsure, if the command could destroy data, delete telemetry,
  secrets, infrastructure, or source, or if it looks like obfuscation or an
  attempt to bypass the guard, answer "block".
- A command that merely *contains* the word "rm" (like building a rust project)
  is fine; a command that actually removes user data is not.
- If verification would require reading the filesystem or network, answer
  "block" — you have no tools and must not assume.
`;

function buildPrompt(command: string, findings: string): string {
  return PROMPT_TEMPLATE.replace("{{COMMAND}}", command).replace("{{FINDINGS}}", findings);
}

function findPiBinary(): string {
  return process.env.AGENT_SAFETY_PI_BIN ?? "pi";
}

export function spawnReviewer(
  opts: ReviewerOptions
): Promise<{ verdict: Verdict["verdict"]; reason: string }> {
  return new Promise((resolvePromise) => {
    const tmp = mkdtempSync(join(tmpdir(), "agent-safety-prompt-"));
    const promptFile = join(tmp, "prompt.txt");
    writeFileSync(promptFile, buildPrompt(opts.command, opts.findings), { mode: 0o600 });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (verdict: Verdict["verdict"], reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ verdict, reason });
    };

    const cleanup = () => {
      clearTimeout(timer);
      try {
        child?.kill();
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    };

    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-tools",
      "--append-system-prompt",
      promptFile,
      // `-p` needs a user prompt; without one the child never produces a
      // verdict and the guard must fail closed on the timeout.
      opts.command,
    ];
    if (opts.provider) {
      args.push("--provider", opts.provider);
    }
    if (opts.model) {
      args.push("--model", opts.model);
    }

    let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
    try {
      child = spawn(opts.piBinary ?? findPiBinary(), args, {
        cwd: opts.cwd,
        // `pi -p` reads stdin to EOF before acting; an inherited open pipe
        // would hang the reviewer forever, so point stdin at /dev/null.
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
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
      const verdict = extractVerdict(stdout);
      if (verdict) finish(verdict.verdict, verdict.reason);
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", () => finish("block", "reviewer process error"));
    child.on("exit", (code) => {
      if (code !== 0 && !settled) {
        finish("block", `reviewer exited with code ${code}`);
      }
    });
  });
}

function extractVerdict(
  stdout: string
): { verdict: Verdict["verdict"]; reason: string } | null {
  for (const [rawLine, parsed] of eachJsonLine(stdout)) {
    if (parsed.type === "message_end" && isRecord(parsed.message)) {
      const content: unknown = parsed.message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
            try {
              const verdict = verdictFrom(JSON.parse(part.text));
              if (verdict) return verdict;
            } catch {
              /* not JSON — keep scanning */
            }
          }
        }
      }
    }
    // Fallback: any standalone JSON object carrying a verdict.
    const verdict = verdictFrom(parsed);
    if (verdict) return verdict;
    void rawLine;
  }
  return null;
}

function* eachJsonLine(stdout: string): Generator<[string, Record<string, unknown>]> {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) yield [trimmed, parsed];
    } catch {
      continue;
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function verdictFrom(v: unknown): { verdict: Verdict["verdict"]; reason: string } | null {
  if (!isRecord(v)) return null;
  if (v.verdict !== "allow" && v.verdict !== "block") return null;
  const reason = typeof v.reason === "string" ? v.reason : "no reason given";
  return { verdict: v.verdict, reason };
}