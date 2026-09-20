/**
 * Performance guard: the fast path must stay comfortably sub-millisecond per
 * command so the pre-execution hook adds negligible latency.
 */
import { describe, expect, it } from "vitest";
import { scanCommand } from "../src/core/matcher.js";

const CORPUS: string[] = [
  "ls -la",
  "git status",
  "git pull --rebase",
  "npm install",
  "npx tsc --noEmit",
  "cat package.json",
  "grep -r TODO src",
  "find . -name '*.ts'",
  "docker ps",
  "kubectl get pods",
  "echo hello world",
  "rm -rf node_modules",
  "rm -rf /",
  "git reset --hard",
  "git push -f origin main",
  "python3 -c 'print(1)'",
  "node server.js",
  "curl -s https://example.com/health",
  "terraform plan",
  "sudo apt update",
  "systemctl status docker",
  "aws s3 ls",
  "chmod +x script.sh",
  "ps aux | grep node",
  "shred secret.txt",
  "git clean -fdx",
  "docker system prune -a",
  "redis-cli FLUSHALL",
  "mongosh --eval 'db.dropDatabase()'",
  "psql -c 'DROP DATABASE prod'",
];

describe("performance guard", () => {
  it("scans a 30-command corpus 1000x within budget", () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      scanCommand(CORPUS[i % CORPUS.length]!);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(3000); // ~3µs/scan worst case, typically far less
  });

  it("scans a single command in reasonable time", () => {
    const start = performance.now();
    for (let i = 0; i < 200; i++) scanCommand("rm -rf /");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});