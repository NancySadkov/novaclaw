import { Agent } from "@/agent/agent"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { CommandList } from "@novaclaw/core/command/list"
import { GlobalBus } from "@/bus/global"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { AppRegistry } from "@novaclaw/core/app-registry"
import { Global } from "@novaclaw/core/global"
import { DatabasePath } from "@novaclaw/core/database/db-path"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { Credential } from "@novaclaw/core/credential"
import { CredentialRepair } from "@novaclaw/core/credential/repair"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { VirtualFs } from "@novaclaw/core/virtual-fs"
import { Scratch } from "@novaclaw/core/scratch"
import { OsPlaces } from "@/server/os-places"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { WorldMemory } from "@novaclaw/core/kb-graph/world-memory"
import { Database } from "@novaclaw/core/database/database"
import { DatabaseHealth } from "@novaclaw/core/database/health"
import { CatalogSeed } from "@novaclaw/core/catalog-seed"
import { NovaHealth } from "@novaclaw/core/nova-health"
import { CapabilityRegistry, type Snapshot as CapabilitySnapshot } from "@novaclaw/core/effect/capability-registry"
import { ProviderReach } from "@novaclaw/core/provider-reach"
import { ConfigProviderPreset } from "@novaclaw/core/config/provider-preset"
import { Offline } from "@novaclaw/core/offline"
import { Config } from "@/config/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { HostPressure } from "@/storage/host-pressure"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiAppRegisterError } from "../groups/instance"
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
    const config = yield* Config.Service
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
        : yield* Effect.promise(() => OsPlaces.probePlaces(Global.Path.home)).pipe(Effect.orElseSucceed(() => []))
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

    const listApp = Effect.fn("InstanceHttpApi.appList")(function* () {
      return yield* Effect.tryPromise(() => AppRegistry.listApps()).pipe(Effect.orDie)
    })

    const registerApp = Effect.fn("InstanceHttpApi.appRegister")(function* (ctx: { payload: AppRegistry.SaveInput }) {
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
        "diagnosis",
        Effect.fn("InstanceHttpApi.diagnosis")(function* (request: {
          readonly query: { readonly probe?: "provider" | undefined }
        }) {
          // Every reading degrades to `unknown` instead of failing the request. This is the screen a
          // person opens when they already suspect trouble -- a 500 here tells them nothing and
          // takes away the rows that WERE readable.
          const storage = yield* HostPressure.Service
          const pressure = yield* storage.pressure().pipe(Effect.orElseSucceed(() => ({ level: "unknown" as const })))

          const { db } = yield* Database.Service
          const database = yield* DatabaseHealth.check(DatabaseHealth.executorOf(db)).pipe(
            Effect.orElseSucceed(() => ({ status: "unknown" as const, detail: "The store could not be read." })),
          )

          // ⚠️ The CALENDAR scheduler, read from the capability registry — not `SessionScheduler`,
          // which is per-device admission control and has nothing to do with scheduled work. The row
          // has always been labelled "Scheduled runs"; until 2026-08-12 it was measuring a different
          // module with a similar name. The registry holds a recorded status, so this starts nothing.
          const capabilities = yield* CapabilityRegistry.Service.pipe(
            Effect.flatMap((registry) => registry.inspect()),
            Effect.orElseSucceed(() => [] as ReadonlyArray<CapabilitySnapshot>),
          )
          const schedulerState = capabilities.find((row) => row.name === "calendar-scheduler")?.status.state
          // Every OTHER edge that is down gets a row. Without this they were visible only through
          // /api/capability, which lives behind Developer mode.
          const downCapabilities = capabilities
            .filter((row) => row.status.state === "unavailable" && !NovaHealth.NAMED_CAPABILITY_ROWS.has(row.name))
            .map((row) => NovaHealth.fromCapability(row.name))

          // WHICH provider: the default model's. "Can I talk to my model?" is a singular question,
          // and an instance may carry a dozen configured providers that are never used.
          const merged = (yield* ConfigStoreWrite.overlay((yield* config.getGlobal()) as Record<string, unknown>)) as {
            model?: string
            providers?: Record<string, { api?: { url?: string } }>
            provider_presets?: Record<string, { baseURL?: string }>
          }
          const target = ProviderReach.targetOf({
            model: merged.model,
            providers: merged.providers,
            presets: ConfigProviderPreset.effective(merged.provider_presets as never),
          })

          const providerRow =
            target === undefined
              ? // No default model means no provider to be told about. Inventing an "unknown" row would
                // put a worry on this screen that the rest of the product does not share.
                undefined
              : target.baseURL === undefined
                ? NovaHealth.fromProvider({
                    name: target.name,
                    verdict: "unknown",
                    detail: "No address is configured for this provider.",
                  })
                : // ⚠️ The policy answer is FREE and comes first: when the airgap is on, the request
                  // would fail, and calling that "unreachable" would tell someone their provider is
                  // broken when the truth is that they turned offline mode on themselves.
                  // Read the SAME live ref that enforces the guard, never a re-derived policy: a
                  // status surface that recomputes can disagree with what is actually blocking, which
                  // is ruling 2 on the screen someone opens to find out what is wrong. `shell.ts`
                  // learned this already -- re-deriving also costs two sqlite open/close pairs.
                  ProviderReach.blockedByPolicy((yield* Offline.Service).policy, target.baseURL)
                  ? NovaHealth.fromProvider({ name: target.name, verdict: "blocked" })
                  : request.query.probe !== "provider"
                    ? NovaHealth.fromProvider({
                        name: target.name,
                        verdict: "unknown",
                        detail: "Not checked — checking contacts the provider.",
                      })
                    : NovaHealth.fromProvider({
                        name: target.name,
                        ...(yield* ProviderReach.probe({
                          // The discovery convention this tree already uses everywhere.
                          url: `${target.baseURL.replace(/\/$/, "")}/models`,
                          fetcher: async (url, signal) => {
                            const response = await fetch(url, { signal })
                            return { ok: response.ok, status: response.status }
                          },
                        })),
                      })

          // ⚠️ The ENGINE's stage, not the capability's. The capability answers "did the layer
          // build", and it does — the open failure is caught inside and yields a degraded client —
          // so it reads `ready` against a provably broken store. Measured 2026-08-12.
          // A plain read of the last transition: inspecting must not open the graph.
          const memory = Memory.runtimeStatus()
          const worldMemory = WorldMemory.runtimeStatus()

          // A scan failure is an unknown credential state, never a healthy result.
          const credentials = yield* Effect.gen(function* () {
            const { db } = yield* Database.Service

            const settings = yield* SettingsConfigStore.Service
            const found = CredentialRepair.dedupe([
              ...(yield* CredentialRepair.scan([
                Credential.repairSource(db),
                // See the sibling handler: without this the scan reports 0 damaged for the one
                // secret a user has no way to re-enter.
                InstanceIdentityStore.repairSource(db),
              ])),
              ...(yield* settings
                .unreadable()
                .pipe(Effect.catchCause(() => Effect.succeed([{ path: "runtime-settings" }])))),
            ])
            return { unreadable: found.length, notice: CredentialRepair.notice(found) }
          }).pipe(
            Effect.catchCause(() =>
              Effect.succeed({ unreadable: 1, notice: "Stored credentials could not be checked." }),
            ),
          )

          // Read at CHECK time, not remembered from the seed: a drop recorded at first boot goes
          // stale the moment the user fixes the file, and it would miss a file that broke afterwards.
          // Best-effort — a health board must never be the thing that fails.
          const unreadableConfig = yield* CatalogSeed.unreadableDocuments((yield* Global.Service).config).pipe(
            Effect.orElseSucceed(() => [] as readonly { readonly path: string; readonly notice: string }[]),
          )

          const signals = [
            NovaHealth.fromCredentials(
              credentials.notice === undefined
                ? { unreadable: credentials.unreadable }
                : { unreadable: credentials.unreadable, notice: credentials.notice },
            ),
            NovaHealth.fromPressure(pressure),
            NovaHealth.fromDatabase(database),
            NovaHealth.fromMemory({
              stage: memory.stage,
              ...(memory.detail === undefined ? {} : { detail: memory.detail }),
            }),
            NovaHealth.fromWorldMemory({
              stage: worldMemory.stage,
              ...(worldMemory.detail === undefined ? {} : { detail: worldMemory.detail }),
            }),
            NovaHealth.fromScheduler(schedulerState),
            // ⚠️ `undefined`, not `false`. UPDATER_ENABLED lives in the desktop main process and a
            // server-side board cannot read it; reporting "updates are off" would describe the
            // user's own configuration falsely.
            NovaHealth.fromUpdater(undefined),
            NovaHealth.fromConfigDocument({ unreadable: unreadableConfig }),
            ...(providerRow === undefined ? [] : [providerRow]),
            ...downCapabilities,
          ]

          return { overall: NovaHealth.worst(signals), headline: NovaHealth.headline(signals), signals }
        }),
      )
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
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("appList", listApp)
      .handle("appRegister", registerApp)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
