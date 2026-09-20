/**
 * Framework-agnostic command guard.
 *
 * Wraps the scan → tier → review flow so per-agent adapters (Pi, OpenCode)
 * only have to provide settings loading and a reviewer sub-process. The guard
 * owns: fail-closed critical blocking, the review budget, verdict caching,
 * in-flight dedupe, and file logging. It never knows about any agent API.
 *
 * Reviewer failures (timeout, bad output, non-zero exit) are handled by the
 * caller-provided `review` function in a fail-closed way.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { scanCommand } from "./matcher.js";
import type { RuleMatch, Settings } from "./types.js";

export interface ReviewRequest {
  command: string;
  findings: string;
  cwd: string;
}

export type VerdictOpinion = { verdict: "allow" | "block"; reason: string };

export interface GuardCallbacks {
  /** Load effective settings for a working directory (cached by the guard). */
  loadSettings(cwd: string): Settings;
  /** Ask the agent-specific reviewer sub-process for a verdict (fail-closed). */
  review(req: ReviewRequest): Promise<VerdictOpinion>;
}

export interface HandleOptions {
  command: string;
  cwd: string;
  /** Optional UI notifier; missing UI just skips notifications. */
  notify?: (type: "info" | "warning" | "error", text: string) => void;
}

export interface HandleResult {
  block?: boolean;
  reason?: string;
}

/** Loader-backed settings cache per working directory, refreshed every few seconds. */
export class SettingsCache {
  private cache = new Map<string, { settings: Settings; at: number }>();
  private ttl: number;

  constructor(private load: (cwd: string) => Settings, ttlMs = 10_000) {
    this.ttl = ttlMs;
  }

  get(cwd: string): Settings {
    const hit = this.cache.get(cwd);
    if (hit && Date.now() - hit.at < this.ttl) return hit.settings;
    const settings = this.load(cwd);
    this.cache.set(cwd, { settings, at: Date.now() });
    return settings;
  }

  clear(): void {
    this.cache.clear();
  }
}

/** In-memory verdict cache (stores the last-reviewed outcome per command). */
export class VerdictCache {
  private store = new Map<
    string,
    { verdict: "allow" | "block"; reason: string; at: number }
  >();
  private ttlMs: number;

  /** `ttlMs < 0` keeps entries forever (recommended for blocks). */
  constructor(ttlMs = -1) {
    this.ttlMs = ttlMs;
  }

  get(key: string): VerdictOpinion | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.ttlMs >= 0 && Date.now() - entry.at > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return { verdict: entry.verdict, reason: entry.reason };
  }

  set(key: string, value: VerdictOpinion): void {
    this.store.set(key, { ...value, at: Date.now() });
    if (this.store.size > 512) {
      const first = this.store.keys().next().value;
      if (first !== undefined) this.store.delete(first);
    }
  }
}

function describeFindings(matches: RuleMatch[]): string {
  return matches.map((m) => `- ${m.rule.id}: ${m.rule.description}`).join("\n");
}

export function logToFile(settings: Settings, entry: Record<string, unknown>): void {
  const file = settings.logFile;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    /* logging must never break the guard */
  }
}

export class Guard {
  private settingsCache: SettingsCache;
  private verdictCache = new VerdictCache();
  private inflight = new Map<string, Promise<VerdictOpinion>>();
  private reviewsThisSession = 0;

  constructor(private callbacks: GuardCallbacks) {
    this.settingsCache = new SettingsCache(callbacks.loadSettings);
  }

  /** A fresh session restarts the subagent review budget and settings cache. */
  resetSession(): void {
    this.reviewsThisSession = 0;
    this.settingsCache.clear();
  }

  /**
   * Decide whether a command may run. Returns `undefined` to allow (with
   * logging), or `{ block: true, reason }` to stop it before execution.
   */
  async handle({
    command,
    cwd,
    notify,
  }: HandleOptions): Promise<HandleResult | undefined> {
    if (!command || !command.trim()) return undefined;

    const settings = this.settingsCache.get(cwd);
    if (!settings.enabled) return undefined;

    const result = scanCommand(command, { cwd, overrides: settings.overrides });
    if (!result.hasHits) return undefined;

    const findings = describeFindings(result.matches);
    const warn = (type: "info" | "warning" | "error", text: string) => {
      try {
        notify?.(type, text);
      } catch {
        /* best-effort */
      }
    };

    // ── critical tier ──────────────────────────────────────────────
    if (result.critical.length > 0 && settings.blockCritical) {
      const first = result.critical[0]!;
      const hits = result.critical.map((m) => m.rule.id).join(", ");
      const reason = `agent-safety blocked: ${hits} (${first.rule.description})`;
      warn("error", reason);
      logToFile(settings, { event: "block-critical", cwd, command, findings, reason });
      return { block: true, reason };
    }

    const reviewable = result.critical.length > 0 || result.needsReview.length > 0;
    if (!reviewable) {
      logToFile(settings, { event: "allow-informational", cwd, command, findings });
      return undefined;
    }

    // ── needsReview tier (incl. critical when blockCritical=false) ──
    if (!settings.useSubagent) {
      logToFile(settings, {
        event: "allow-review-disabled",
        cwd,
        command,
        findings,
        criticalBlocked: result.critical.length > 0 && settings.blockCritical,
      });
      if (result.critical.length > 0 && settings.blockCritical) {
        warn("warning", `agent-safety: critical command bypassed (blockCritical=false)`);
      }
      return undefined;
    }

    if (this.reviewsThisSession >= settings.maxSubagentReviewsPerSession) {
      const reason = "agent-safety: subagent review budget exhausted; blocking to be safe";
      warn("error", reason);
      logToFile(settings, { event: "block-budget", cwd, command, findings, reason });
      return { block: true, reason };
    }

    const cacheKey = `${cwd}\u0000${command}`;
    const cached = this.verdictCache.get(cacheKey);
    if (cached) {
      if (cached.verdict === "block") {
        logToFile(settings, {
          event: "block-cached",
          cwd,
          command,
          findings,
          reason: cached.reason,
        });
        warn("error", cached.reason);
        return { block: true, reason: cached.reason };
      }
      logToFile(settings, { event: "allow-cached", cwd, command, findings });
      return undefined;
    }

    this.reviewsThisSession++;

    let review = this.inflight.get(cacheKey);
    if (!review) {
      review = this.callbacks
        .review({ command, findings, cwd })
        .finally(() => {
          this.inflight.delete(cacheKey);
        });
      this.inflight.set(cacheKey, review);
    }

    const opinion = await review;
    this.verdictCache.set(cacheKey, opinion);

    if (opinion.verdict === "block") {
      const reason = `agent-safety: ${opinion.reason}`;
      logToFile(settings, { event: "block-subagent", cwd, command, findings, reason });
      warn("error", reason);
      return { block: true, reason };
    }

    logToFile(settings, {
      event: "allow-subagent",
      cwd,
      command,
      findings,
      reason: opinion.reason,
    });
    return undefined;
  }
}