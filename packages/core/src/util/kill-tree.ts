export * as KillTree from "./kill-tree"

/**
 * **THE one process-tree kill in the codebase** (v0.2.0-prep Wave 1, unit C2).
 *
 * ⚠️ Why it exists: a bare `proc.kill()` / `process.kill(pid)` orphans grandchildren, and orphaned
 * children are a machine-killer here — on 2026-07-20 accumulated orphans pinned commit charge at
 * 99.9% of a 68 GB ceiling for 24+ hours and hard-crashed the laptop (AGENTS.md → Known pitfalls #8,
 * "NO ZOMBIES ALLOWED"). Ten separate hand-rolled copies of this had accumulated by 2026-07-28, each
 * with its own hole: one interpolated a pid into an `exec` SHELL STRING, one never awaited the
 * `taskkill` it spawned, several signalled only the process group with no ppid snapshot, several went
 * straight to `SIGKILL` with no grace, and several reached the ROOT only. Every teardown path that
 * owns a child process routes through this module; `test/kill-tree-ledger.test.ts` fails the build if
 * an eleventh copy appears.
 *
 * ⚠️ **Why this is a LEAF module and not part of `shell.ts`.** `shell.ts` reaches `Global`, `offline`
 * and `fs-util` (i.e. the config/service tree), and `src/jh/imports.test.ts` (§0.7.2) exists
 * specifically to keep the jh engine off that tree. The jh verify-gate runner is one of the callers
 * that most needs a correct tree-kill — it kills timed-out agent shell commands — so the canonical
 * kill has to be importable without dragging anything behind it. Everything below depends on
 * `node:` builtins ONLY. Keep it that way: a dependency added here re-opens §0.7.2.
 *
 * `Shell.killTree` / `Shell.killTreeSync` re-export these, so the established call sites keep working.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { readFile, readdir } from "node:fs/promises"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

/** POSIX grace window between the tree's SIGTERM and its SIGKILL (see {@link killTree}). */
export const SIGKILL_TIMEOUT_MS = 200

/** What a tree-kill can be pointed at: a live child handle, a raw pid, or nothing. */
export type KillTreeTarget = ChildProcess | { readonly pid?: number | undefined } | number | undefined | null

export type KillTreeOptions = {
  /** Short-circuit: return true once the process is known dead, so we never signal a reused pid. */
  exited?: () => boolean
}

/** The pid to aim at, or undefined when there is nothing to kill. */
function killTreePid(target: KillTreeTarget): number | undefined {
  const pid = typeof target === "number" ? target : target?.pid
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined
  return pid
}

/** A `ChildProcess` handle, when we were given one (used as the POSIX root-signal fallback). */
function killTreeHandle(target: KillTreeTarget): ChildProcess | undefined {
  if (target === null || target === undefined || typeof target === "number") return undefined
  return typeof (target as ChildProcess).kill === "function" ? (target as ChildProcess) : undefined
}

/** `taskkill /f /t` — the ONLY thing on Windows that reaches grandchildren. Resolves true if it ran. */
function taskkill(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Args are passed as an array, never interpolated into a shell string.
    const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
      stdio: "ignore",
      windowsHide: true,
    })
    // Exit code 128 = "process not found" — already gone, which is success for our purposes. Only a
    // spawn failure (no taskkill on PATH) means the kill did not happen at all.
    killer.once("exit", () => resolve(true))
    killer.once("error", () => resolve(false))
  })
}

/** The synchronous twin of {@link taskkill}, for `process.on("exit")` hooks. True if it ran. */
function taskkillSync(pid: number): boolean {
  // Same argv array, same reason: never a shell string.
  const out = spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], {
    stdio: "ignore",
    windowsHide: true,
  })
  return out.error === undefined
}

