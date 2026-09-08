import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { AgentReassignment } from "@novaclaw/core/agent/reassignment"
import { AgentRemoval } from "@novaclaw/core/agent/removal"
import { AgentRetire } from "@novaclaw/core/agent/retire"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { testEffect } from "./lib/effect"

/**
 * ONE PROCESS, TWO INSTANCES — AND THE REGISTRIES BETWEEN THEM.
 *
 * 🔴 An instance is ATOMIC, and one process does not hold one of them. The UI and the runtime need
 * not share a process, a peer's runtime can be built beside ours, and officer ids are drawn from a
 * FIXED POOL — so `theron` existing in two instances at once is the normal case rather than the
 * corner one. Three registries were module-level `Set`s, which is the exact opposite of atomic: both
 * graphs added their listener to the same set, and one instance's `announce` ran the OTHER
 * instance's work against the other instance's database. Removing `theron` in A archived B's
 * `theron` chats, set aside B's cabinet, deleted B's schedules and cleared B's default agent.
 *
 * ⚠️ **Every claim below is asserted BY ABSENCE**, because that is the only shape that can see this:
 * a test that checks the announcing instance's own listener ran passes just as happily when both
 * ran. The negative half is the whole test.
 *
 * ⚠️ The second victim was the guard, not the behaviour. `AgentRetire.registered()` exists so that a
 * cleaner nobody wired is REPORTED rather than silently skipped; answering the union across graphs
 * meant a graph that shipped one inert reported it wired as long as any other graph in the process
 * had registered it. That is a guard defeated on its own terms, so it is asserted separately.
 */

/** Two graphs, told apart the way the registries tell them apart: by their `Database` handle. */
const instanceA = { instance: "A" }
const instanceB = { instance: "B" }
const inside = (graph: object) => Effect.provideService(Database.Service, { db: graph } as never)

/** A `db` that answers the built-in retirement steps' chains and returns nothing. */
const stubDb = (identity: object) => {
  const chain = identity as Record<string, unknown>
  for (const method of ["delete", "where", "update", "set", "select", "from", "orderBy", "limit"])
    chain[method] = () => chain
  chain["run"] = () => Effect.void
  chain["all"] = () => Effect.succeed([])
  chain["get"] = () => Effect.succeed(undefined)
  return chain
}

describe("a registry belongs to one instance", () => {
  test("🔴 a removal announced in one instance does not reach the other's listener", async () => {
    const seenA: string[] = []
    const seenB: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* AgentRemoval.register((id) => Effect.sync(() => void seenA.push(id))).pipe(inside(instanceA))
          yield* AgentRemoval.register((id) => Effect.sync(() => void seenB.push(id))).pipe(inside(instanceB))
          expect(AgentRemoval.registered(instanceA)).toBe(1)
          expect(AgentRemoval.registered(instanceB)).toBe(1)
          yield* AgentRemoval.announce("theron").pipe(inside(instanceA))
        }),
      ),
    )
    expect(seenA).toEqual(["theron"])
    // The one that matters: B's listener would have run `AgentRetire.everything` against B's
    // database for a colleague nobody in B removed.
    expect(seenB).toEqual([])
  })

  test("🔴 a reassignment announced in one instance does not deliver into the other's chat", async () => {
    const move = { agentID: "theron", from: "D:/old", to: "D:/ledger", ownScratch: false }
    const seenA: string[] = []
    const seenB: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const toA = (m: { agentID: string }) => Effect.sync(() => void seenA.push(m.agentID))
          const toB = (m: { agentID: string }) => Effect.sync(() => void seenB.push(m.agentID))
          yield* AgentReassignment.register(toA).pipe(inside(instanceA))
          yield* AgentReassignment.register(toB).pipe(inside(instanceB))
          yield* AgentReassignment.announce(move).pipe(inside(instanceA))
        }),
      ),
    )
    expect(seenA).toEqual(["theron"])
    // Delivery ARCHIVES the colleague's chat and opens a successor. Run in B, it would have ended a
    // conversation in an instance where nothing moved.
    expect(seenB).toEqual([])
  })

  test("🔴 a retirement runs its OWN instance's cleaners, and the wiring report answers for one", async () => {
    const dbA = stubDb({ instance: "A/db" })
    const dbB = stubDb({ instance: "B/db" })
    const ran: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* AgentRetire.registerCleaner("schedules", (id) =>
            Effect.sync(() => void ran.push(`A:schedules:${id}`)),
          ).pipe(inside(dbA))
          yield* AgentRetire.registerCleaner("workspace", (id) =>
            Effect.sync(() => void ran.push(`B:workspace:${id}`)),
          ).pipe(inside(dbB))

          // ⚠️ The guard, on its own terms. A union would report BOTH names to both graphs, so a
          // graph that shipped `workspace` inert would be told it was wired.
          expect(AgentRetire.registered(dbA)).toEqual(["schedules"])
          expect(AgentRetire.registered(dbB)).toEqual(["workspace"])

          yield* AgentRetire.everything({
            db: dbA as never,
            events: { publish: () => Effect.void } as never,
            memory: { moveScope: () => Effect.void } as never,
            agent: "wren",
            at: 1,
          })
        }),
      ),
    )
    // A's cleaner ran against A's stores. B's did not run at all — it would have deleted rows for a
    // colleague B still employs.
    expect(ran).toEqual(["A:schedules:wren"])
  })
})

/**
 * THE JOIN, DRIVEN END TO END.
 *
 * 🔴 The scoping above is only correct if the key `announce` reads out of the calling fiber is the
 * SAME object the registering node put its listener under. Nothing in the unit tests can say that:
 * they register and announce in one breath. `ConfigStoreWrite.remove` is the real door, and it
 * announces from inside a transaction, several frames below where `Database.Service` was resolved —
 * which is exactly the shape a keyed registry gets wrong silently. Wrong, this test sees a removal
 * that no longer retires anything, which is the pre-`AgentRemoval` defect coming back.
 */
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      AgentConfigStore.node,
      CatalogStore.node,
      CommandConfigStore.node,
      ReferenceConfigStore.node,
      SettingsConfigStore.node,
      SkillConfigStore.node,
    ]),
  ),
)

describe("the config door reaches its own instance's listener", () => {
  it.effect("🔴 a removal through the real write path still announces to the graph that made it", () =>
    Effect.gen(function* () {
      const retired: string[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          // Registered the way `AgentRemoval.node` registers: inside the graph, with no key passed.
          yield* AgentRemoval.register((id) => Effect.sync(() => void retired.push(id)))
          yield* ConfigStoreWrite.apply(
            Schema.decodeUnknownSync(Config.Info)({
              agents: { reviewer: { description: "r" }, builder: { description: "b" } },
            }),
          )
          yield* ConfigStoreWrite.remove([["agents", "reviewer"]])
        }),
      )
      expect(retired).toEqual(["reviewer"])
    }),
  )
})
