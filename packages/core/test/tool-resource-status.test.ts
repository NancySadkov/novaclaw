import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { ResourcePressureContext } from "@novaclaw/core/resource-pressure-context"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { ResourceStatusTool } from "@novaclaw/core/tool/resource-status"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { Effect, Layer } from "effect"
import { executeTool } from "./lib/tool"

const detail = [
  "Resource pressure: ok.",
  "Memory headroom: 12.0 GiB free of 40.0 GiB commit.",
  "Disk headroom: 80.0 GiB free of 100.0 GiB on C:/.",
]
const resourceLayer = Layer.succeed(
  ResourcePressureContext.Service,
  ResourcePressureContext.Service.of({ lines: () => Effect.succeed([]), inspect: () => Effect.succeed(detail) }),
)
const layer = ResourceStatusTool.layer.pipe(
  Layer.provideMerge(ToolRegistry.defaultLayer),
  Layer.provideMerge(resourceLayer),
)

describe("resource_status tool", () => {
  test("is deferred but returns full live detail after discovery", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const horizon = yield* registry.materialize()
        expect(horizon.definitions.map((entry) => entry.name)).not.toContain("resource_status")
        expect(horizon.deferred.map((entry) => entry.definition.name)).toContain("resource_status")

        const result = yield* executeTool(registry, {
          sessionID: SessionV2.ID.make("ses_resource_status"),
          agent: AgentV2.ID.make("build"),
          assistantMessageID: SessionMessage.ID.make("msg_resource_status"),
          call: { type: "tool-call", id: "call-resource-status", name: "resource_status", input: {} },
        })
        expect(result).toEqual({ type: "text", value: detail.join("\n") })
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })
})
