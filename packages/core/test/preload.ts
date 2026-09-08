import os from "os"
import path from "path"
import { scrubLauncherEnv } from "./fixture/launcher-env"

/**
 * 🔴 **First, drop the launcher's description of ITS install.** A suite started from inside a running
 * desktop instance inherits `NOVACLAW_W64DEVKIT_PATH`, `NOVACLAW_IMAGEMAGICK_PATH`, `NOVACLAW_CLIENT` and
 * friends, and every one of them makes the code under test answer correctly about a machine instead of
 * about the tree under test — nine `core` tests failed that way on a clean `main` on 2026-09-04. See
 * `fixture/launcher-env.ts` for the four shapes and `test/launcher-env.test.ts` for the ratchet.
 *
 * This runs BEFORE the four lines below on purpose: they are the developer's intent and survive.
 */
scrubLauncherEnv()

process.env.NOVACLAW_DB = ":memory:"
process.env.NOVACLAW_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.NOVACLAW_DISABLE_MODELS_FETCH = "true"

/**
 * 🔴 **Point the whole instance home at a throwaway directory — `NOVACLAW_DB=":memory:"` is NOT enough.**
 *
 * That variable isolates the SQLite database and nothing else. Everything resolved through
 * `Global.Path.*` still landed in the developer's REAL instance home, and at least one subsystem reads
 * it on the hot path: the memory graph opens `join(Global.Path.data, "memory", "graph")`
 * (`kb-graph/memory.ts`), so the session runner's auto-recall pulled the developer's actual saved
 * memories into a test's system prompt.
 *
 * Found 2026-08-05 when a steering claim failed with eleven lines of the owner's personal notes
 * injected into the request under *"Relevant things you remember…"*. Three separate problems, and the
 * first is the one that makes this urgent:
 *
 *  1. **Tests could WRITE to the developer's real memory store.** Post-drain memory extraction runs on
 *     every drain; it happened to return empty here, but nothing about the wiring prevented a write.
 *  2. **Tests were not deterministic** — they depended on whatever happened to be in that store, which
 *     is why a claim that passed all afternoon began failing without any code change.
 *  3. **Test output leaked personal data** into logs and assertion diffs.
 *
 * `NOVACLAW_HOME` is the documented single-knob escape hatch (AGENTS.md pitfall #0): it moves config,
 * data, state and cache together. PID-scoped, matching `test/fixture/tmpdir.ts`, so parallel runs cannot
 * collide and a leftover directory is attributable.
 */
const TEST_HOME_ROOT = path.join(os.tmpdir(), "novaclaw-test-home")
process.env.NOVACLAW_HOME = path.join(TEST_HOME_ROOT, String(process.pid))

/**
 * 🔴 **Reap abandoned homes — PID-scoping without a reap is a LEAK that later poisons a run.**
 *
 * The comment above says the directory is "PID-scoped, matching `test/fixture/tmpdir.ts`". It matched
 * that fixture's NAMING and not the half that makes the naming safe: the fixture reaps siblings whose
 * process is gone, because `bun test` does not run `process.on("exit")` handlers, so a killed run
 * cleans up nothing. Without a reap the directories accumulate, and since Windows recycles PIDs a
 * later run eventually inherits a dead run's home — i.e. a previous run's state, presented as its own.
 *
 * That is not hypothetical. The same shape one directory over
 * (`os.tmpdir()/novaclaw-initiation-<pid>.db`) left **257 abandoned files** by 2026-08-06 and produced
 * a recurring gate failure that read as a content regression in messenger rather than as stale state.
 * See `test/tmpdir-namespace.test.ts`, which now fails on the shape.
 *
 * Keyed on PID liveness, never on age: units run in their own processes, so an age sweep would delete
 * a CONCURRENT run's home. `process.kill(pid, 0)` is the probe — no throw means alive, `ESRCH` means
 * gone, `EPERM` means alive under another account and is left alone. A recycled PID only means one
 * stale home survives a little longer.
 */
try {
  const fs = require("fs") as typeof import("fs")
  for (const entry of fs.readdirSync(TEST_HOME_ROOT)) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    try {
      process.kill(pid, 0)
      continue // still running — not ours to delete
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code === "EPERM") continue
    }
    try {
      fs.rmSync(path.join(TEST_HOME_ROOT, entry), { recursive: true, force: true })
    } catch {
      // Another process may be reaping the same home; losing the race is fine.
    }
  }
} catch {
  // The root may not exist yet on a first run — nothing to reap.
}
