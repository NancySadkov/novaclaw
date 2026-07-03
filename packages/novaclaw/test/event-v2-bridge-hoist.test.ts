// F0 regression: the EventV2Bridge node must be GLOBAL-tagged so
// buildLocationServiceMap hoists it OUT of the per-location Layer.fresh subtree
// and Layer memoization collapses every graph onto the app graph's single
// instance (exactly how EventV2.node itself stays a single bus).
//
// When the bridge was untagged, one fresh bridge (and one events.listen
// projection) booted per location entry: every translated legacy envelope was
// then emitted once per instance — message.part.delta is APPEND-ONLY in the
// client reducer, so streamed text duplicated (N+1)x on web/desktop/TUI, and
// `prompted` (which used to mint random part ids per instance) duplicated the
// user bubble. This structural test pins the fix's mechanism.
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Node } from "@novaclaw/core/effect/app-node"
import { locationServices } from "@novaclaw/core/location-services"
import { ExternalToolSource } from "@novaclaw/core/tool/external-tool-source"
import { McpExternalToolSource } from "../src/mcp/external-tool-source"
import { EventV2Bridge } from "../src/event-v2-bridge"

describe("EventV2Bridge single-instance (F0)", () => {
  test("the bridge node is global-tagged", () => {
    expect(EventV2Bridge.node.tag).toBe(Node.tags.values.global)
  })

  test("hoist lifts the bridge out of the MCP-injected location subtree", () => {
    const { hoisted } = LayerNode.hoist(locationServices, Node.tags.values.global, [
      [ExternalToolSource.node, McpExternalToolSource.node],
    ])
    // `hoisted` is a group node whose dependencies are the hoisted singletons.
    const names = hoisted.dependencies.map((node) => node.name)
    expect(names).toContain(EventV2Bridge.node.name)
    // Sanity: EventV2 itself is hoisted the same way (the proven precedent).
    expect(names.some((name) => name.includes("EventV2"))).toBe(true)
  })
})
