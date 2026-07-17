import { Effect, Layer, LayerMap } from "effect"
import { AdhocGuidance } from "./adhoc-tools/guidance"
import { AgentV2 } from "./agent"
import { Catalog } from "./catalog"
import { CommandV2 } from "./command"
import { ExternalCommandSource } from "./command/external-command-source"
import { Config } from "./config"
import { LayerNode } from "./effect/layer-node"
import { Node } from "./effect/app-node"
import { FileMutation } from "./file-mutation"
import { FileSystem } from "./filesystem"
import { FileSystemSearch } from "./filesystem/search"
import { Watcher } from "./filesystem/watcher"
import { Image } from "./image"
import { Integration } from "./integration"
import { Location } from "./location"
import { LocationMutation } from "./location-mutation"
import { LocationServiceMap } from "./location-service-map"
import { PermissionV2 } from "./permission"
import { PluginV2 } from "./plugin"
import { PluginInternal } from "./plugin/internal"
import { Policy } from "./policy"
import { Pty } from "./pty"
import { QuestionV2 } from "./question"
import { Reference } from "./reference"
import { ReferenceGuidance } from "./reference/guidance"
import * as SessionRunnerLLM from "./session/runner/llm"
import { SessionRunnerModel } from "./session/runner/model"
import { SessionTodo } from "./session/todo"
import { SessionSpawner } from "./session/spawner"
import { SkillV2 } from "./skill"
import { SkillGuidance } from "./skill/guidance"
import { Snapshot } from "./snapshot"
import { SystemContextBuiltIns } from "./system-context/builtins"
import { SystemContextRegistry } from "./system-context/registry"
import { BuiltInTools } from "./tool/builtins"
import { ExternalToolSource } from "./tool/external-tool-source"
import { ReadToolFileSystem } from "./tool/read-filesystem"
import { ToolRegistry } from "./tool/registry"
import { ToolOutputStore } from "./tool-output-store"

export { LocationServiceMap } from "./location-service-map"

export const locationServices = LayerNode.group([
  Location.node,
  Policy.node,
  Config.node,
  AgentV2.node,
  CommandV2.node,
  ExternalCommandSource.node,
  Reference.node,
  Integration.node,
  Catalog.node,
  PluginV2.node,
  PluginInternal.node,
  FileSystemSearch.node,
  FileSystem.node,
  Watcher.node,
  Pty.node,
  SkillV2.node,
  AdhocGuidance.node,
  SystemContextRegistry.node,
  SystemContextBuiltIns.node,
  LocationMutation.node,
  FileMutation.node,
  PermissionV2.node,
  ToolOutputStore.node,
  ExternalToolSource.node,
  ToolRegistry.node,
  ToolRegistry.toolsNode,
  Image.node,
  SkillGuidance.node,
  ReferenceGuidance.node,
  SessionTodo.node,
  SessionSpawner.node,
  QuestionV2.node,
  ReadToolFileSystem.node,
  BuiltInTools.node,
  SessionRunnerModel.node,
  Snapshot.node,
  SessionRunnerLLM.node,
])

export type LocationServices = LayerNode.Output<typeof locationServices>
export type LocationError = LayerNode.Error<typeof locationServices>

// The LayerMap keys refs by STRUCTURAL equality, which is key-set-sensitive: a ref built with
// an explicit `workspaceID: undefined` key is NOT equal to one that omits the key, and extra
// fields (a full Location.Info passed where a Ref is expected) split the cache the same way.
// A split key boots a PARALLEL location graph for the same directory — duplicating per-location
// STATE (PermissionV2's pending asks above all). Canonicalize every ref at the map boundary.
const canonicalRef = (ref: Location.Ref): Location.Ref =>
  ref.workspaceID === undefined
    ? ({ directory: ref.directory } as Location.Ref)
    : ({ directory: ref.directory, workspaceID: ref.workspaceID } as Location.Ref)

export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service> {
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.map(
      LayerMap.make(
        (ref: Location.Ref) => {
          const allReplacements = replacements.concat([[Location.node, Location.boundNode(ref)]])
          const location = LayerNode.hoist(locationServices, Node.tags.values.global, allReplacements)

          return LayerNode.compile(location.node).pipe(
            Layer.fresh,
            Layer.tap(() =>
              Effect.logInfo("booting location services", {
                directory: ref.directory,
                workspaceID: ref.workspaceID,
              }),
            ),
            Layer.provide(LayerNode.compile(location.hoisted)),
          )
        },
        { idleTimeToLive: "60 minutes" },
      ),
      (map) => ({
        ...map,
        get: (ref) => map.get(canonicalRef(ref)),
        contextEffect: (ref) => map.contextEffect(canonicalRef(ref)),
        invalidate: (ref) => map.invalidate(canonicalRef(ref)),
      }),
    ),
  )
}

// This is temporary for backwards compatibility
export const locationServiceMapLayer = buildLocationServiceMap()
