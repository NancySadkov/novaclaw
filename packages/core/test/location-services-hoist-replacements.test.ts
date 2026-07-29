import { describe, expect, test } from "bun:test"
import { Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Node } from "@novaclaw/core/effect/app-node"
import { EventV2 } from "@novaclaw/core/event"
import { Global } from "@novaclaw/core/global"
import { Offline } from "@novaclaw/core/offline"
import { AppProcess } from "@novaclaw/core/process"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { locationServices } from "@novaclaw/core/location-services"

// WHY THIS FILE EXISTS (2026-07-29).
//
// `LayerNode.hoist` splits the location graph into a per-location half and a shared `global` half,
// and `location-services.ts` compiles the two halves separately. Until 2026-07-29 a hoisted node was
// lifted out BY REFERENCE with its dependency array verbatim, so a caller-supplied replacement
// reached the replaced node itself and the per-location half — and nothing else. On THIS graph that
// meant replacing `Database` still left 16 hoisted globals (every config store, `Event`,
// `Credential`, `SessionStore`, `bash-jobs-recovery`, `WebSearch`, …) wired to the original node:
// a suite's mock and a real second SQLite connection alive in one process, with each service reading
// whichever one it happened to depend on. The generic behaviour is pinned in
// `test/effect/layer-node/layer-node.test.ts`; this file pins it on the REAL graph, because the
// number that made it matter (16) is a property of this graph and not of the algorithm.
//
// The check is structural on purpose — no layer is built and no database is opened. That is sound
// here: `location-services.ts` compiles the hoisted half with no replacements, so which layer each
// hoisted global receives is decided entirely by which node objects its dependency arrays hold.
//
// ⚠️ Every case carries its own NEGATIVE CONTROL in the same assertion pair: with no replacement the
// original node MUST still be found inside another hoisted global's subtree. Without that, a walk
// that silently stopped finding anything — a renamed export, a graph edit, a broken traversal —
// would read as a permanent pass.

type AnyNode = { readonly name: string; readonly dependencies: readonly AnyNode[] }

/** Every node object reachable in the hoisted half, excluding the hoisted roots themselves. */
const insideHoistedSubtrees = (hoisted: AnyNode): ReadonlySet<AnyNode> => {
  const seen = new Set<AnyNode>()
  const stack: AnyNode[] = hoisted.dependencies.flatMap((root) => [...root.dependencies])
  while (stack.length > 0) {
    const item = stack.pop()!
    if (seen.has(item)) continue
    seen.add(item)
    for (const dependency of item.dependencies) stack.push(dependency)
  }
  return seen
}

const holdersOf = (hoisted: AnyNode, source: AnyNode): readonly string[] =>
  hoisted.dependencies.flatMap((root) => {
    const seen = new Set<AnyNode>()
    const stack: AnyNode[] = [...root.dependencies]
    while (stack.length > 0) {
      const item = stack.pop()!
      if (seen.has(item)) continue
      seen.add(item)
      if (item === source) return [root.name]
      for (const dependency of item.dependencies) stack.push(dependency)
    }
    return []
  })

// The layer is never built — only the node identity matters — so an empty layer is enough to make a
// replacement that is a DIFFERENT object from the original node.
const stub = (source: unknown) => [source, Layer.empty] as unknown as LayerNode.Replacement

const hoistWith = (replacements: readonly LayerNode.Replacement[]) =>
  LayerNode.hoist(locationServices, Node.tags.values.global, replacements as never) as unknown as {
    node: AnyNode
    hoisted: AnyNode
  }

// Each of these is `global`-tagged AND depended on by at least one other hoisted global, which is
// what made the leak observable. The counts are the 2026-07-29 measurement; they are asserted as
// "at least one" rather than exactly, so growing the graph is not a false failure.
const SHARED_GLOBALS = [
  { label: "Database (16 holders measured)", source: Database.node },
  { label: "Global (9 holders measured)", source: Global.node },
  { label: "Offline (6 holders measured)", source: Offline.node },
  { label: "AppProcess (4 holders measured)", source: AppProcess.node },
  { label: "SettingsConfigStore (2 holders measured)", source: SettingsConfigStore.node },
  { label: "Event (1 holder measured)", source: EventV2.node },
] as const

describe("location services hoist replacements", () => {
  for (const { label, source } of SHARED_GLOBALS) {
    test(`a replacement for ${label} reaches every hoisted global that depends on it`, () => {
      const control = hoistWith([])
      const holders = holdersOf(control.hoisted, source as unknown as AnyNode)
      // NEGATIVE CONTROL: the walk finds the original where it genuinely is.
      expect(holders.length).toBeGreaterThan(0)

      const replaced = hoistWith([stub(source)])
      expect(holdersOf(replaced.hoisted, source as unknown as AnyNode)).toEqual([])
      expect(insideHoistedSubtrees(replaced.hoisted).has(source as unknown as AnyNode)).toBe(false)
      // The hoisted ROOTS were already correct before the fix; assert they stayed that way.
      // Identity, not `toContain` — a structural comparison would not distinguish a clone.
      expect(replaced.hoisted.dependencies.some((item) => (item as unknown) === source)).toBe(false)
    })
  }

  test("the location half never holds a replaced global either", () => {
    const replaced = hoistWith(SHARED_GLOBALS.map((item) => stub(item.source)))
    const seen = new Set<AnyNode>()
    const stack: AnyNode[] = [replaced.node]
    while (stack.length > 0) {
      const item = stack.pop()!
      if (seen.has(item)) continue
      seen.add(item)
      for (const dependency of item.dependencies) stack.push(dependency)
    }
    for (const { label, source } of SHARED_GLOBALS) {
      expect([label, seen.has(source as unknown as AnyNode)]).toEqual([label, false])
    }
  })

  test("hoisting without replacements returns the original node objects untouched", () => {
    const { hoisted } = hoistWith([])
    // The no-replacement path must stay allocation-free: production boots a location ~every time and
    // the rewrite is skipped entirely when there is nothing to substitute.
    const same = (source: unknown) => hoisted.dependencies.some((item) => (item as unknown) === source)
    expect(same(Database.node)).toBe(true)
    expect(same(Global.node)).toBe(true)
  })
})
