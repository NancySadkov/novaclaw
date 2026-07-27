#!/usr/bin/env bun
/**
 * `bun run test` — the everyday test suite. Fast, hermetic, and HANG-PROOF.
 *
 * Philosophy (AGENTS.md → Test-suite hygiene): the suite must stay runnable + green on every dev
 * machine (we are NOT Linux-only) and never freeze, so it gets run on every change. Tests that hung
 * or couldn't run from-source have been DELETED, not hidden — a hanging test is zero coverage plus a
 * liability. What remains here runs cleanly; the failures it still surfaces are tracked in todo.md
 * ("Test-suite hygiene") as cross-platform-hardening work, NOT swept under an ignore list.
 *
 * Bulletproofing: a uniform per-test `--timeout` fails a single stuck test; a per-package WALL-CLOCK
 * kill catches anything a per-test timeout can't (a wedged hook / forked fiber / leaked handle) — so
 * a NEW hang can never freeze the suite. If a package gets wall-clock-killed, that's a new crashed car
 * to find + delete (or a fixture leak to fix), not something to wait on.
 *
 *   bun run test          # core kernel + schemas + LLM + SDK + UI  (fast)
 *   bun run test --full   # + novaclaw, run PER-SUBDIR (see note below)
 *   bun run test --only=core
 *
 * ⚠️ novaclaw is `--full` + per-subdir: its cli/server/instance integration tests each pass alone but
 * HANG when run together in one process (an undisposed InstanceStore/serve handle leak — todo.md).
 * Until that fixture leak is fixed, we run each subdir in its own process so the leak can't accumulate.
 */
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"

import { enforce } from "./lib/heavy-guard"

// Refuse to run alongside a build or another suite, or on a machine already short of memory. Both
// mistakes produce the same thing: a wall-clock kill that looks exactly like a real test failure, plus
// pagefile thrashing that wears the SSD. `--force` overrides; CI is exempt. See lib/heavy-guard.ts.
enforce("the test suite")

const FULL = process.argv.includes("--full")
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length)

const PER_TEST_TIMEOUT_MS = 15_000
const PACKAGE_WALLCLOCK_MS = 150_000 // a HANG backstop, not a normal budget

type Pkg = { name: string; dir: string; args: string[]; fullOnly?: boolean; perSubdir?: boolean }
const PACKAGES: Pkg[] = [
  { name: "schema", dir: "packages/schema", args: [] },
  { name: "protocol", dir: "packages/protocol", args: [] },
  { name: "client", dir: "packages/client", args: [] },
  { name: "sdk-next", dir: "packages/sdk-next", args: ["test/import-boundaries.test.ts"] },
  { name: "httpapi-codegen", dir: "packages/httpapi-codegen", args: [] },
  { name: "effect-drizzle-sqlite", dir: "packages/effect-drizzle-sqlite", args: [] },
  { name: "http-recorder", dir: "packages/http-recorder", args: [] },
  { name: "llm", dir: "packages/llm", args: [] },
  { name: "sdk-js", dir: "packages/sdk/js", args: [] },
  { name: "session-ui", dir: "packages/session-ui", args: ["src"] },
  { name: "ui", dir: "packages/ui", args: ["src"] },
  { name: "core", dir: "packages/core", args: [] },
  { name: "app:unit", dir: "packages/app", args: ["--preload", "./happydom.ts", "./src"] },
  { name: "app:browser", dir: "packages/app", args: ["--conditions=browser", "--preload", "./happydom.ts", "./test-browser"] },
  { name: "novaclaw", dir: "packages/novaclaw", args: [], fullOnly: true, perSubdir: true },
]

const results: { name: string; ok: boolean; ms: number; note: string }[] = []

function run(name: string, dir: string, args: string[]) {
  process.stdout.write(`\n\x1b[1m▶ ${name}\x1b[0m\n`)
  const start = Date.now()
  const proc = spawnSync("bun", ["test", ...args, `--timeout=${PER_TEST_TIMEOUT_MS}`], {
    cwd: dir,
    stdio: "inherit",
    timeout: PACKAGE_WALLCLOCK_MS,
    killSignal: "SIGKILL",
  })
  const ms = Date.now() - start
  const timedOut = proc.signal === "SIGKILL" || (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
  const ok = !timedOut && proc.status === 0
  results.push({ name, ok, ms, note: timedOut ? `WALL-CLOCK KILL at ${PACKAGE_WALLCLOCK_MS / 1000}s (hang)` : ok ? "" : `exit ${proc.status}` })
}

// novaclaw's integration tests must run isolated (see header). Enumerate its test/ subdirs that hold
// test files, plus the handful of top-level test files, and run each as its own process.
function subUnits(dir: string): string[] {
  const root = `${dir}/test`
  const units: string[] = []
  const top: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (readdirSync(`${root}/${entry.name}`, { recursive: true }).some((f) => String(f).endsWith(".test.ts")))
        units.push(`test/${entry.name}/`)
    } else if (entry.name.endsWith(".test.ts")) {
      top.push(`test/${entry.name}`)
    }
  }
  return [...top, ...units]
}

for (const pkg of PACKAGES) {
  if (pkg.fullOnly && !FULL) continue
  if (ONLY && !pkg.name.includes(ONLY)) continue
  if (pkg.perSubdir) {
    for (const unit of subUnits(pkg.dir)) run(`${pkg.name} ${unit}`, pkg.dir, [unit])
  } else {
    run(pkg.name, pkg.dir, pkg.args)
  }
}

const totalMs = results.reduce((a, r) => a + r.ms, 0)
process.stdout.write(`\n\x1b[1m── summary ──\x1b[0m\n`)
for (const r of results) {
  const tag = r.ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"
  process.stdout.write(`  ${tag}  ${r.name.padEnd(30)} ${(r.ms / 1000).toFixed(1)}s  ${r.note}\n`)
}
const failed = results.filter((r) => !r.ok)
process.stdout.write(
  `\n${failed.length ? "\x1b[31m" : "\x1b[32m"}${results.length - failed.length}/${results.length} run units green` +
    `\x1b[0m  ·  ${(totalMs / 1000).toFixed(1)}s wall${FULL ? "  (--full)" : ""}\n`,
)
process.exit(failed.length ? 1 : 0)
