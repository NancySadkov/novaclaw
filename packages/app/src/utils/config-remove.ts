/** Config patches merge. Clearing an override must use the deletion verb and refresh its reader. */
export function createConfigRemover(deps: {
  current: () => unknown
  remove: (paths: string[][]) => Promise<unknown>
  refresh: () => Promise<unknown>
}) {
  return async (paths: string[][]) => {
    const present = paths.filter((path) => {
      let value = deps.current()
      if (!path.length) return false
      for (const key of path) {
        if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return false
        value = (value as Record<string, unknown>)[key]
      }
      return value !== undefined
    })
    if (!present.length) return
    await deps.remove(present)
    await deps.refresh()
  }
}
