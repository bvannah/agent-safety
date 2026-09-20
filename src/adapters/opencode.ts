/**
 * OpenCode plugin adapter.
 *
 * Thin wiring of the shared {@link Guard} into OpenCode's
 * `tool.execute.before` hook. Only the `bash` tool is scanned. The guard
 * blocks a critical command by throwing (OpenCode's documented way to cancel a
 * tool call), or asks a tool-less `opencode run --pure` child for a verdict.
 *
 * The plugin reuses the same settings file as the Pi extension
 * (`~/.pi/agent/safety.json`, or `<cwd>/safety.json`, or `AGENT_SAFETY_CONFIG`).
 * The OpenCode reviewer inherits the parent agent's default model; set
 * `AGENT_SAFETY_OPENCODE_MODEL` to force a specific `provider/model`.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { Guard } from "../core/guard.js";
import { loadSettings } from "../core/settings.js";
import type { Settings } from "../core/types.js";
import { spawnOpenCodeReviewer } from "../subagent/opencode-reviewer.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface OpenCodePluginOptions {
  /** External settings source (tests, embedding). Defaults to the loader. */
  loadSettings?: (cwd: string) => Settings;
}

export const opencodeAgentSafetyPlugin: Plugin = async (
  input: PluginInput,
  opts: OpenCodePluginOptions = {}
) => {
  const cwd = () => input.worktree ?? input.directory ?? process.cwd();
  const load = opts.loadSettings ?? loadSettings;

  const guard = new Guard({
    loadSettings: (dir) => load(dir),
    review: async ({ command, findings, cwd: dir }) => {
      const settings = load(dir);
      return spawnOpenCodeReviewer({
        command,
        findings,
        cwd: dir,
        timeoutMs: settings.subagentTimeoutMs,
        model: process.env.AGENT_SAFETY_OPENCODE_MODEL ?? null,
      });
    },
  });

  return {
    // A new session restarts the subagent review budget.
    event: async ({ event }) => {
      if (event.type === "session.created") guard.resetSession();
    },

    "tool.execute.before": async (event, output) => {
      if (event.tool !== "bash") return;
      const command = isRecord(output.args) ? output.args.command : undefined;
      if (typeof command !== "string" || !command.trim()) return;

      const result = await guard.handle({ command, cwd: cwd() });
      if (result?.block) {
        // Throwing is how a plugin cancels a tool call in OpenCode.
        throw new Error(result.reason ?? "agent-safety blocked the command");
      }
    },
  };
};

export default opencodeAgentSafetyPlugin;