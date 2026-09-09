import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentRemoval } from "@novaclaw/core/agent/removal"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { testEffect } from "./lib/effect"

/**
 * THE REGISTRY BETWEEN THE CONFIG DOOR AND THE RETIREMENT.
 *
 * 🔴 Written because I copied `agent/reassignment.ts`'s shape for `AgentRemoval` — including its
 * `catchCause`-not-`ignore` claim — and did NOT copy its test. Retirement now runs before the
 * identity row is removed: a defect must propagate so a failed worker barrier keeps the officer
 * addressable and the operation retryable.
 *
 * The wiring ledger (`novaclaw/test/agent-removal-wiring.test.ts`) says the product registers a
 * listener. These say what the registry does once it has one.
 */

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

describe("the registry between the config door and the retirement", () => {
  it.effect("announcing with nobody registered is not an error", () =>
    Effect.gen(function* () {
      // A CLI editing config with no instance running has no memory engine to tidy. The next instance
      // to open that store still sees the cabinet — which is why `DELETE /api/agent/:id` remains the
      // door with the guarantee and this is a best-effort courtesy.
      yield* AgentRemoval.announce("theron")
    }),
  )

  it.effect("a registered listener receives the id, and deregisters with its scope", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      // ⚠️ The count is asked of THIS graph. A process-wide one would answer the union across every
      // instance in it, which is the question nobody has.
      const { db } = yield* Database.Service
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* AgentRemoval.register((id) => Effect.sync(() => void seen.push(id)))
          expect(AgentRemoval.registered(db)).toBeGreaterThan(0)
          yield* AgentRemoval.announce("theron")
        }),
      )
      expect(seen).toEqual(["theron"])
      // Out of scope the closure is gone, so a later write cannot fan out into a dead instance.
      yield* AgentRemoval.announce("theron")
      expect(seen).toEqual(["theron"])
    }),
  )

  it.effect("a listener defect propagates and prevents the identity-removal phase", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* AgentRemoval.register(() => Effect.die("retirement exploded"))
          yield* AgentRemoval.register((id) => Effect.sync(() => void seen.push(id)))
          return yield* AgentRemoval.announce("theron").pipe(Effect.exit)
        }),
      )
      expect(result._tag).toBe("Failure")
      expect(seen).toEqual([])
    }),
  )
})
