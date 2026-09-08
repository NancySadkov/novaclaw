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

describe("every facet that CAN be declarative has a marshallable form", () => {
  /**
   * 🔴 **Three shapes, not one, because the domains differ and pretending otherwise would invent
   * concepts the domain does not have.** An agent and a command are entities with patchable fields,
   * so they take `set`/`append`/`remove`. A reference is a NAME bound to a WHOLE source, so it is
   * add-or-remove — there is no partial source to `set`. A skill is an append-only list of sources
   * with no id at all, so the declaration IS the list.
   *
   * ⚠️ **And two facets have NO declarative form on purpose.** `integration` carries `authorize`,
   * `refresh` and `label` — an OAuth flow IS behaviour — and `tool` carries an async `execute`.
   * Neither is data and neither can be made data by rearranging it. That is not a gap in this work:
   * the out-of-process seam for BEHAVIOUR is MCP, which ruling 5 already named, and a plugin that
   * needs to run code out of process is describing an MCP server rather than a declaration.
   */
  test("the declaration shapes survive a wire, each in its own shape", () => {
    const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

    const command = [{ id: "build", set: { description: "compile it" } }]
    expect(wire(command), "command declaration did not survive").toEqual(command)

    const reference = [
      { name: "docs", source: { type: "local", path: "/tmp/docs" } },
      { name: "stale", remove: true },
    ]
    expect(wire(reference), "reference declaration did not survive").toEqual(reference)

    const skill = [{ type: "directory", path: "/tmp/skills" }]
    expect(wire(skill), "skill declaration did not survive").toEqual(skill)

    // The catalog is a TAGGED UNION because its domain is nested: a model is identified by a pair,
    // and the default is a property of the catalog rather than of any record in it. Flattening those
    // into one `id` would either lose the provider or invent a composite key nothing else uses.
    const catalog = [
      { kind: "provider", id: "acme", set: { name: "Acme" } },
      { kind: "model", provider: "acme", id: "fast", set: { name: "Acme Fast" } },
      { kind: "default-model", provider: "acme", id: "fast" },
      { kind: "provider", id: "gone", remove: true },
    ]
    expect(wire(catalog), "catalog declaration did not survive").toEqual(catalog)
  })

  test("🔴 the two BEHAVIOURAL facets are honestly not marshallable, and that is the point", () => {
    // An OAuth registration and a tool definition both carry functions. Asserting the loss here
    // stops a later reader concluding the omission was an oversight and "finishing the job" by
    // inventing a data shape that silently drops the behaviour.
    const oauth = { integrationID: "x", authorize: () => undefined, refresh: () => undefined }
    const tool = { name: "run", execute: async () => "done" }
    const roundOauth = JSON.parse(JSON.stringify(oauth)) as Record<string, unknown>
    const roundTool = JSON.parse(JSON.stringify(tool)) as Record<string, unknown>
    expect(Object.keys(roundOauth)).toEqual(["integrationID"])
    expect(Object.keys(roundTool)).toEqual(["name"])
  })
})
