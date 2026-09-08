import { expect, test } from "bun:test"
import { locationServices } from "@novaclaw/core/location-services"
import { SessionWorkerRunnerLayer } from "./runner-layer"

/**
 * ─── EVERY REGISTRATION NODE THE HOST BUILDS, THE WORKER BUILDS TOO ───────────────────────────────
 *
 * A session worker compiles `SessionRunnerLLM.node`'s dependency subtree rather than the whole
 * location graph. That walk follows SERVICES, and a registration node has none — it exists purely
 * to put things into somebody else's registry (tools into `ToolRegistry`, contributors into
 * `SystemContextRegistry`, providers into `Catalog`, policies into `ToolPolicyGate`). So a
 * registration node is reachable from nothing, is silently omitted, and the registry it fills is
 * present, healthy and EMPTY. Nothing throws. Nothing logs.
 *
 * 🔴 **This file used to name three nodes by hand and it passed while the feature was dead.**
 * `ToolPolicyBuiltin.node` joined `location-services.ts` with the pre-action policy kernel and was
 * never added to the worker's root, so from the day policies landed until 2026-08-19 no built-in
 * policy ran on any real tool call — measured by instrumenting the live gate, where the host process
 * held both built-ins and the worker process (the one that actually screens) held none. Every unit
 * test was green because each installs its own provider into the gate under test.
 *
 * So the requirement is DERIVED from the host graph rather than restated. Adding a fifth
 * registration node to `location-services.ts` and forgetting this file now fails here instead of
 * shipping an empty registry.
 */

type AnyNode = { readonly name: string; readonly service?: unknown; readonly dependencies: readonly AnyNode[] }

const closure = (roots: readonly AnyNode[]): Set<AnyNode> => {
  const seen = new Set<AnyNode>()
  const walk = (node: AnyNode) => {
    if (seen.has(node)) return
    seen.add(node)
    for (const dependency of node.dependencies) walk(dependency)
  }
  for (const node of roots) walk(node)
  return seen
}

/**
 * A node that provides no service is a registration node — `LayerNode`'s own type says so: a node is
 * declared with EITHER a `service` or a bare `name`, and the `name`-only arm is what a boot/
 * registration layer uses.
 */
const registrationNodes = (nodes: Iterable<AnyNode>) => [...nodes].filter((node) => node.service === undefined)

const hostGraph = closure((locationServices as unknown as AnyNode).dependencies)
const workerGraph = closure((SessionWorkerRunnerLayer.root as unknown as AnyNode).dependencies)

test("🔴 every registration node the host location graph builds is built in the isolated worker too", () => {
  const missing = registrationNodes(hostGraph)
    .filter((node) => !workerGraph.has(node))
    .map((node) => node.name)
    .toSorted()
  // Named in the message rather than counted: the whole failure mode is that nobody knows WHICH
  // registry silently came up empty.
  expect(missing).toEqual([])
})

test("the check can still see an offender — a control, so an empty answer means something", () => {
  // The same computation against a root that deliberately omits the policies node must report it.
  // Without this, a bug that made `registrationNodes` return nothing would leave the test above
  // green forever.
  const withoutPolicies = closure(
    (SessionWorkerRunnerLayer.root as unknown as AnyNode).dependencies.filter(
      (node) => node.name !== "tool-policy/builtin",
    ),
  )
  const missing = registrationNodes(hostGraph)
    .filter((node) => !withoutPolicies.has(node))
    .map((node) => node.name)
  expect(missing).toContain("tool-policy/builtin")
})

test("the four registration siblings are present by name, so the requirement reads", () => {
  const names = new Set(SessionWorkerRunnerLayer.root.dependencies.map((node) => node.name))
  expect(names).toContain("plugin-internal")
  expect(names).toContain("system-context-builtins")
  expect(names).toContain("built-in-tools")
  // The one that was missing. Typed pre-action policies: a policy that is not
  // installed in the process doing the screening cannot refuse, patch or hold anything.
  expect(names).toContain("tool-policy/builtin")
})
