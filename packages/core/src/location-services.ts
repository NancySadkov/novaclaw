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

// ⚠️ The GLOBAL half is hoisted and compiled again for EVERY location, and `Database`, `Global`,
// `MemoryClient` and `SessionScheduler` still end up as exactly ONE instance per process. That is
// load-bearing — a second `Database` is a second SQLite connection to a store whose transaction
// safety rests on a single-connection semaphore, and a second `SessionScheduler` is a second EEVDF
// ledger computing fair-share against a different total.
//
// MEASURED 2026-07-28 (effect@4.0.0-beta.83, build counters, 3 locations): 1 build and 1 instance of
// each, before and after. The roadmap item that opened this suspected a fresh `compile` cache would
// cost extra builds; it does not, and the reason is not the one the filing gave. Three separate
// behaviours produce the property, and a refactor can remove any of them:
//   1. all four nodes declare `deps: []`, so `LayerNode.compile` returns the module-level layer
//      OBJECT unchanged — the per-`compile()` cache never comes into play for them at all;
//   2. `LayerMap.make` captures ONE memo map (`Layer.CurrentMemoMap.getOrCreate`) and builds every
//      key with it, so all locations share it;
//   3. `Layer.fresh` is `self.build(makeMemoMapUnsafe(), scope)` — a brand-new ROOT memo map — and it
//      sits INSIDE the `Layer.provide` below, so the global half is built outside it. Moving the
//      `Layer.fresh` outward, or giving each key its own memo map, silently gives every location its
//      own `Database`; measured at 4 real SQLite connections across 3 locations.
// The `Layer.fresh` on the per-location half is deliberate and must stay: locations must not share
// per-location state (see `canonicalRef` above).
// Pinned by `test/location-services-global-identity.test.ts`, which counts builds rather than
// reasoning about wrapper shape (AGENTS.md → Known pitfalls, item −1) and is negative-controlled.
//
// Recompiling per location costs ~0.11 ms (hoist 0.061 ms + compile 0.046 ms, measured over 200
// iterations) against a ~30 ms location boot, so it is left in place rather than lifted out: the
// hoisted set IS ref-invariant (same node objects for two different refs), but lifting it would not
// make the property structural — the globals would still be shared only because the memo map is.
//
// ⚠️ KNOWN GAP, deliberately not fixed here: `LayerNode.compile(location.hoisted)` below is called
// WITHOUT `replacements`, and `hoist` stores a hoisted node by reference without rewriting its
// dependencies. So a caller-supplied replacement for a global reaches that global's own node and the
// location half, but not the 16 other hoisted globals that depend on it (every config store, Event,
// Credential, SessionStore, bash-jobs-recovery, … all still hold the original `Database.node`). The
// fix is to pass `replacements` to that `compile` call; it is not applied because it changes which
// layer every replacement-using suite gets and needs a full-gate run. Characterised, with the fix
// proven, in `test/effect/layer-node/layer-node.test.ts`.
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
