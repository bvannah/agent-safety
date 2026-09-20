/**
 * Settings loading + merging.
 *
 * Configuration sources, lowest to highest precedence:
 *   1. `DEFAULT_SETTINGS`
 *   2. `~/.pi/agent/safety.json`        (global)
 *   3. `<workspaceRoot>/safety.json`    (per-project)
 *   4. `AGENT_SAFETY_CONFIG` env var pointing at an explicit JSON file
 *
 * `overrides` objects are merged per-key (rule id) across sources.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { env as processEnv } from "node:process";
import { resolve } from "node:path";
import type { Settings } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

export function defaultSettings(): Settings {
  return structuredClone(DEFAULT_SETTINGS);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function candidatePaths(cwd: string): string[] {
  // Low → high precedence so later files override earlier ones:
  // global → project → explicit env-var file.
  const paths: string[] = [];
  paths.push(resolve(homedir(), ".pi", "agent", "safety.json"));
  if (cwd) paths.push(resolve(cwd, "safety.json"));
  const explicit = processEnv.AGENT_SAFETY_CONFIG;
  if (explicit) paths.push(resolve(explicit));
  return paths;
}

function readJsonNoThrow(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mergeSettings(base: Settings, raw: Record<string, unknown>): Settings {
  const next = { ...base };
  if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
  if (typeof raw.blockCritical === "boolean") next.blockCritical = raw.blockCritical;
  if (typeof raw.useSubagent === "boolean") next.useSubagent = raw.useSubagent;
  if (typeof raw.subagentTimeoutMs === "number") next.subagentTimeoutMs = raw.subagentTimeoutMs;
  if (typeof raw.reviewerModel === "string" || raw.reviewerModel === null)
    next.reviewerModel = raw.reviewerModel;
  if (typeof raw.reviewerProvider === "string" || raw.reviewerProvider === null)
    next.reviewerProvider = raw.reviewerProvider;
  if (typeof raw.reviewCacheTtlMs === "number") next.reviewCacheTtlMs = raw.reviewCacheTtlMs;
  if (typeof raw.maxSubagentReviewsPerSession === "number")
    next.maxSubagentReviewsPerSession = raw.maxSubagentReviewsPerSession;
  if (typeof raw.logFile === "string" || raw.logFile === null) next.logFile = raw.logFile;
  if (isRecord(raw.overrides)) {
    const merged = { ...next.overrides };
    for (const [k, v] of Object.entries(raw.overrides)) {
      if (v === "off" || v === "critical" || v === "needsReview" || v === "informational") {
        merged[k] = v;
      }
    }
    next.overrides = merged;
  }
  return next;
}

/**
 * Load and merge settings. Never throws: invalid or unreadable config files
 * are skipped so the guard stays fail-open at the configuration layer.
 */
export function loadSettings(cwd = ""): Settings {
  let settings = defaultSettings();
  for (const file of candidatePaths(cwd)) {
    const raw = readJsonNoThrow(file);
    if (raw) settings = mergeSettings(settings, raw);
  }
  return settings;
}

export function workspaceSettings(cwd = ""): { settings: Settings; source: string | null } {
  let settings = defaultSettings();
  let source: string | null = null;
  for (const file of candidatePaths(cwd)) {
    const raw = readJsonNoThrow(file);
    if (raw) {
      settings = mergeSettings(settings, raw);
      source = file;
    }
  }
  return { settings, source };
}