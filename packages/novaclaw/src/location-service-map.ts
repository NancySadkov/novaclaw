export * as ServerLocationServiceMap from "./location-service-map"

import { Layer } from "effect"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { buildLocationServiceMap, LocationServiceMap } from "@novaclaw/core/location-services"
import { ExternalCommandSource } from "@novaclaw/core/command/external-command-source"
import { ExternalToolSource } from "@novaclaw/core/tool/external-tool-source"
import { AggregateExternalToolSource } from "@/tool/external-tool-source"
import { McpExternalCommandSource } from "@/mcp/external-command-source"
import { ResourcePressureContext } from "@novaclaw/core/resource-pressure-context"
import { StorageResourcePressureContext } from "@/storage/resource-pressure-context"
import { McpHealthContext } from "@novaclaw/core/mcp-health-context"
import { McpHealthReport } from "@/mcp/health-context"
import { LocalModelManager } from "@novaclaw/core/local-model-manager"
import { LocalModelRuntime } from "@/local-model/runtime"
import { CapabilityServiceWorker } from "@novaclaw/core/capability-service-worker"
import { McpCapabilityServiceWorker } from "@/mcp/capability-service-worker"

// THE process-wide LocationServiceMap for the novaclaw server, with the MCP-backed
// ExternalToolSource injected so MCP tools (searxng et al.) appear on the V2 registry,
// and the MCP-backed ExternalCommandSource so MCP prompts list + dispatch as slash commands.
//
// ⚠️ There must be exactly ONE map instance per server: per-location service STATE lives inside
// the map's location graphs — location-scoped permission policy above all. A second
// map instance boots a parallel location for the same directory, so a runner-origin ask in one
// map can never be settled by an HTTP reply resolved through the other (the CLI deny path hung
// on exactly that). Every server-side consumer (the HTTP middlewares, the V2 runner/execution,
// and the Agent/file/pty handlers) must use THIS layer — same value, so the shared MemoMap
// builds it once. Do NOT call buildLocationServiceMap again elsewhere in the server, and do NOT
// use core's plain `locationServiceMapLayer` inside the server graph (headless CLI debug
// commands in their own process are the only legitimate consumers of the plain layer).
export const replacements: LayerNode.Replacements = [
  [ExternalToolSource.node, AggregateExternalToolSource.node],
  [ExternalCommandSource.node, McpExternalCommandSource.node],
  [ResourcePressureContext.node, StorageResourcePressureContext.node],
  [CapabilityServiceWorker.node, McpCapabilityServiceWorker.node],
  // ⚠️ WITHOUT THIS ROW THE SEAM SHIPS INERT. Core's default `McpHealthContext` answers `[]` for
  // every server set, so a missing replacement looks exactly like a healthy instance: the `<env>`
  // block is byte-identical, every core test still passes, and a broken MCP server goes back to
  // being invisible to the model — the defect the seam exists to remove. Pinned by
  // `test/location-service-map-replacements.test.ts`, because "a guard's SITE is invisible to
  // behaviour" is how this project has shipped an inert gate before.
  [McpHealthContext.node, McpHealthReport.node],
  [LocalModelManager.node, LocalModelRuntime.managerNode],
]

export const layer: Layer.Layer<LocationServiceMap.Service> = buildLocationServiceMap(replacements)

export const node = LayerNode.make({
  service: LocationServiceMap.Service,
  layer,
  deps: [],
})
