import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Worktree } from "@/worktree"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { SessionListQuery, ToolListQuery, WorktreeApiError } from "../groups/experimental"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const locations = yield* LocationServiceMap.Service
    const worktreeSvc = yield* Worktree.Service

    // Tool enumeration is an installed-catalogue surface, not a provider horizon: deferred external
    // schemas still belong here even though materialize().definitions intentionally excludes them.
    const toolDefinitions = Effect.fn("ExperimentalHttpApi.toolDefinitions")(function* () {
      const directory = (yield* InstanceState.context).directory
      return yield* ToolRegistry.Service.pipe(
        Effect.flatMap((registry) => registry.catalogue()),
        Effect.map((sources) => sources.map((source) => source.definition)),
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
      )
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (_ctx: { query: typeof ToolListQuery.Type }) {
      const definitions = yield* toolDefinitions()
      return definitions.map((def) => ({
        id: def.name,
        description: def.description,
        parameters: def.inputSchema,
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      const definitions = yield* toolDefinitions()
      return definitions.map((def) => def.name)
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      // T3 (entities.md): the sandbox registry died with the entity — git is the truth.
      return (yield* mapWorktreeError(worktreeSvc.list())).map((item) => item.directory)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("resource", resource)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