/** Signal one pid. Returns false when the target is already gone / not signallable. */
function signalOne(pid: number, signal: NodeJS.Signals, handle?: ChildProcess): boolean {
  try {
    if (handle) return handle.kill(signal)
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/** Signal a POSIX process GROUP. True only when a group led by `pid` existed and was signalled. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    // A group's id IS its leader's pid, so `-pid` can only ever reach a group led by our target —
    // it can never fan out to unrelated processes.
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

/** Field 3 of `/proc/<pid>/stat` is the comm, wrapped in parens and free to contain spaces AND
 *  parens — so parse from the LAST ')' rather than splitting the whole line. */
function ppidFromStat(stat: string): number | undefined {
  const close = stat.lastIndexOf(")")
  if (close < 0) return undefined
  const ppid = Number(
    stat
      .slice(close + 1)
      .trim()
      .split(/\s+/)[1],
  )
  return Number.isInteger(ppid) ? ppid : undefined
}

/** Parse `ps -A -o pid=,ppid=` output into the snapshot map. */
function parsePs(text: string, into: Map<number, number>): Map<number, number> {
  for (const line of text.split("\n")) {
    const [first, second] = line.trim().split(/\s+/)
    const pid = Number(first)
    const ppid = Number(second)
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid)) into.set(pid, ppid)
  }
  return into
}

/**
 * `pid -> ppid` for every process on the box.
 *
 * Linux reads `/proc` directly (no spawn — this runs inside teardown finalizers); every other POSIX
 * shells out to `ps` exactly ONCE, never a per-node `pgrep -P` BFS.
 */
async function parentMap(): Promise<Map<number, number>> {
  const map = new Map<number, number>()
  if (existsSync("/proc/self/stat")) {
    const entries = await readdir("/proc").catch(() => [] as string[])
    await Promise.all(
      entries.map(async (entry) => {
        const pid = Number(entry)
        if (!Number.isInteger(pid) || pid <= 0) return
        const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
        const ppid = ppidFromStat(stat)
        if (ppid !== undefined) map.set(pid, ppid)
      }),
    )
    if (map.size) return map
  }
  const text = await new Promise<string>((resolve) => {
    let out = ""
    const ps = spawn("ps", ["-A", "-o", "pid=,ppid="], { stdio: ["ignore", "pipe", "ignore"] })
    ps.stdout?.on("data", (chunk) => {
      out += String(chunk)
    })
    ps.once("error", () => resolve(""))
    ps.once("close", () => resolve(out))
  })
  return parsePs(text, map)
}

/** The synchronous twin of {@link parentMap}, for `process.on("exit")` hooks. */
function parentMapSync(): Map<number, number> {
  const map = new Map<number, number>()
  if (existsSync("/proc/self/stat")) {
    let entries: string[] = []
    try {
      entries = readdirSync("/proc")
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const pid = Number(entry)
      if (!Number.isInteger(pid) || pid <= 0) continue
      let stat = ""
      try {
        stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      } catch {
        continue
      }
      const ppid = ppidFromStat(stat)
      if (ppid !== undefined) map.set(pid, ppid)
    }
    if (map.size) return map
  }
  const out = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
  return parsePs(out.stdout ?? "", map)
}

/**
 * Every descendant of `pid`, DEEPEST FIRST, from a `pid -> ppid` snapshot.
 *
 * Exported for testing: the snapshot source is platform-specific, this walk is not. Cycle-guarded —
 * a corrupt or racing snapshot must not spin — and `pid` itself is never in the result.
 */
export function descendantsOf(pid: number, parents: ReadonlyMap<number, number>): number[] {
  const children = new Map<number, number[]>()
  for (const [child, parent] of parents) {
    const list = children.get(parent)
    if (list) list.push(child)
    else children.set(parent, [child])
  }
  const seen = new Set<number>([pid])
  const out: number[] = []
  const walk = (root: number) => {
    for (const child of children.get(root) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      walk(child)
      out.push(child)
    }
  }
  walk(pid)
  return out
}

