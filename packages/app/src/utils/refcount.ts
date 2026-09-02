import { getOwner, onCleanup } from "solid-js"

export function createRefCountMap<T>(
  create: (key: string) => T,
  remove?: (key: string) => void,
  identity: (key: string) => string = (key) => key,
) {
  const items = new Map<string, T>()
  const refCounts = new Map<string, number>()

  return (key: string) => {
    const id = identity(key)
    // 🔴 The release is registered with `onCleanup`, which WARNS and no-ops outside an owner — so an
    // ownerless caller took a reference nothing could ever give back, invisibly: nothing threw, and
    // the real consumer's unmount then decremented to N instead of 0, so `remove` never ran at all.
    // Refusing loudly is the only way this call cannot be written wrong; a caller with no owner must
    // wrap in `withTransientOwner` (@/utils/transient-owner).
    if (!getOwner())
      throw new Error(`createRefCountMap: "${id}" acquired with no owner — wrap the call in withTransientOwner`)
    onCleanup(() => {
      refCounts.set(id, (refCounts.get(id) ?? 0) - 1)
      if (refCounts.get(id) === 0) {
        remove?.(id)
        items.delete(id)
        refCounts.delete(id)
      }
    })

    const cached = items.get(id)
    if (cached) {
      refCounts.set(id, (refCounts.get(id) ?? 0) + 1)
      return cached
    }
    const item = create(key)
    items.set(id, item)
    refCounts.set(id, 1)
    return item
  }
}
