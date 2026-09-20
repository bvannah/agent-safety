#!/usr/bin/env node
// Fake `opencode run` reviewer binary for tests. Validates the reviewer
// invocation contract, then emits configurable `--format json` text events:
//
//   STUB_EMIT     JSONL line(s) written to stdout after STUB_PRE_MS
//   STUB_EXIT     exit code after STUB_HOLD_MS (default 0)
//   STUB_PRE_MS   delay before emitting (default 0)
//   STUB_HOLD_MS  delay between emit and exit (default 0)
//
// Exit codes guard against regressions:
//   3  no prompt message was passed
//   4  OPENCODE_CONFIG_CONTENT did not disable the bash tool (lockdown)
//   5  the invocation was missing `run --format json --pure`
const args = process.argv.slice(2);
const flagErrors = [];
if (!args.includes("run")) flagErrors.push("run");
if (!args.includes("--format")) flagErrors.push("--format");
if (!args.includes("json")) flagErrors.push("json");
if (!args.includes("--pure")) flagErrors.push("--pure");
if (flagErrors.length > 0) {
  process.stderr.write(`stub-opencode-reviewer: missing flags: ${flagErrors.join(", ")}`);
  process.exit(5);
}
const prompt = args[args.length - 1];
if (!prompt || prompt.startsWith("-") || prompt.length < 50) {
  process.stderr.write("stub-opencode-reviewer: no prompt message passed");
  process.exit(3);
}
const configContent = process.env.OPENCODE_CONFIG_CONTENT ?? "";
let config = {};
try {
  config = JSON.parse(configContent);
} catch {
  config = {};
}
if (!config.tools || config.tools.bash !== false) {
  process.stderr.write("stub-opencode-reviewer: bash tool was not disabled");
  process.exit(4);
}
if (process.env.STUB_EXIT_ARGCHECK) {
  process.stdout.write(JSON.stringify({ args }) + "\n");
  process.exit(0);
}
if (process.env.STUB_ARGCHECK_FILE) {
  // Dump argv without emitting a verdict, so the caller can assert the spawn.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.STUB_ARGCHECK_FILE, JSON.stringify({ args, env: process.env }));
  process.exit(0);
}

const emit = process.env.STUB_EMIT ?? "";
const code = Number(process.env.STUB_EXIT ?? 0);
const preMs = Number(process.env.STUB_PRE_MS ?? 0);
const holdMs = Number(process.env.STUB_HOLD_MS ?? 0);
setTimeout(() => {
  if (emit) process.stdout.write(emit + "\n");
  setTimeout(() => process.exit(code), holdMs);
}, preMs);