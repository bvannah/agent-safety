#!/usr/bin/env node
// Fake `pi` reviewer binary for tests. Emits a configurable JSONL `message_end`
// event (default: nothing) after an optional sleep, then exits with
// STUB_EXIT. Exits 3 immediately when no prompt argument is passed, so the
// test suite catches a regression that drops the reviewer's `-p` user prompt.
const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("stub-reviewer: no prompt argument passed");
  process.exit(3);
}
const emit = process.env.STUB_EMIT ?? "";
const code = Number(process.env.STUB_EXIT ?? 0);
const sleepMs = Number(process.env.STUB_SLEEP_MS ?? 0);
setTimeout(() => {
  if (emit) process.stdout.write(emit + "\n");
  process.exit(code);
}, sleepMs);