import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { ProviderV2 } from "@novaclaw/core/provider"
import { SessionComponentRegistry } from "@novaclaw/core/session/component-registry"
import { SessionComponentTier } from "@novaclaw/core/session/component-tier"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable } from "@novaclaw/core/session/sql"

/**
 * The five config fields that had no component kind until 2026-08-13.
 *
 * Each needed a decision about its VALUE rather than a projection, and two of those decisions are
 * security rulings that no type can express — so they are asserted here, from the outside, exactly
 * as an agent would hit them.
 */

let sequence = 0

const withRegistry = <A, E, R>(
  body: (input: {
    readonly registry: SessionComponentRegistry.Interface
    readonly sessionID: SessionSchema.ID
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make(`ses_component_kind_${++sequence}`)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          slug: String(sessionID),
          directory: process.cwd(),
          title: "component kinds",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      return yield* body({ registry: yield* SessionComponentRegistry.Service, sessionID })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            SessionComponentRegistry.node,
            SessionProjector.node,
            CatalogStore.node,
            Database.node,
            EventV2.node,
          ]),
        ),
      ),
      Effect.scoped,
    ) as Effect.Effect<A>,
  )

describe("the five fields that were not components", () => {
  test("all five are compiled kinds with a tier", () => {
    for (const kind of ["model", "agent", "session_type", "responder", "strict"] as const) {
      expect(SessionComponentRegistry.KERNEL_KIND_NAMES, `${kind} is not a compiled kind`).toContain(kind)
      expect(SessionComponentTier.KERNEL_KIND_TIERS[kind], `${kind} has no write tier`).toBeDefined()
      expect(SessionComponentTier.CROSS_READ_KIND_TIERS[kind], `${kind} has no cross-read tier`).toBeDefined()
    }
  })

  test("🔴 an agent cannot write its own session type", async () => {
    // Attendance derives from the chain ROOT's type. An agent that could set `interactive` would
    // declare itself attended and step out of the unattended confinement stance — out-of-folder
    // writes go back to being asked (of nobody), and bash stops being confined. This is the whole
    // reason the kind is exposed read-only rather than not at all.
    const failure = await withRegistry(({ registry, sessionID }) =>
      registry.put({ sessionID, kind: "session_type", value: "interactive" }).pipe(Effect.flip),
    )
    expect(String((failure as { message?: string }).message)).toMatch(/set by the person driving the chat/)

    // The negative control: the SAME write with kernel authority lands, so the refusal above is the
    // ruling and not a broken projection.
    const written = await withRegistry(({ registry, sessionID }) =>
      registry.put({ sessionID, kind: "session_type", value: "goal-oriented", system: true }),
    )
    expect(written.value).toBe("goal-oriented")
  })

  test("🔴 an agent may hand control to a human, and may not take it back", async () => {
    const standDown = await withRegistry(({ registry, sessionID }) =>
      registry.put({ sessionID, kind: "responder", value: "operator" }),
    )
    expect(standDown.value).toBe("operator")

    const takeBack = await withRegistry(({ registry, sessionID }) =>
      registry.put({ sessionID, kind: "responder", value: "nova" }).pipe(Effect.flip),
    )
    expect(String((takeBack as { message?: string }).message)).toMatch(/only a person hands it back/)
  })

  test("a model that this instance cannot serve is refused at the WRITE", async () => {
    // "Resolves through the catalog" used to be the reason this field had no kind. It is now a
    // property of the component: an unservable ref fails here, where the caller can connect it to
    // what they did, instead of at the next turn as a provider error.
    const failure = await withRegistry(({ registry, sessionID }) =>
      registry
        .put({ sessionID, kind: "model", value: { providerID: "nowhere", id: "no-such-model" } })
        .pipe(Effect.flip),
    )
    expect(String((failure as { message?: string }).message)).toMatch(/catalog/)
  })

  test("a model the catalog carries is accepted", async () => {
    // The other half. Without it the test above would pass just as well against a validator that
    // refuses everything — including every legitimate switch.
    const written = await withRegistry(({ registry, sessionID }) =>
      Effect.gen(function* () {
        const catalog = yield* CatalogStore.Service
        yield* catalog.setLayers(ProviderV2.ID.make("local"), [
          { id: "local", models: { "tiny-1": {} } } as never,
        ])
        return yield* registry.put({ sessionID, kind: "model", value: { providerID: "local", id: "tiny-1" } })
      }),
    )
    expect(written.value).toEqual({ providerID: "local", id: "tiny-1" })
  })

  test("`strict` clears back to inherit; `model` cannot", async () => {
    // ⚠️ The asymmetry is mechanical, not a policy: `StrictSwitched` carries a nullable value and
    // `ModelSwitched` does not, so the kernel has no event meaning "go back to inheriting" for the
    // other four. Asserted rather than commented, so widening those events shows up here.
    const cleared = await withRegistry(({ registry, sessionID }) =>
      Effect.gen(function* () {
        yield* registry.put({ sessionID, kind: "strict", value: { enabled: true } })
        return yield* registry.remove({ sessionID, kind: "strict" })
      }),
    )
    expect(cleared).toBe(true)

    const refused = await withRegistry(({ registry, sessionID }) =>
      registry.remove({ sessionID, kind: "model" }).pipe(Effect.flip),
    )
    expect(String((refused as { message?: string }).message)).toMatch(/cannot be removed/)
  })
})
