import { createRoot, type Owner } from "solid-js"

type Entry = {
  value: unknown
  dispose: VoidFunction
  identity?: string
}

export function createTabMemory(owner: Owner | null) {
  const entries = new Map<string, Map<string, Entry>>()

  const remove = (key: string) => {
    const state = entries.get(key)
    if (!state) return
    for (const entry of state.values()) entry.dispose()
    entries.delete(key)
  }

  return {
    ensure<T>(key: string, name: string, init: () => T, identity?: string) {
      const state = entries.get(key) ?? new Map<string, Entry>()
      if (!entries.has(key)) entries.set(key, state)
      const existing = state.get(name)
      if (existing?.identity === identity && existing) return existing.value as T
      existing?.dispose()
      const entry = createRoot((dispose) => ({ value: init(), dispose, identity }), owner)
      state.set(name, entry)
      return entry.value
    },
    remove,
    dispose() {
      for (const key of entries.keys()) remove(key)
    },
  }
}
