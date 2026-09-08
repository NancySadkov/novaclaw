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
 * `catchCause`-not-`ignore` claim — and did NOT copy its test. That test is what caught the claim
 * being false the first time it was made: `Effect.ignore` discharges the ERROR channel and lets a
 * DEFECT through, so a listener with a null deref in it still propagates out of a config write that
 * has already committed and surfaces as a 500 on a removal that worked.
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

  // 🔴 A DEFECT, not merely a failure — this is the assertion that caught the same claim being wrong
  // in the reassignment module. `Effect.ignore` would let this through and turn a committed removal
  // into a 500.
  it.effect("a listener that DIES does not stop the others, or the write", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* AgentRemoval.register(() => Effect.die("retirement exploded"))
          yield* AgentRemoval.register((id) => Effect.sync(() => void seen.push(id)))
          yield* AgentRemoval.announce("theron")
        }),
      )
      // The surviving listener still ran, and `announce` itself succeeded — the config row is already
      // gone by the time this fires, so failing here would report a removal that worked as broken.
      expect(seen).toEqual(["theron"])
    }),
  )

  // ⚠️ There is deliberately no "a listener that FAILS" case, and the attempt to write one is what
  // established why: `register` takes `(agentID: string) => Effect.Effect<void>`, i.e. an error
  // channel of `never`, so a listener CANNOT fail — the typecheck refuses the cast. Only a DEFECT can
  // escape it, which is exactly why `announce` needs `catchCause` and why `Effect.ignore` is the
  // wrong tool: `ignore` discharges the channel that is already empty and lets through the one that
  // is not.
})
