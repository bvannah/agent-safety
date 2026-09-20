/**
 * Fast command scanner.
 *
 * `scanCommand` is the single entry point used by every adapter. It never
 * spawns subprocesses and performs no I/O so it can run safely inside the
 * pre-execution hook of a coding agent.
 *
 * Matching order per rule:
 *   1. needle fast-path  — skip the rule entirely when no cheap substring
 *                          appears in the normalized command.
 *   2. regex patterns     — run against the normalized command; if none hit,
 *                          rerun against a de-escaped copy so `rm\ -rf`
 *                          is still caught.
 *   3. `targetCheck`      — optional second stage that suppresses false
 *                          positives on routine commands.
 *   4. escalation         — `escalate` promotes the effective severity to
 *                          `critical` (fail-closed floor).
 *
 * Rule overrides ("off" or a severity) are applied here so tests cover the
 * exact semantics the adapters rely on.
 */

import { RULES } from "./rules.js";
import type {
  RuleMatch,
  RuleOverride,
  ScanOptions,
  ScanResult,
  SafetyRule,
  Severity,
} from "./types.js";

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 3,
  needsReview: 2,
  informational: 1,
};

/** Collapse whitespace runs to single spaces and trim. */
export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/**
 * A de-escaped copy of the command: backslash-escaped shell metacharacters
 * are unescaped, so `rm\ -rf` / `git\ reset --hard` are still recognized.
 */
export function deEscapeCommand(command: string): string {
  return command.replace(/\\([^\w])/g, "$1");
}

function effectiveSeverity(
  rule: SafetyRule,
  override: RuleOverride | undefined,
  escalated: boolean
): Severity | null {
  if (override === "off") return null;
  const base: Severity = override ?? rule.severity;
  if (escalated) return "critical";
  return base;
}

function hasNeedle(rule: SafetyRule, normalized: string, deEscaped: string): boolean {
  const needles = rule.needles;
  if (!needles || needles.length === 0) return true;
  const lower = normalized.toLowerCase();
  const lowerD = deEscaped.toLowerCase();
  for (const n of needles) {
    const nl = n.toLowerCase();
    if (lower.includes(nl) || lowerD.includes(nl)) return true;
  }
  return false;
}

/**
 * Scan a command for matching safety rules.
 * Returns the matches, bucketed by effective severity.
 */
export function scanCommand(rawCommand: string, opts: ScanOptions = {}): ScanResult {
  const command = normalizeCommand(rawCommand);
  const deEscaped = deEscapeCommand(command);
  const cwd = opts.cwd ?? "";
  const overrides = opts.overrides ?? {};
  const matches: RuleMatch[] = [];

  for (const rule of RULES) {
    if (!hasNeedle(rule, command, deEscaped)) continue;

    const override = overrides[rule.id];

    const test = (seed: string) =>
      rule.patterns.some((p) => {
        p.lastIndex = 0;
        return p.test(seed);
      });
    let hit = test(command) || (deEscaped !== command && test(deEscaped));

    if (hit && rule.targetCheck) {
      const okNorm = rule.targetCheck(command, cwd);
      const okDe = deEscaped !== command ? rule.targetCheck(deEscaped, cwd) : okNorm;
      hit = okNorm || okDe;
    }
    if (!hit) continue;

    const escalated =
      rule.escalate &&
      (rule.escalate(command, cwd) || (deEscaped !== command && rule.escalate(deEscaped, cwd)));

    const sev = effectiveSeverity(rule, override, escalated ?? false);
    if (sev === null) continue;
    matches.push({ rule, severity: sev });
  }

  matches.sort(
    (a, b) =>
      SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
      RULES.indexOf(a.rule) - RULES.indexOf(b.rule)
  );

  return {
    matches,
    critical: matches.filter((m) => m.severity === "critical"),
    needsReview: matches.filter((m) => m.severity === "needsReview"),
    informational: matches.filter((m) => m.severity === "informational"),
    hasHits: matches.length > 0,
  };
}