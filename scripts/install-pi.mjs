#!/usr/bin/env node
/**
 * Install the agent-safety guard as a Pi extension.
 *
 * Copies the guard sources into `~/.pi/agent/extensions/agent-safety/` with
 * `index.ts` as the entry (Pi auto-discovery: a sub-directory under the
 * extensions folder exposing an `index.ts`).
 *
 * The installed bundle is fully dependency-free at runtime (only Node built-ins
 * + type-only imports of the pi package), so no `npm install` is required.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const FILES = [
  "src/adapters/pi.ts",
  "src/core/matcher.ts",
  "src/core/patterns-helpers.ts",
  "src/core/rules.ts",
  "src/core/settings.ts",
  "src/core/types.ts",
  "src/subagent/pi-reviewer.ts",
];

const entry = "src/adapters/pi.ts";
const targetRoot = join(homedir(), ".pi", "agent", "extensions", "agent-safety");

console.log(`Installing agent-safety → ${targetRoot}`);

rmSync(targetRoot, { recursive: true, force: true });
mkdirSync(targetRoot, { recursive: true });

for (const file of FILES) {
  const src = join(repoRoot, file);
  const isEntry = file === entry;
  const dest = isEntry ? join(targetRoot, "index.ts") : join(targetRoot, file.replace("src/", ""));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  if (isEntry) {
    // `index.ts` flattens the adapter into the extension root, so its
    // `../core/…` and `../subagent/…` imports must become `./…`.
    const rewritten = readFileSync(dest, "utf8")
      .replaceAll('"../core/', '"./core/')
      .replaceAll('"../subagent/', '"./subagent/');
    writeFileSync(dest, rewritten);
  }
  console.log(`  • ${relative(repoRoot, src)} → ${relative(targetRoot, dest)}`);
}

// subagent/pi-reviewer.ts sits one level deeper, so it also needs `../core` fixed.
const reviewerPath = join(targetRoot, "subagent", "pi-reviewer.ts");
writeFileSync(
  reviewerPath,
  readFileSync(reviewerPath, "utf8").replaceAll('"../core/', '"./core/'),
);

const EXT_PACKAGE = {
  name: "agent-safety",
  version: "0.1.0",
  private: true,
  type: "module",
  description: "Blocked / reviewed dangerous commands for the Pi coding agent",
};
writeFileSync(join(targetRoot, "package.json"), JSON.stringify(EXT_PACKAGE, null, 2) + "\n");
console.log("  • package.json");

const globalSafety = join(homedir(), ".pi", "agent", "safety.json");
if (!existsSync(globalSafety)) {
  writeFileSync(
    globalSafety,
    JSON.stringify(
      {
        enabled: true,
        blockCritical: true,
        useSubagent: true,
        subagentTimeoutMs: 30000,
        maxSubagentReviewsPerSession: 20,
        reviewCacheTtlMs: 600000,
        logFile: null,
        overrides: {},
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`  • created default config ${globalSafety}`);
} else {
  console.log(`  • existing config kept: ${globalSafety}`);
  try {
    const parsed = JSON.parse(readFileSync(globalSafety, "utf8"));
    console.log(`    current settings: ${Object.keys(parsed).join(", ") || "(empty)"}`);
  } catch {
    console.warn("    ⚠  config is not valid JSON — the guard will use defaults");
  }
}

console.log("\nDone. Restart Pi or run /reload to load the guard.");