type QueueInput = {
  paused: () => boolean
  bootstrapInstance: (directory: string) => Promise<void> | void
  key?: (directory: string) => string
}

export function createRefreshQueue(input: QueueInput) {
  const queued = new Map<string, string>()
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const key = input.key ?? ((directory: string) => directory)

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const take = (count: number) => {
    if (queued.size === 0) return [] as string[]
    const items: string[] = []
    for (const [id, directory] of queued) {
      queued.delete(id)
      items.push(directory)
      if (items.length >= count) break
    }
    return items
  }

  const schedule = () => {
    if (closed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, 0)
  }

  const push = (directory: string) => {
    if (closed || !directory) return
    queued.set(key(directory), directory)
    if (input.paused()) return
    schedule()
  }

  async function drain() {
    if (closed || running) return
    running = true
    try {
      while (true) {
        if (closed || input.paused()) return
        const dirs = take(2)
        if (dirs.length === 0) return
        await Promise.all(dirs.map((dir) => input.bootstrapInstance(dir)))
        await tick()
      }
    } finally {
      running = false
      // oxlint-disable-next-line no-unsafe-finally -- intentional: early return skips schedule() when paused
      if (closed || input.paused()) return
      if (queued.size) schedule()
    }
  }

  return {
    push,
    clear(directory: string) {
      queued.delete(key(directory))
    },
    dispose() {
      if (closed) return
      closed = true
      queued.clear()
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
