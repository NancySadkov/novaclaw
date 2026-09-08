export * as GraphRegistry from "./graph-registry"

import { Effect, Option, Scope } from "effect"
import { Database } from "../database/database"

// A REGISTRY THAT DOES NOT CROSS AN INSTANCE BOUNDARY.
//
// 🔴 **One process does not hold one instance.** A module-level `Set` of listeners is the opposite
// of an atomic instance: two application graphs built in the same process each add their listener to
// the SAME set, so one graph's announcement fans out to the other's, carrying the other's `db`,
// `events`, `projects` and `store` with it. Measured shape: instance A removing a colleague through
// `POST /api/config/remove` runs instance B's retirement against B's database — B's chats archived,
// B's cabinet set aside, B's schedules deleted.
//
// It also defeats the "did this ship inert?" guards on their own terms: a `registered()` that counts
// a module global answers the UNION across graphs, so a graph that shipped a registration inert
// reports it wired as long as any other graph in the process registered one.
//
// ⚠️ **The key is the graph's `Database` handle**, because that is the one per-graph object every
// announcing and every registering site already holds. `Effect.serviceOption` reads it out of the
// CALLING fiber's context and needs nothing from the caller's types, so the announce sites — which
// are in a store module that must stay free of new service requirements — are unchanged.
//
// ⚠️ **A registration made outside any graph goes to a bucket every reader also sees**, and that is
// deliberate rather than a hole. It is the CLI-and-test case: no `Database` in context means no
// instance to belong to, so there is no boundary to cross. In an instance there is always one — the
// nodes that register all list `Database.node` among their dependencies — so the shared bucket is
// empty wherever the leak would matter. What it must never do is let a GRAPH's registration be seen
// by another graph, and that is the property the tests assert by absence.

/** What identifies a graph: its own `Database` handle. Compared by identity, never by value. */
export type Graph = object

/**
 * The graph the calling fiber belongs to, or `undefined` when it belongs to none.
 *
 * ⚠️ Requirement-free on purpose (`Effect.serviceOption`, not `Effect.service`). Adding
 * `Database.Service` to the announce sites' requirements would push a new dependency into
 * `config-store-write.ts` and every arm that calls it, which is a change to the config door for a
 * fact the fiber already carries.
 */
export const current: Effect.Effect<Graph | undefined> = Effect.map(Effect.serviceOption(Database.Service), (found) =>
  Option.isSome(found) ? (found.value.db as Graph) : undefined,
)

export interface Registry<Entry> {
  /** Add an entry to the CALLING fiber's graph, for the life of the calling scope. */
  readonly register: (entry: Entry) => Effect.Effect<void, never, Scope.Scope>
  /** Everything ONE graph can see. `undefined` asks for the no-graph bucket alone. */
  readonly entries: (graph: Graph | undefined) => readonly Entry[]
  /** Everything the CALLING fiber's graph can see. */
  readonly visible: Effect.Effect<readonly Entry[]>
}

export const make = <Entry>(): Registry<Entry> => {
  // 🔴 Weak on the graph, so a disposed instance's bucket is not a leak. The scoped release below
  // removes each entry anyway; this is the second mechanism, for the graph that dies without one.
  const byGraph = new WeakMap<Graph, Set<Entry>>()
  const unowned = new Set<Entry>()

  const bucket = (graph: Graph | undefined): Set<Entry> => {
    if (graph === undefined) return unowned
    const found = byGraph.get(graph)
    if (found !== undefined) return found
    const fresh = new Set<Entry>()
    byGraph.set(graph, fresh)
    return fresh
  }

  const entries = (graph: Graph | undefined): readonly Entry[] =>
    graph === undefined ? [...unowned] : [...(byGraph.get(graph) ?? []), ...unowned]

  return {
    register: (entry) =>
      Effect.acquireRelease(
        Effect.map(current, (graph) => {
          const set = bucket(graph)
          set.add(entry)
          return { set, entry }
        }),
        ({ set, entry: added }) => Effect.sync(() => void set.delete(added)),
      ).pipe(Effect.asVoid),
    entries,
    visible: Effect.map(current, entries),
  }
}
