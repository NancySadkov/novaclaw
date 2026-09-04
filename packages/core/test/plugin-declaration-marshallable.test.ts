import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import type { Declaration } from "@novaclaw/plugin/v2/effect"
import type { AgentV2Info } from "@novaclaw/sdk/v2/types"
import { agentHost } from "./plugin/host"
import { testEffect } from "./lib/effect"

/**
 * 🔴 **A plugin's contribution must survive a TRANSPORT, because that is the whole point of it being
 * data.**
 *
 * The registration API is otherwise a mutation callback, and a closure cannot cross a process
 * boundary — which is what forecloses running a plugin host inside a sandbox. `declare` exists so
 * the same contribution can arrive over RPC from a confined process. **That claim is only worth
 * something if something checks it**, so this round-trips a real declaration through JSON and
 * applies the far side, rather than asserting that the shape looks serializable.
 *
 * ⚠️ The negative control is the load-bearing half: the callback form does NOT survive, and if it
 * ever appears to, this file is measuring the wrong thing.
 */
const it = testEffect(AppNodeBuilder.build(AgentV2.node))

/** Exactly the fixture an external plugin uses, so this tests the shipped shape and not a mock. */
const DECLARATION: Declaration<AgentV2Info>[] = [
  { id: "over-the-wire", set: { description: "declared as data", mode: "subagent" } },
]

describe("a plugin declaration is marshallable", () => {
  it.effect("🔴 survives JSON and still applies on the far side", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const host = agentHost(agents)

      // The transport, stood in for by the only thing every transport agrees on.
      const overTheWire = JSON.parse(JSON.stringify(DECLARATION)) as typeof DECLARATION
      expect(overTheWire, "the declaration did not survive encoding").toEqual(DECLARATION)

      yield* host.declare(overTheWire)

      const applied = yield* agents.get(AgentV2.ID.make("over-the-wire"))
      expect(applied).toMatchObject({ description: "declared as data", mode: "subagent" })
    }),
  )

  test("🔴 NEGATIVE CONTROL: the callback form does not survive the same trip", () => {
    // `transform` takes a closure. JSON drops functions entirely — silently, which is worse than
    // failing — so a host on the far side would receive an object with the work missing and no
    // error. This is the concrete reason `declare` had to exist, held as an assertion so that the
    // claim above cannot quietly become untrue.
    const callbackForm = { id: "x", update: (agent: { description?: string }) => (agent.description = "set") }
    const round = JSON.parse(JSON.stringify(callbackForm)) as Record<string, unknown>
    expect(round.update, "a function crossed JSON — this control is no longer testing anything").toBeUndefined()
    expect(Object.keys(round)).toEqual(["id"])
  })

  it.effect("append EXTENDS and set REPLACES, which is why they are separate ops", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const host = agentHost(agents)

      yield* host.declare([{ id: "ops", set: { description: "first" } }])
      yield* host.declare([{ id: "ops", set: { description: "second" } }])
      // `set` replaces: the later declaration wins for a field it names.
      expect(yield* agents.get(AgentV2.ID.make("ops"))).toMatchObject({ description: "second" })

      // A merge that guessed would either drop a contribution or silently grow a list; the two ops
      // exist so the call site says which happened.
      yield* host.declare([{ id: "ops", append: { permissions: [{ action: "read", resource: "*", effect: "allow" }] } }])
      yield* host.declare([{ id: "ops", append: { permissions: [{ action: "edit", resource: "*", effect: "deny" }] } }])
      const both = yield* agents.get(AgentV2.ID.make("ops"))
      expect(both?.permissions?.map((rule) => rule.action)).toEqual(["read", "edit"])
    }),
  )

  it.effect("remove takes precedence, so a malformed declaration cannot half-apply", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const host = agentHost(agents)
      yield* host.declare([{ id: "doomed", set: { description: "here" } }])
      expect(yield* agents.get(AgentV2.ID.make("doomed"))).toBeDefined()

      yield* host.declare([{ id: "doomed", remove: true }])
      expect(yield* agents.get(AgentV2.ID.make("doomed"))).toBeUndefined()
    }),
  )
})