/**
 * Kill a process AND everything it spawned. **Prefer this over every other kill.**
 *
 * Accepts a **pid** as readily as a `ChildProcess`, because several owners (the MCP stdio transport,
 * for one) only ever have the pid. Given a handle we additionally use it as the POSIX fallback, which
 * tolerates an already-exited child where a raw `process.kill` would throw.
 *
 * - **win32:** `taskkill /pid <pid> /f /t`, AWAITED, as an argv ARRAY. `/t` is the tree; without it
 *   grandchildren survive. Never a shell string — a pid is a number today, but the shape is the bug.
 * - **POSIX:** `SIGTERM`, a {@link SIGKILL_TIMEOUT_MS} grace window, then `SIGKILL` — sent to the
 *   process GROUP *and* to an explicit ppid snapshot of the tree. Both, because neither is complete:
 *   the group is empty unless the child was spawned `detached` (the MCP SDK does NOT — its stdio
 *   children share our own group, so `kill(-pid)` cannot be used at all), while the snapshot cannot
 *   see anything spawned after it was taken.
 *
 * Never throws, never rejects — teardown callers can `await` it unguarded.
 */
export async function killTree(target: KillTreeTarget, opts?: KillTreeOptions): Promise<void> {
  const pid = killTreePid(target)
  if (pid === undefined || opts?.exited?.()) return
  const handle = killTreeHandle(target)

  if (process.platform === "win32") {
    if (await taskkill(pid)) return
    // No taskkill on PATH. The handle kill reaches the ROOT only — a documented degraded path, not a
    // silent one: it can only be reached when spawning taskkill itself failed.
    if (!opts?.exited?.()) signalOne(pid, "SIGTERM", handle)
    return
  }

  // Snapshot the tree ONCE, up front: after the first signal round the ppid links are gone, so a
  // second lookup would find nothing left to SIGKILL.
  const tree = [...descendantsOf(pid, await parentMap()), pid]
  if (opts?.exited?.()) return

  // BOTH levers every round, because neither alone is complete: the group misses a descendant that
  // detached into a group of its own, and the ppid snapshot misses anything spawned after it was
  // taken (which the group still covers).
  const round = (signal: NodeJS.Signals) => {
    signalGroup(pid, signal)
    for (const each of tree) signalOne(each, signal, each === pid ? handle : undefined)
  }

  round("SIGTERM")
  await sleep(SIGKILL_TIMEOUT_MS)
  if (opts?.exited?.()) return
  round("SIGKILL")
}

/**
 * {@link killTree} for a context that CANNOT await: a `process.on("exit")` hook, an Effect
 * finalizer written as `Effect.sync`, a signal handler that calls `process.exit` on the next line.
 *
 * ⚠️ **Use the async {@link killTree} wherever you can await.** The difference is honest and
 * one-directional: a synchronous context cannot wait, so there is **no SIGTERM grace window** on
 * POSIX — the tree gets SIGTERM and then SIGKILL back to back, i.e. nothing downstream gets to run a
 * cleanup handler. The win32 leg is identical to the async one apart from being `spawnSync`, which is
 * exactly why it is needed: an async `taskkill` spawned from an `exit` hook is not guaranteed to
 * outlive the process that spawned it, so an "await-less await" there would silently kill nothing.
 *
 * Never throws.
 */
export function killTreeSync(target: KillTreeTarget, opts?: KillTreeOptions): void {
  const pid = killTreePid(target)
  if (pid === undefined || opts?.exited?.()) return
  const handle = killTreeHandle(target)

  if (process.platform === "win32") {
    if (taskkillSync(pid)) return
    if (!opts?.exited?.()) signalOne(pid, "SIGTERM", handle)
    return
  }

  const tree = [...descendantsOf(pid, parentMapSync()), pid]
  const round = (signal: NodeJS.Signals) => {
    signalGroup(pid, signal)
    for (const each of tree) signalOne(each, signal, each === pid ? handle : undefined)
  }
  round("SIGTERM")
  round("SIGKILL")
}
