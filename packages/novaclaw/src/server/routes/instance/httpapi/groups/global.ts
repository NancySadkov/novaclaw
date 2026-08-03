import { Config as ConfigV2 } from "@novaclaw/core/config"
import { EventV2 } from "@novaclaw/core/event"
import { EventManifest } from "@/event-manifest"
import { InstanceDisposed } from "@/server/event"
import { LocalModel } from "@novaclaw/schema/local-model"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
  // Remote-access R7: the instance's stable identity — lets a client recognize the SAME
  // instance behind different URLs (mDNS name vs LAN IP vs tunnel).
  instanceID: Schema.String,
})

// Remote-access R7: a point-in-time LAN scan for advertised NovaClaw instances (serve --mdns).
const GlobalDiscovery = Schema.Struct({
  instances: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
      instanceID: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
      /** True when the discovered instance is THIS instance (matching identity). */
      self: Schema.Boolean,
    }),
  ),
})

const UsageItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  bytes: Schema.optional(Schema.Number),
  state: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
})
const MemoryReading = Schema.Union([
  Schema.Struct({
    known: Schema.Literal(true),
    source: Schema.String,
    crosscheck: Schema.String,
    usedBytes: Schema.Number,
    limitBytes: Schema.Number,
  }),
  Schema.Struct({ known: Schema.Literal(false), reason: Schema.String }),
])
const DiskReading = Schema.Union([
  Schema.Struct({
    known: Schema.Literal(true),
    path: Schema.String,
    measuredPath: Schema.String,
    freeBytes: Schema.Number,
    totalBytes: Schema.Number,
  }),
  Schema.Struct({ known: Schema.Literal(false), path: Schema.String, reason: Schema.String }),
])
const GlobalResources = Schema.Struct({
  measuredAt: Schema.Number,
  memory: MemoryReading,
  disks: Schema.Array(DiskReading),
  level: Schema.String,
  ram: Schema.Array(UsageItem),
  disk: Schema.Array(UsageItem),
  localModel: LocalModel.Status,
})

const SyncEventSchemas = EventManifest.Latest.values()
  .flatMap((definition) => {
    if (!definition.durable) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.durable.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventManifest.Latest.values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  discovery: "/global/discovery",
  resources: "/global/resources",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the NovaClaw server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the NovaClaw system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV2.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global NovaClaw configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV2.Info,
        success: described(ConfigV2.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global NovaClaw configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all NovaClaw instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.get("discovery", GlobalPaths.discovery, {
        success: described(GlobalDiscovery, "NovaClaw instances discovered on the local network"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.discovery",
          summary: "Discover LAN instances",
          description: "Scan the local network (mDNS) for NovaClaw instances advertising themselves via serve --mdns.",
        }),
      ),
      HttpApiEndpoint.get("resources", GlobalPaths.resources, {
        success: described(GlobalResources, "Live instance RAM and disk usage"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.resources",
          summary: "Get instance resource usage",
          description:
            "Report host memory pressure plus attributable NovaClaw, SQLite, vector knowledge-base and managed local-model RAM/disk use.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
