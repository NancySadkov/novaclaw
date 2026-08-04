export * as SessionWorkerRunnerLayer from "./runner-layer"

import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { PluginInternal } from "@novaclaw/core/plugin/internal"
import { SystemContextBuiltIns } from "@novaclaw/core/system-context/builtins"
import { BuiltInTools } from "@novaclaw/core/tool/builtins"
import { SessionRunnerLLM } from "@novaclaw/core/session/runner/llm"
import type { SessionWorkerCapabilities } from "./capabilities"
import { SessionWorkerServices } from "./services"
import { ServerLocationServiceMap } from "../location-service-map"

export const root = LayerNode.group([
  SessionRunnerLLM.node,
  PluginInternal.node,
  SystemContextBuiltIns.node,
  BuiltInTools.node,
])

/** Compiles only the runner dependency subtree for one worker/location. Host-owned services and
 * NovaClaw's external-tool/model integrations are replaced before any layer is materialized. */
export function make(capabilities: SessionWorkerCapabilities.Capabilities, location: Location.Ref) {
  return AppNodeBuilder.build(
    // The normal location graph has three registration/boot siblings which the runner consumes
    // indirectly: provider/plugin materialization, system-context contributors, and resident tools.
    // Building only SessionRunnerLLM's declared service subtree produced an empty model catalog,
    // empty prompt context, and empty tool manifest inside isolated workers. Materialize those
    // bounded boot nodes beside the runner without starting unrelated services such as PTYs/watchers.
    root,
    ServerLocationServiceMap.replacements
      .concat(SessionWorkerServices.replacements(capabilities))
      .concat([[Location.node, Location.boundNode(location)]]),
  )
}
