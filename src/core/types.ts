/**
 * Shared type definitions for the agent-safety guard.
 *
 * This module is intentionally free of runtime dependencies so it can be
 * imported from both the Pi extension and (later) the OpenCode plugin, as
 * well as the test suite.
 */

export type Severity = "critical" | "needsReview" | "informational";

/**
 * Per-rule override values. "off" disables a rule entirely.
 */
export type RuleOverride = Severity | "off";

/**
 * A single safety rule describing a class of unsafe commands.
 *
 * `patterns` are matched against the normalized command (and a de-escaped
 * variant). `targetCheck` is an optional second-stage pure function used to
 * confirm context (e.g. the target of `rm` is dangerous) and prevent false
 * positives on routine commands.
 */
export interface SafetyRule {
  id: string;
  category: string;
  severity: Severity;
  description: string;
  patterns: RegExp[];
  /** Cheap substring needles checked before running the regexes (fast path). */
  needles?: string[];
  /** Optional second-stage check; if it returns true the rule fires. */
  targetCheck?: (cmd: string, cwd: string) => boolean;
  /** Optional escalation: if true the effective severity becomes "critical". */
  escalate?: (cmd: string, cwd: string) => boolean;
  /** Commands that MUST NOT trip this rule (auto-tested). */
  safeExamples: string[];
  /** Commands that MUST trip this rule (auto-tested). */
  unsafeExamples: string[];
}

export interface RuleMatch {
  rule: SafetyRule;
  /** Effective severity after overrides + escalation. */
  severity: Severity;
}

export interface ScanOptions {
  cwd?: string;
  overrides?: Record<string, RuleOverride>;
}

export interface ScanResult {
  matches: RuleMatch[];
  critical: RuleMatch[];
  needsReview: RuleMatch[];
  informational: RuleMatch[];
  hasHits: boolean;
}

export interface Verdict {
  verdict: "allow" | "block";
  reason: string;
  source: "critical" | "subagent" | "disabled" | "denied";
}

export interface Settings {
  enabled: boolean;
  blockCritical: boolean;
  useSubagent: boolean;
  subagentTimeoutMs: number;
  reviewerModel?: string | null;
  reviewerProvider?: string | null;
  reviewCacheTtlMs: number;
  maxSubagentReviewsPerSession: number;
  logFile: string | null;
  overrides: Record<string, RuleOverride>;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  blockCritical: true,
  useSubagent: true,
  subagentTimeoutMs: 30000,
  reviewerModel: null,
  reviewerProvider: null,
  reviewCacheTtlMs: 10 * 60 * 1000,
  maxSubagentReviewsPerSession: 20,
  logFile: null,
  overrides: {},
};