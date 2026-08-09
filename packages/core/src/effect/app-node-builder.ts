import { buildLocationServiceMap } from "../location-services"
import { LocationServiceMap } from "../location-service-map"
import { LayerNode } from "./layer-node"
import { makeGlobalNode } from "./app-node"
import { CapabilityRegistry } from "./capability-registry"

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
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
