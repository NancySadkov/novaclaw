import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Location } from "@novaclaw/core/location"
import { ProjectFileResolve } from "@novaclaw/core/project-file"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Worktree } from "@/worktree"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { SessionListQuery, ToolListQuery, WorktreeApiError, WorktreeDirtyApiError } from "../groups/experimental"

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
      // 🔴 The dirty refusal is NOT folded into `mapWorktreeError`'s 400. It is a 409 carrying
      // `forceRequired: true`, so a client can offer "delete anyway" instead of showing an error —
      // the difference between a choice and a dead end, which is what the vision's "never breaks in
      // your hands" is about at the API boundary.
      yield* worktreeSvc.remove(input.payload).pipe(
        Effect.mapError((error) =>
          error._tag === "WorktreeDirtyError"
            ? new WorktreeDirtyApiError({
                name: "WorktreeDirtyError",
                data: { directory: error.directory, message: error.message, forceRequired: true },
              })
            : new WorktreeApiError({ name: error._tag, data: { message: error.message } }),
        ),
      )
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

    /**
     * The `novaclaw.json` governing the routed location.
     *
     * Reports what the file CONTRIBUTES rather than echoing it: a rule COUNT, not the rules. The
     * permission surface already renders rules, and a second place that formats them is a second
     * place for the two to disagree about what is in force.
     */
    const project = Effect.fn("ExperimentalHttpApi.project")(function* () {
      const directory = (yield* InstanceState.context).directory
      const resolution = yield* ProjectFileResolve.resolve(directory).pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
      )
      if (resolution.kind === "project")
        return {
          kind: "project" as const,
          root: resolution.root,
          file: resolution.file,
          ...(resolution.info.name === undefined ? {} : { name: resolution.info.name }),
          permissionRules: resolution.info.permissions?.length ?? 0,
          exclude: resolution.info.exclude ?? [],
        }
      // ⚠️ `invalid` is reported, never swallowed into `none`. "There is no project here" and "your
      // project file is broken" are the two answers a user acts on differently, and collapsing them
      // is how a typo becomes an afternoon.
      if (resolution.kind === "invalid")
        return { kind: "invalid" as const, file: resolution.file, reason: resolution.reason, detail: resolution.detail }
      return { kind: "none" as const }
      // ⚠️ `orDie` on the WHOLE handler. The resolver already ABSORBS every expected failure — an
      // unreadable file continues the walk, a malformed one comes back as `invalid` — so anything
      // surviving to here is a defect in this process, and calling that a client error would tell
      // the caller to fix a request that was fine.
    }, Effect.orDie)

    return handlers
      .handle("project", project)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("resource", resource)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
