import fs from "node:fs"
import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@novaclaw/core/flag/flag"
import { Global } from "@novaclaw/core/global"
const MINUTE = 60_000
const LIMIT = 2 * 1024 * 1024 * 1024

/**
 * Where a snapshot lands — a sibling of the log directory, deliberately NOT inside it.
 *
 * 🔴 These used to go into `Global.Path.log`, which another module owns: `LogFile`'s retention
 * grammar is `<name>-<stamp>.log(.gz)`, so a `.heapsnapshot` was invisible to both halves of the
 * sweep. It was never deleted by age or by budget, and it was not counted in the total the
 * `TOTAL_BYTES` ceiling is compared against — so an operator who set the flag, forgot, and crossed
 * the 2 GiB trigger once per restart accumulated RSS-sized files forever while the Settings row kept
 * saying the log directory was capped. (A V8 snapshot holds every live string in the process:
 * prompts, model output, transcript text, decrypted credentials. `desktop/src/main/debug-export.ts`
 * already excludes them from the debug export, so the sensitivity was understood on one path and not
 * the other.)
 *
 * ⚠️ The sweep now bounds anything found in the log directory, which is the general fix. Moving out
 * is the other half and it is not redundant: a snapshot is a deliberate artefact an operator asked
 * for, and leaving it somewhere a retention sweep is entitled to delete it would trade a leak for
 * losing the evidence at the next boot. Here it belongs to whoever took it.
 */
export const directory = () => path.join(Global.Path.data, "diagnostics")

/**
 * How many snapshots this directory keeps. Two, because a leak is read as a DIFFERENCE between two
 * heaps and one alone answers nothing.
 */
export const KEEP = 2

/**
 * Delete all but the newest {@link KEEP} snapshots, oldest first.
 *
 * 🔴 **Moving out of the log directory without this would relocate the leak, not close it.** The
 * whole defect was an RSS-sized file in a directory whose owner did not bound it; a `diagnostics`
 * directory with no bound is the same sentence with a different path. Snapshots are the only thing
 * written here, so this module owns the grammar AND the retention — which is precisely the property
 * that was missing before.
 *
 * ⚠️ By COUNT, not by age or bytes. A snapshot is taken deliberately, so "it is three weeks old"
 * is no reason to throw away the only evidence an operator has; "there are four newer ones" is.
 * ⚠️ Never throws — housekeeping must not be able to stop the snapshot it is making room for.
 */
export function prune(home: string, keep = KEEP): void {
  try {
    const found = fs
      .readdirSync(home)
      .filter((entry) => entry.endsWith(".heapsnapshot"))
      .map((entry) => {
        const file = path.join(home, entry)
        try {
          return { file, at: fs.statSync(file).mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter((entry): entry is { file: string; at: number } => entry !== undefined)
      .sort((a, b) => a.at - b.at)
    for (const entry of found.slice(0, Math.max(0, found.length - keep)))
      try {
        fs.rmSync(entry.file, { force: true })
      } catch {
        continue
      }
  } catch {
    /* an unreadable diagnostics directory is not a reason to skip the snapshot */
  }
}

let timer: Timer | undefined
let lock = false
let armed = true

export function start() {
  if (!Flag.NOVACLAW_AUTO_HEAP_SNAPSHOT) return
  if (timer) return

  const run = async () => {
    if (lock) return

    const stat = process.memoryUsage()
    if (stat.rss <= LIMIT) {
      armed = true
      return
    }
    if (!armed) return

    lock = true
    armed = false
    const home = directory()
    const file = path.join(home, `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`)
    await Promise.resolve()
      .then(() => {
        fs.mkdirSync(home, { recursive: true })
        // BEFORE the write, so the room is made rather than the ceiling exceeded and then trimmed:
        // this is the one moment the process is already over 2 GiB of RSS.
        prune(home, KEEP - 1)
        writeHeapSnapshot(file)
      })
      .catch(() => {})

    lock = false
  }

  timer = setInterval(() => {
    void run()
  }, MINUTE)
  timer.unref?.()
}

export * as Heap from "./heap"
