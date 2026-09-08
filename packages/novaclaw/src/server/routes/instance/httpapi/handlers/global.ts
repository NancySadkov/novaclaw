import { Config } from "@/config/config"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EventV2 } from "@novaclaw/core/event"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { InvalidRequestError } from "../errors"
import { MDNS } from "@/server/mdns"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@novaclaw/core/installation/version"
import { LocalModelManager } from "@novaclaw/core/local-model-manager"
import type { ConfigLocalModelCatalog } from "@novaclaw/core/config/local-model-catalog"
import { HostPressure } from "@/storage/host-pressure"
import { Pressure } from "@/storage/pressure"
import { ResourceUsage } from "@/storage/resource-usage"
import { Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { Log } from "@novaclaw/schema/log"
import { mutateConfig } from "./config-mutation"
import { ServerAuth } from "@/server/auth"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

/**
 * How far a client may fall behind before it is disconnected to resync.
 *
 * ⚠️ Generous on purpose: a normal client drains continuously, so reaching this means it has stopped
 * reading, not that it is merely slow. Small enough that one stalled tab cannot own the heap.
 */
const EVENT_STREAM_BUFFER = 1024

function eventResponse() {
  return Effect.gen(function* () {
    yield* Log.event("server.global.event.connected", {})
    /**
     * 🔴 **NC-REL-008 — this queue was UNBOUNDED.** `Stream.callback` passes an omitted `bufferSize`
     * straight to `Queue.make`, so every slow client accumulated its own copy of the process-wide
     * model event stream in server memory, without limit. One stalled browser tab was enough.
     *
     * ⚠️ **Bounded, and overflow ENDS the stream — it does not trim it.** The three strategies the API
     * offers are all wrong here: `suspend` would let one slow client apply backpressure to the bus
     * every other client shares; `sliding` and `dropping` make that client's view diverge invisibly,
     * which is the same silent-corruption shape as NC-REL-004 one layer up. Ending is safe precisely
     * because the app already resyncs on reconnect — the client receives `server.connected` and
     * invalidates, so a forced reconnect costs a round trip and loses nothing.
     */
    const events = Stream.callback<GlobalBusEvent>(
      (queue) => {
        let buffered = 0
        const handler = (event: GlobalBusEvent) => {
          if (Queue.offerUnsafe(queue, event)) {
            buffered++
            return
          }
          Effect.runFork(
            Log.event("server.global.event.overflow", { "server.stream": "global", "server.buffered": buffered }),
          )
          Queue.endUnsafe(queue)
        }
        return Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", handler)),
          () => Effect.sync(() => GlobalBus.off("event", handler)),
        )
      },
      { bufferSize: EVENT_STREAM_BUFFER },
    )
    const heartbeat = Stream.tick("5 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Log.event("server.global.event.disconnected", {})),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const identity = yield* InstanceIdentityStore.Service
    const localModels = yield* LocalModelManager.Service
    const storage = yield* HostPressure.Service
    const launchAuth = yield* ServerAuth.Config
    const settings = yield* SettingsConfigStore.Service

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      // `identity()` rather than `get()`: both read the same row, so reporting the network identity
      // alongside the handle costs nothing extra on an endpoint that gets polled hard.
      const self = yield* identity.identity()
      // The sealing key is minted on first request and kept, so this is one extra row read on an
      // endpoint that is polled hard — and it is what lets ONE fetch teach a peer both halves of who
      // lives here: the identity to verify signatures against, and the key to seal to.
      const sealing = yield* identity.sealingKey()
      const auth = ServerAuth.resolve(launchAuth, yield* settings.serverPassword())
      return {
        healthy: true as const,
        version: InstallationVersion,
        auth: { required: ServerAuth.required(auth.config), source: auth.source },
        instanceID: self.id,
        networkID: self.networkID,
        sealingKey: sealing.publicKey,
        sealingSignature: sealing.signature,
      }
    })

    const identityBackup = Effect.fn("GlobalHttpApi.identityBackup")(function* () {
      // The store owns the shape and the encryption; this handler only carries it to the wire.
      return yield* identity.backup()
    })

    /**
     * 🔴 Backup's missing half. It shipped alone, so a user could export an identity and never
     * import it — the button led nowhere, and §4 of the community spec is explicit that this is not
     * cosmetic: with no authority there is no reset, so the backup IS the recovery story.
     *
     * ⚠️ The store's refusal is translated rather than re-decided here. `restore` fails when the
     * instance already has an identity and `replace` was not passed, and that refusal is the whole
     * safety property — a handler that defaulted `replace` to true would silently orphan every
     * contact and channel that knows this peer.
     */
    const identityRestore = Effect.fn("GlobalHttpApi.identityRestore")(function* (ctx: {
      readonly payload: {
        readonly backup: InstanceIdentityStore.Backup
        readonly replace?: boolean
      }
    }) {
      const restored = yield* identity
        .restore(ctx.payload.backup, { replace: ctx.payload.replace === true })
        .pipe(
          Effect.catchTag("InstanceIdentityStore.RestoreError", (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message })),
          ),
        )
      // Public halves only: the secret went IN, and nothing about it comes back out.
      return { id: restored.id, networkID: restored.networkID }
    })

    // Remote-access R7: a bounded LAN scan for NovaClaw instances advertising via serve --mdns.
    // Discovery is an INSTANCE capability (the UI is a thin client and may not be on the LAN or
    // able to open multicast sockets at all — the web build cannot); the scanning instance is.
    const discovery = Effect.fn("GlobalHttpApi.discovery")(function* () {
      const self = yield* identity.get()
      const found = yield* Effect.promise(() => MDNS.browse())
      return {
        instances: found.map((instance) => ({
          ...instance,
          self: instance.instanceID === self,
        })),
      }
    })

    const pressure = Effect.fn("GlobalHttpApi.pressure")(function* () {
      // The launcher needs only this cheap answer. Do not route it through ResourceUsage.collect:
      // that response also inventories the database, graph, models, runtime, downloads and logs.
      const report = yield* storage.pressure()
      return {
        measuredAt: Date.now(),
        memory: report.memory,
        level: report.level,
        memoryLevel: Pressure.memoryLevel(report.memory, report.thresholds),
      }
    })

    const resources = Effect.fn("GlobalHttpApi.resources")(function* () {
      const base = (yield* config.getGlobal()) as Record<string, unknown>
      const merged = (yield* ConfigStoreWrite.overlay(base)) as { local_model_catalog?: ConfigLocalModelCatalog.Info }
      const [pressure, localModel] = yield* Effect.all(
        [storage.pressure(), localModels.status(merged.local_model_catalog)],
        { concurrency: "unbounded" },
      )
      return yield* Effect.promise(() => ResourceUsage.collect({ pressure, localModel }))
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    // The `Config.Info` success schema is a Schema.Class, so responses must be class INSTANCES — the
    // service returns plain merged objects (with derived `plugin_origins`); decode before returning.
    // Config→SQLite step 7: the store-backed keys OVERLAY the file-derived view, so the
    // Settings UI reads exactly what the write router stored (the file no longer carries them).
    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      const base = (yield* config.getGlobal()) as Record<string, unknown>
      return Schema.decodeUnknownSync(ConfigV2.Info)(yield* ConfigStoreWrite.overlay(base))
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      return yield* mutateConfig({ request: ctx.request, payload: ctx.payload, readView: "global" })
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handle("discovery", discovery)
      .handle("instance.pressure.get", pressure)
      .handle("resources", resources)
      .handle("identityBackup", identityBackup)
      .handle("identityRestore", identityRestore)
  }),
)
