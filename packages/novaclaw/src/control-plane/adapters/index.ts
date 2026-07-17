import type { WorkspaceAdapter, WorkspaceAdapterEntry } from "../types"
import { WorktreeAdapter } from "./worktree"

const BUILTIN: Record<string, WorkspaceAdapter> = {
  worktree: WorktreeAdapter,
}

// T2 (entities.md): adapters are scoped by the location's rename-stable `origin` hash.
const state = new Map<string, Map<string, WorkspaceAdapter>>()

export function getAdapter(origin: string, type: string): WorkspaceAdapter {
  const custom = state.get(origin)?.get(type)
  if (custom) return custom

  const builtin = BUILTIN[type]
  if (builtin) return builtin

  throw new Error(`Unknown workspace adapter: ${type}`)
}

export function listAdapters(origin: string): WorkspaceAdapterEntry[] {
  return registeredAdapters(origin).map(([type, adapter]) => ({
    type,
    name: adapter.name,
    description: adapter.description,
  }))
}

export function registeredAdapters(origin: string): [string, WorkspaceAdapter][] {
  const adapters = new Map(Object.entries(BUILTIN))
  for (const [type, adapter] of state.get(origin)?.entries() ?? []) adapters.set(type, adapter)
  return [...adapters.entries()]
}

// Plugins can be loaded per-repo so we need to scope them. If you
// want to install a global one pass the "global" origin.
export function registerAdapter(origin: string, type: string, adapter: WorkspaceAdapter) {
  const adapters = state.get(origin) ?? new Map<string, WorkspaceAdapter>()
  adapters.set(type, adapter)
  state.set(origin, adapters)
}
