import { expect, test } from "bun:test"
import { createMemo, createRoot, createSignal, mapArray } from "solid-js"

const reorder = <T extends { id: string }>(all: readonly T[], order: readonly string[]) => {
  const byId = new Map(all.map((a) => [a.id, a]))
  const out: T[] = []
  for (const id of order) { const a = byId.get(id); if (a) { out.push(a); byId.delete(id) } }
  for (const a of all) if (byId.has(a.id)) out.push(a)
  return out
}

test("a reorder remounts every tile", () => {
  createRoot((dispose) => {
    const builtins = () => ["contacts", "notes", "files"].map((id) => ({ id, title: id }))
    const [order, setOrder] = createSignal<string[]>([])
    const apps = createMemo(() => reorder(builtins(), order()))
    const pages = createMemo(() => [apps()])

    let pageMounts = 0
    let tileMounts = 0
    const rendered = createMemo(
      mapArray(pages, (pageApps) => {
        pageMounts += 1
        return createMemo(mapArray(() => pageApps, () => { tileMounts += 1; return 1 }))
      }),
    )
    rendered().forEach((p) => p())
    expect(pageMounts).toBe(1)
    expect(tileMounts).toBe(3)

    setOrder(["notes", "contacts", "files"])
    rendered().forEach((p) => p())

    expect(pageMounts).toBe(2)
    expect(tileMounts).toBe(6)
    dispose()
  })
})

test("stable identities move instead of remounting", () => {
  createRoot((dispose) => {
    const STABLE = ["contacts", "notes", "files"].map((id) => ({ id, title: id }))
    const [order, setOrder] = createSignal<string[]>([])
    const apps = createMemo(() => reorder(STABLE, order()))
    let tileMounts = 0
    const rendered = createMemo(mapArray(apps, () => { tileMounts += 1; return 1 }))
    rendered()
    expect(tileMounts).toBe(3)
    setOrder(["notes", "contacts", "files"])
    rendered()
    expect(tileMounts).toBe(3)
    dispose()
  })
})
