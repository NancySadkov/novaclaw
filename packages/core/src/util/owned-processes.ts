export * as OwnedProcesses from "./owned-processes"

import { killTree, killTreeSync, type KillTreeTarget } from "./kill-tree"

type Entry = {
  readonly target: KillTreeTarget
}

const liveEntries = new Set<Entry>()
let exitHookInstalled = false

/** True once a `ChildProcess` handle is known dead, so a reused pid is never signalled. A raw pid
 *  has no such evidence and is always signalled — the registry only stores handles for that reason. */
const exited = (target: KillTreeTarget): boolean => {
  if (typeof target === "number" || target === null || target === undefined) return false
  const handle = target as { exitCode?: number | null; signalCode?: NodeJS.Signals | null }
  return handle.exitCode !== null || handle.signalCode !== null
}

export function register(target: KillTreeTarget): () => void {
  const entry: Entry = { target }
  liveEntries.add(entry)
  installExitHook()
  let released = false
  return () => {
    if (released) return
    released = true
    liveEntries.delete(entry)
  }
}

export function liveCount(): number {
  return liveEntries.size
}

export async function killAll(): Promise<void> {
  const entries = [...liveEntries]
  await Promise.allSettled(entries.map((entry) => killTree(entry.target, { exited: () => exited(entry.target) })))
}

export function killAllSync(): void {
  for (const entry of [...liveEntries]) killTreeSync(entry.target, { exited: () => exited(entry.target) })
}

export function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", () => killAllSync())
}
