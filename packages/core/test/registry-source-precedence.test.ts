import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { ApplicationTools } from "@novaclaw/core/tool/application-tools"
import { ExternalToolSource } from "@novaclaw/core/tool/external-tool-source"
import { ToolPolicyGate } from "@novaclaw/core/tool-policy-gate"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { Tool } from "@novaclaw/core/tool/tool"
import { bypassedPolicyGate, settleTool } from "./lib/tool"
import { testEffect } from "./lib/effect"

/**
 * ONE NAME, TWO SOURCES — the registry must resolve it the same way everywhere.
 *
 * The registry learns tools from three places and each of `settleRaw`, `catalogue` and
 * `materialize` merges them separately. Until 2026-08-19 they did not agree: `settleRaw` resolved
 * `local ?? application ?? external`, while the two advertising sites looped applications first and
 * let external OVERWRITE them.
 *
 * 🔴 **The consequence was total, not partial.** `settleRaw` rejects a call whose resolved
 * registration is not the advertised one (`registration.identity !== advertised`) — the stale-call
 * guard. So for any colliding name the model was advertised the external tool, the call resolved to
 * the application tool, the identities differed, and the call answered **`Stale tool call` every
 * single time**. Neither tool was reachable: not the one that was advertised, and not the one that
 * won. A collision did not pick a winner, it produced a dead name.
 *
 * The precedence itself is a TRUST ordering and is asserted here as such: an external tool comes
 * from an MCP server or a plugin, so letting it win would let a remote party shadow a first-party
 * application tool — the model told it is calling the OS's own tool while reaching someone else's
 * code.
 */

const COLLIDING = "shared_name"

const echo = (answer: string) =>
  Tool.make({
    description: `Answers ${answer}`,
    input: Schema.Struct({}),
    output: Schema.Struct({ answer: Schema.String }),
    execute: () => Effect.succeed({ answer }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.answer }],
  })

/** An `ExternalToolSource` holding one tool under `COLLIDING`, standing in for an MCP server. */
const externalWith = (tool: Tool.AnyTool) =>
  Layer.succeed(
    ExternalToolSource.Service,
    ExternalToolSource.Service.of({
      entries: () => Effect.succeed(new Map([[COLLIDING, { identity: { external: true }, tool }]])),
    }),
  )

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ApplicationTools.node, ExternalToolSource.node, ToolRegistry.node, ToolRegistry.toolsNode]),
    [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [ToolPolicyGate.node, bypassedPolicyGate],
      [ExternalToolSource.node, externalWith(echo("from-external"))],
    ],
  ),
)

const sessionID = SessionV2.ID.make("ses_precedence")
const agent = AgentV2.ID.make("build")
const assistantMessageID = SessionMessage.ID.make("msg_precedence")

describe("a name registered by two sources", () => {
  it.effect("is advertised and resolved as the SAME tool by all three merge sites", () =>
    Effect.gen(function* () {
      const applications = yield* ApplicationTools.Service
      const registry = yield* ToolRegistry.Service
      yield* applications.register({ [COLLIDING]: echo("from-application") })

      // What `materialize` hands the model. An application registration is RESIDENT (it lands in
      // `definitions`); an external one is DEFERRED (it lands in `deferred` and is withheld until
      // tool_search discloses it). So which list the name appears in says which source won.
      const materialized = yield* registry.materialize()
      expect(
        materialized.definitions.map((entry) => entry.name),
        "materialize advertised the EXTERNAL tool — an MCP server can shadow a first-party one",
      ).toContain(COLLIDING)
      expect(
        materialized.deferred.map((source) => source.definition.name),
        "the name is advertised twice, once from each source",
      ).not.toContain(COLLIDING)

      // ...must be what `catalogue` reports...
      const catalogued = (yield* registry.catalogue()).find((source) => source.definition.name === COLLIDING)
      expect(catalogued?.server, "catalogue and materialize disagree about who owns the name").toBe("application")

      // ...and what a real call actually reaches. This is the assertion that was impossible before:
      // the identity check turned every colliding call into `Stale tool call`.
      const output = yield* settleTool(registry, {
        sessionID,
        agent,
        assistantMessageID,
        call: { type: "tool-call", id: "call_1", name: COLLIDING, input: {} },
      })
      expect(JSON.stringify(output), "the colliding call did not execute the application tool").toContain(
        "from-application",
      )
      expect(JSON.stringify(output), "a colliding name still answers Stale tool call").not.toContain("Stale tool call")
    }),
  )

  it.effect("still serves an external tool whose name collides with nothing", () =>
    // The negative control for the fix's direction: making application win must not make external
    // tools unreachable. Without this, "application always wins" would pass by never serving
    // external tools at all.
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const catalogued = (yield* registry.catalogue()).find((source) => source.definition.name === COLLIDING)
      expect(catalogued, "the external tool is not catalogued even with no application registered").toBeDefined()
      expect(catalogued?.server, "an uncontested external tool lost its own name").not.toBe("application")
    }),
  )
})
