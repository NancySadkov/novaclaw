import { buildLocationServiceMap } from "../location-services"
import { LocationServiceMap } from "../location-service-map"
import { LayerNode } from "./layer-node"
import { makeGlobalNode } from "./app-node"
import { CapabilityRegistry } from "./capability-registry"

type ReplacedServices<Items extends LayerNode.Replacements> = Items[number] extends readonly [
  LayerNode.Node<infer A, unknown, any, any>,
  unknown,
]
  ? A
  : never

type CheckExternalRequirements<R, Items extends LayerNode.Replacements> = [
  Exclude<R, ReplacedServices<Items>>,
] extends [never]
  ? unknown
  : { readonly "Missing external replacements": Exclude<R, ReplacedServices<Items>> }

/** Build an already-closed graph. */
export function build<A, E>(
  root: LayerNode.Node<A, E, any, never>,
  replacements?: LayerNode.Replacements,
): import("effect").Layer.Layer<A, E>
/** Build a graph whose declared external requirements are all bound by the supplied replacements. */
export function build<A, E, R, const Items extends LayerNode.Replacements>(
  root: LayerNode.Node<A, E, any, R>,
  replacements: Items & CheckExternalRequirements<R, Items>,
): import("effect").Layer.Layer<A, E>
export function build(
  root: LayerNode.Node<unknown, unknown, any, any>,
  replacements: LayerNode.Replacements = [],
) {
  let allReplacements = CapabilityRegistry.bind(root, replacements)

  // Only build the location service map if it's actually needed
  if (
    LayerNode.hasUnbound(root, LocationServiceMap.node) &&
    !hasReplacement(allReplacements, LocationServiceMap.node)
  ) {
    const locationMap = buildLocationServiceMap(allReplacements)
    const locationMapNode = makeGlobalNode({ service: LocationServiceMap.Service, layer: locationMap, deps: [] })
    allReplacements = allReplacements.concat([[LocationServiceMap.node, locationMapNode]])
  }

  return LayerNode.compile(root, allReplacements)
}

function hasReplacement(replacements: LayerNode.Replacements, node: LayerNode.Node<unknown, unknown, any>) {
  return replacements.some(([source]) => source.name === node.name)
}

export * as AppNodeBuilder from "./app-node-builder"
