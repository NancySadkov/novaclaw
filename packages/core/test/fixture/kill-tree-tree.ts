/**
 * Fixture for `test/shell-kill-tree.test.ts` — a two-level process tree, so a kill can be checked
 * for the thing that actually matters: whether the GRANDCHILD died too.
 *
 * Two roles, one file:
 *   `<fixture> <out.json>`  PARENT     — spawns itself with no args (the grandchild), writes
 *                                        `{ parent, grandchild }` pids to <out.json>, then idles.
 *   `<fixture>`             GRANDCHILD — idles.
 *
 * ⚠️ Both SELF-DESTRUCT after 30 s. A process-killing test that fails is exactly the situation in
 * which a leaked process is most likely, and AGENTS.md → Known pitfalls #8 is unambiguous: nothing
 * we start may outlive us. The window is far above the 15 s per-test timeout, so a self-destruct can
 * never make a passing test pass vacuously.
 */
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"

const SELF_DESTRUCT_MS = 30_000

const self = process.argv[1]
const out = process.argv[2]
if (!self) process.exit(2)

const idle = setInterval(() => {}, 1_000)
setTimeout(() => {
  clearInterval(idle)
  process.exit(0)
}, SELF_DESTRUCT_MS)

if (out) {
  // ⚠️ `detached` is LOAD-BEARING, and measured, not assumed (2026-07-28). Bun on Windows puts each
  // spawned child in a job object with kill-on-job-close, so a PLAIN grandchild dies for free the
  // moment its bun parent is terminated — against which a root-only kill and a tree kill are
  // indistinguishable and the test proves nothing. Detaching breaks the job association, the
  // grandchild then survives a root-only kill (which is the leak we are guarding), and `taskkill /t`
  // still reaps it through the parent. On POSIX detaching is the STRICTER case too: the grandchild
  // leads its own process group, so a group-only signal misses it and the ppid walk must find it.
  const grandchild = spawn(process.execPath, [self], { stdio: "ignore", detached: true })
  grandchild.unref()
  writeFileSync(out, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid ?? null }))
}
