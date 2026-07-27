import { Agent } from "@/agent/agent"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { CommandList } from "@novaclaw/core/command/list"
import { GlobalBus } from "@/bus/global"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { AppRegistry } from "@novaclaw/core/app-registry"
import { Global } from "@novaclaw/core/global"
import { DatabasePath } from "@novaclaw/core/database/db-path"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { VirtualFs } from "@novaclaw/core/virtual-fs"
import { Scratch } from "@novaclaw/core/scratch"
import { Vcs } from "@/project/vcs"
import { OsPlaces } from "@/server/os-places"
import { Skill } from "@/skill"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiAppRegisterError, ApiVcsApplyError } from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"

// Filesystem roots for the picker / Files "jump to drive" affordance (M6). Windows probes A:–Z:
// once per process (the drive set rarely changes; a restart re-probes); POSIX is just "/".
let cachedRoots: Promise<string[]> | undefined
function probeRoots(): Promise<string[]> {
  cachedRoots ??= (async () => {
    if (process.platform !== "win32") return ["/"]
    const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))
    const found = await Promise.all(
      letters.map((letter) =>
        fs.stat(`${letter}:\\`).then(
          () => `${letter}:\\`,
          () => undefined,
        ),
      ),
    )
    return found.filter((root): root is string => root !== undefined)
  })()
  return cachedRoots
}

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const format = yield* Format.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service
    const settingsStore = yield* SettingsConfigStore.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      const roots: string[] = yield* Effect.promise(() => probeRoots())
      // FS-3: when the host has no browsable FS, provision + advertise the app-private root.
      // T7: the store-backed `virtualFs` setting joins the env flag as the on-switch.
      const virtual = VirtualFs.enabled(yield* settingsStore.all())
      const virtualRoot = virtual ? yield* Effect.promise(() => VirtualFs.ensure()) : undefined
      // The shared default cwd for folder-less agents ("New Agent" with no project). Provisioned
      // always (idempotent) so the client can always start an agent without picking a folder.
      const scratchDir = yield* Effect.promise(() => Scratch.ensure())
      // The picker's Places rail: the host's existing well-known folders. Suppressed in virtual
      // mode (no host FS to jump to); never fails the route (degrades to none).
      const places = virtual
        ? []
        : yield* Effect.promise(() => OsPlaces.probePlaces(Global.Path.home)).pipe(
            Effect.orElseSucceed(() => []),
          )
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        data: Global.Path.data,
        worktree: ctx.worktree,
        directory: ctx.directory,
        roots,
        scratchDir,
        cache: Global.Path.cache,
        tmp: Global.Path.tmp,
        log: Global.Path.log,
        // The instance database file. Resolved by the server because the filename depends on the
        // release channel, so a client cannot compute it from `data`.
        db: DatabasePath.path(),
        ...(Global.Path.explicitHome ? { instanceHome: Global.Path.explicitHome } : {}),
        ...(places.length > 0 ? { places } : {}),
        ...(virtual ? { virtual: true, virtualRoot } : {}),
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number }
    }) {
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    // P6 reconciliation (rides config-sqlite step 9): list from the authoritative V2 truth —
    // the shared `CommandList` union (CommandV2 ∪ skills ∪ MCP prompts, the same set the
    // session command op dispatches) — projected onto the V1 wire shape. The old novaclaw
    // `Command.Service` map read V1 config, so store/plugin commands ran but never appeared
    // (the getAgent bug class), while its MCP/skill entries appeared but could NOT dispatch
    // (the V2 command op never knew them).
    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      const directory = (yield* InstanceState.context).directory
      const entries = yield* CommandList.list.pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
      )
      return entries.map(
        (entry): Command.Info => ({
          name: entry.name,
          description: entry.description,
          agent: entry.agent,
          model: entry.model ? `${entry.model.providerID}/${entry.model.id}` : undefined,
          source: entry.source,
          template: entry.template,
          subtask: entry.subtask,
          hints: entry.hints ?? [],
        }),
      )
    })

    // F1 reconciliation: list from the authoritative V2 store (`AgentV2`, what the
    // runner reads — a superset incl. PLUGIN-registered agents), projected onto the
    // V1 wire shape. Reading the old novaclaw `Agent.Service` here made plugin agents
    // run but never appear. `AgentV2` is location-scoped → resolve via the shared map.
    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      const directory = (yield* InstanceState.context).directory
      return yield* Agent.listV2.pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
      )
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    const listApp = Effect.fn("InstanceHttpApi.appList")(function* () {
      return yield* Effect.tryPromise(() => AppRegistry.listApps()).pipe(Effect.orDie)
    })

    const registerApp = Effect.fn("InstanceHttpApi.appRegister")(function* (ctx: {
      payload: AppRegistry.SaveInput
    }) {
      const manifest = yield* Effect.tryPromise(() => AppRegistry.saveApp(ctx.payload)).pipe(
        Effect.mapError(
          (error) =>
            new ApiAppRegisterError({
              name: "AppRegisterError",
              data: { message: error.cause instanceof Error ? error.cause.message : String(error.cause) },
            }),
        ),
      )
      // Same notification the agent tool emits via EventV2 — clients refetch the manifest list.
      GlobalBus.emit("event", {
        directory: "global",
        payload: { type: "app.registered", properties: { id: manifest.id, title: manifest.title } },
      })
      return manifest
    })

    return handlers
      .handle("dispose", dispose)
      .handle(
        "scheduler",
        Effect.fn("InstanceHttpApi.scheduler")(function* () {
          // Read-only introspection: never fails the request — an unbuilt scheduler reports empty
          // rather than 500ing a diagnostics page.
          const scheduler = yield* SessionScheduler.Service
          return yield* scheduler.snapshot().pipe(Effect.orElseSucceed(() => []))
        }),
      )
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("formatter", getFormatter)
      .handle("appList", listApp)
      .handle("appRegister", registerApp)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
