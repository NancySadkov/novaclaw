export * as SessionWorkerRunnerLayer from "./runner-layer"

import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { PluginInternal } from "@novaclaw/core/plugin/internal"
import { SystemContextBuiltIns } from "@novaclaw/core/system-context/builtins"
import { BuiltInTools } from "@novaclaw/core/tool/builtins"
import { ToolPolicyBuiltin } from "@novaclaw/core/tool-policy-builtin"
import { SessionRunnerLLM } from "@novaclaw/core/session/runner/llm"
import type { SessionWorkerCapabilities } from "./capabilities"
import { SessionWorkerServices } from "./services"
import { ServerLocationServiceMap } from "../location-service-map"

/**
 * ⚠️ **A REGISTRATION node is invisible to the dependency walk that builds this graph.**
 *
 * Every entry here has the same shape: it provides no service, so nothing *depends* on it, so
 * compiling `SessionRunnerLLM.node`'s declared subtree leaves it out — and what it would have
 * registered is simply absent inside the worker. The failure is silent in both directions: the
 * consumer (`Catalog`, `SystemContextRegistry`, `ToolRegistry`, `ToolPolicyGate`) is present and
 * healthy, it is merely EMPTY, so nothing errors and no test that builds the gate itself can see it.
 *
 * 🔴 `ToolPolicyBuiltin.node` was the fourth, added to `location-services.ts` with the policy kernel
 * and never added here — measured 2026-08-19 by instrumenting the live gate: the host process
 * screened through a gate holding both built-ins while the WORKER process, which is where every real
 * tool call is screened, held `providers=[]`. `git log` was never rewritten and `rm -rf /` would
 * never have been refused, on any real session, since the kernel landed. Every unit test was green
 * because they all install a provider into the gate under test.
 *
 * The named list below is kept because it reads, but the thing that HOLDS is
 * `runner-layer.test.ts`, which derives the required set from `locationServices` instead of
 * repeating it — a hand-maintained checklist is exactly what failed here.
 */
export const root = LayerNode.group([
  SessionRunnerLLM.node,
  PluginInternal.node,
  SystemContextBuiltIns.node,
  BuiltInTools.node,
  ToolPolicyBuiltin.node,
])

/** Compiles only the runner dependency subtree for one worker/location. Host-owned services and
 * NovaClaw's external-tool/model integrations are replaced before any layer is materialized. */
export function make(capabilities: SessionWorkerCapabilities.Capabilities, location: Location.Ref) {
  return AppNodeBuilder.build(
    // The normal location graph has four registration/boot siblings which the runner consumes
    // indirectly: provider/plugin materialization, system-context contributors, resident tools, and
    // the shipped pre-action policies. Building only SessionRunnerLLM's declared service subtree
    // produced an empty model catalog, empty prompt context, empty tool manifest — and an unpoliced
    // tool gate — inside isolated workers. Materialize those bounded boot nodes beside the runner
    // without starting unrelated services such as PTYs/watchers.
    root,
    ServerLocationServiceMap.replacements
      .concat(SessionWorkerServices.replacements(capabilities))
      .concat([[Location.node, Location.boundNode(location)]]),
  )
}
