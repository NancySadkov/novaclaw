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
        yield* catalog.setLayers(ProviderV2.ID.make("local"), [{ id: "local", models: { "tiny-1": {} } } as never])
        return yield* registry.put({ sessionID, kind: "model", value: { providerID: "local", id: "tiny-1" } })
      }),
    )
    expect(written.value).toEqual({ providerID: "local", id: "tiny-1" })
  })

  test("ordinary switchable config clears back to inherit", async () => {
    // The asymmetry this used to pin is GONE (2026-08-14): four of the five events carried non-null
    // values, so the kernel had no way to say "go back to inheriting" and a sparse-override column
    // could never return to sparse. Widening them was the ECS lens applied to its own kernel.
    const cleared = await withRegistry(({ registry, sessionID }) =>
      Effect.gen(function* () {
        const catalog = yield* CatalogStore.Service
        yield* catalog.setLayers(ProviderV2.ID.make("local"), [{ id: "local", models: { "tiny-1": {} } } as never])
        yield* registry.put({ sessionID, kind: "strict", value: { enabled: true } })
        yield* registry.put({ sessionID, kind: "model", value: { providerID: "local", id: "tiny-1" } })
        return {
          strict: yield* registry.remove({ sessionID, kind: "strict" }),
          model: yield* registry.remove({ sessionID, kind: "model" }),
        }
      }),
    )
    expect(cleared).toEqual({ strict: true, model: true })
  })

  test("🔴 agent identity is host-owned and a root owner cannot be removed", async () => {
    const result = await withRegistry(({ registry, sessionID }) =>
      Effect.gen(function* () {
        // The sanctioned host side can assign identity. The model-facing component tool cannot set
        // `system`, so both ordinary doors below exercise the authority an agent actually has.
        yield* registry.put({ sessionID, kind: "agent", value: "officer", system: true })
        const write = yield* registry.put({ sessionID, kind: "agent", value: "nova" }).pipe(Effect.flip)
        const remove = yield* registry.remove({ sessionID, kind: "agent" }).pipe(Effect.flip)
        // Root ownership is a data invariant as well as an agent boundary: even kernel authority
        // must use the typed host transition rather than erasing the owner through this projection.
        const systemRemove = yield* registry.remove({ sessionID, kind: "agent", system: true }).pipe(Effect.flip)
        return {
          write,
          remove,
          systemRemove,
          current: yield* registry.get({ sessionID, kind: "agent" }),
        }
      }),
    )

    expect(String((result.write as { message?: string }).message)).toMatch(/assigned by the host/)
    expect(String((result.remove as { message?: string }).message)).toMatch(/assigned by the host/)
    expect(String((result.systemRemove as { message?: string }).message)).toMatch(/root session must keep/i)
    expect(result.current?.value).toBe("officer")
  })

  test("🔴 the system-only and one-way rulings hold on the REMOVAL door too", async () => {
    // The hazard the widening created: `session_type` and `responder` refuse an agent's WRITE, and
    // removal reaches the same end by falling back to the inherited default — an agent clearing
    // `responder` takes control back from the human who took over, and clearing `session_type`
    // drops an unattended root's confinement. A gate on one door only is not a gate.
    const refusals = await withRegistry(({ registry, sessionID }) =>
      Effect.gen(function* () {
        yield* registry.put({ sessionID, kind: "session_type", value: "interactive", system: true })
        yield* registry.put({ sessionID, kind: "responder", value: "operator" })
        return {
          type: yield* registry.remove({ sessionID, kind: "session_type" }).pipe(Effect.flip),
          responder: yield* registry.remove({ sessionID, kind: "responder" }).pipe(Effect.flip),
        }
      }),
    )
    expect(String((refusals.type as { message?: string }).message)).toMatch(/person driving the chat/)
    expect(String((refusals.responder as { message?: string }).message)).toMatch(/only a person hands it back/)

    // And the other half: the system CAN clear both, or the gate would be a permanent lock rather
    // than an authority check.
    const allowed = await withRegistry(({ registry, sessionID }) =>
      Effect.gen(function* () {
        yield* registry.put({ sessionID, kind: "responder", value: "operator" })
        return yield* registry.remove({ sessionID, kind: "responder", system: true })
      }),
    )
    expect(allowed).toBe(true)
  })
})
