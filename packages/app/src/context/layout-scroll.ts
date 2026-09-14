import { createStore, produce } from "solid-js/store"

export type SessionScroll = {
  x: number
  y: number
  anchor?: { file: string; offset: number }
  messageAnchor?: { id: string; offset: number }
}

type ScrollMap = Record<string, SessionScroll>

type Options = {
  debounceMs?: number
  getSnapshot: (sessionKey: string) => ScrollMap | undefined
  onFlush: (sessionKey: string, scroll: ScrollMap) => void
}

export function createScrollPersistence(opts: Options) {
  const wait = opts.debounceMs ?? 200
  const [cache, setCache] = createStore<Record<string, ScrollMap>>({})
  const dirty = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function clone(input?: ScrollMap) {
    const out: ScrollMap = {}
    if (!input) return out

    for (const key of Object.keys(input)) {
      const pos = input[key]
      if (!pos) continue
      out[key] = {
        x: pos.x,
        y: pos.y,
        ...(pos.anchor ? { anchor: { ...pos.anchor } } : {}),
        ...(pos.messageAnchor ? { messageAnchor: { ...pos.messageAnchor } } : {}),
      }
    }

    return out
  }

  function seed(sessionKey: string) {
    // A dirty cache is already newer than its persisted snapshot. In particular, an intentionally
    // empty map means a position was cleared; reseeding it here would resurrect the stale value
    // before the debounced flush can commit the deletion.
    if (dirty.has(sessionKey)) return
    const next = clone(opts.getSnapshot(sessionKey))
    const current = cache[sessionKey]
    if (!current) {
      setCache(sessionKey, next)
      return
    }

    if (Object.keys(current).length > 0) return
    if (Object.keys(next).length === 0) return
    setCache(sessionKey, next)
  }

  function scroll(sessionKey: string, tab: string) {
    seed(sessionKey)
    if (dirty.has(sessionKey)) return cache[sessionKey]?.[tab]
    return cache[sessionKey]?.[tab] ?? opts.getSnapshot(sessionKey)?.[tab]
  }

  function schedule(sessionKey: string) {
    const prev = timers.get(sessionKey)
    if (prev) clearTimeout(prev)
    timers.set(
      sessionKey,
      setTimeout(() => flush(sessionKey), wait),
    )
  }

  function setScroll(sessionKey: string, tab: string, pos: SessionScroll) {
    seed(sessionKey)

    const prev = cache[sessionKey]?.[tab]
    if (
      prev?.x === pos.x &&
      prev?.y === pos.y &&
      prev?.anchor?.file === pos.anchor?.file &&
      prev?.anchor?.offset === pos.anchor?.offset &&
      prev?.messageAnchor?.id === pos.messageAnchor?.id &&
      prev?.messageAnchor?.offset === pos.messageAnchor?.offset
    )
      return

    setCache(sessionKey, tab, {
      x: pos.x,
      y: pos.y,
      ...(pos.anchor ? { anchor: { ...pos.anchor } } : {}),
      ...(pos.messageAnchor ? { messageAnchor: { ...pos.messageAnchor } } : {}),
    })
    dirty.add(sessionKey)
    schedule(sessionKey)
  }

  function clearScroll(sessionKey: string, tab: string) {
    seed(sessionKey)
    if (!cache[sessionKey]?.[tab] && !opts.getSnapshot(sessionKey)?.[tab]) return

    setCache(
      produce((draft) => {
        const scroll = draft[sessionKey]
        if (scroll) delete scroll[tab]
      }),
    )
    dirty.add(sessionKey)
    schedule(sessionKey)
  }

  function flush(sessionKey: string) {
    const timer = timers.get(sessionKey)
    if (timer) clearTimeout(timer)
    timers.delete(sessionKey)

    if (!dirty.has(sessionKey)) return
    dirty.delete(sessionKey)

    opts.onFlush(sessionKey, clone(cache[sessionKey]))
  }

  function flushAll() {
    const keys = Array.from(dirty)
    if (keys.length === 0) return

    for (const key of keys) {
      flush(key)
    }
  }

  function drop(keys: string[]) {
    if (keys.length === 0) return

    for (const key of keys) {
      const timer = timers.get(key)
      if (timer) clearTimeout(timer)
      timers.delete(key)
      dirty.delete(key)
    }

    setCache(
      produce((draft) => {
        for (const key of keys) {
          delete draft[key]
        }
      }),
    )
  }

  function dispose() {
    drop(Array.from(timers.keys()))
  }

  return {
    cache,
    clearScroll,
    drop,
    flush,
    flushAll,
    scroll,
    seed,
    setScroll,
    dispose,
  }
}
