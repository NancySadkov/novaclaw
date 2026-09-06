import { InstancePressureEndpoint, MemoryReading } from "@novaclaw/protocol/groups/instance-pressure"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { EventV2 } from "@novaclaw/core/event"
import { EventManifest } from "@/event-manifest"
import { ServerEvent } from "@novaclaw/schema/server-event"
import { LocalModel } from "@novaclaw/schema/local-model"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
  /** Which non-secret credential tier is authoritative for incoming API requests right now. */
  auth: Schema.Struct({
    required: Schema.Boolean,
    source: Schema.Literals(["stored", "launcher", "open"]),
  }),
  // Remote-access R7: the instance's stable identity — lets a client recognize the SAME
  // instance behind different URLs (mDNS name vs LAN IP vs tunnel).
  instanceID: Schema.String,
  /**
   * Community P1: the instance's PUBLIC KEY identity, `nid_…`.
   *
   * `instanceID` is a random ULID — fine for recognising one install across routes, and worthless
   * against a stranger who simply claims the same string. This is the half a peer can verify, and
   * it is what a user shares to be added as someone's contact.
   *
   * ⚠️ Public by definition, and only the public half: the secret never crosses this wire.
   */
  networkID: Schema.String,
  /**
   * Community P3: the X25519 SEALING key, and the identity's signature over it.
   *
   * 🔴 Published HERE because this is where a peer already looks to learn who lives at an address —
   * one fetch teaches both halves. The signature is not decoration: a sealing key taken on trust is
   * one anybody in the path can swap for their own, and the sender would encrypt to the attacker with
   * everything looking correct, because the failure produces perfectly valid ciphertext.
   *
   * ⚠️ Optional in the schema: instances that predate the key mint one on first use, so a peer may
   * legitimately meet an instance that has not been asked for it yet.
   */
  sealingKey: Schema.optional(Schema.String),
  sealingSignature: Schema.optional(Schema.String),
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

/**
 * Community P1 — the instance's identity INCLUDING its secret, for backup.
 *
 * 🔴 This response IS the instance. Anyone holding it can sign as this peer, in a network with no
 * authority to appeal to and no way to revoke.
 *
 * It exists because the alternative is worse: with no registry there is no password reset, so a dead
 * disk without a backup loses the identity, its contacts and its history permanently — the "breaks
 * in your hands" failure a normal person must never meet. That is also why the surface belongs in
 * ordinary Settings rather than Developer mode: hiding it there means the users who most need a
 * backup are exactly the ones who never take one.
 *
 * ⚠️ Honest limit: this is not, and cannot be, unreachable by an agent. An agent with shell access
 * on this host can read the database and the credential key directly. What is enforceable — and
 * what is done — is that NO agent-facing TOOL and no config path exposes it, so obtaining it takes
 * a deliberate act rather than an ordinary capability.
 */
const GlobalIdentityBackup = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  networkID: Schema.String,
  /** The Ed25519 secret, base64url. The whole reason this endpoint is a POST and not a GET. */
  secretKey: Schema.String,
})

const UsageItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  bytes: Schema.optional(Schema.Finite),
  state: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
})
const DiskReading = Schema.Union([
  Schema.Struct({
    known: Schema.Literal(true),
    path: Schema.String,
    measuredPath: Schema.String,
    freeBytes: Schema.Finite,
    totalBytes: Schema.Finite,
  }),
  Schema.Struct({ known: Schema.Literal(false), path: Schema.String, reason: Schema.String }),
])
const GlobalResources = Schema.Struct({
  measuredAt: Schema.Finite,
  memory: MemoryReading,
  disks: Schema.Array(DiskReading),
  /** The WORST verdict across every probe — memory and each disk. */
  level: Schema.String,
  /**
   * Memory's own verdict, so a caller describing memory does not have to borrow `level` (which may
   * be a disk's). ⚠️ This schema ENCODES the response: a field the handler returns but this struct
   * omits is silently dropped on the wire, which is exactly how the first attempt at this shipped a
   * server that computed the value and a client that never saw it.
   */
  memoryLevel: Schema.String,
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
    // THIS ROUTE'S OWN lifecycle arm, declared here because this route is the only thing that emits
    // it: `server/global-lifecycle.ts` puts it on the `GlobalBus` when every instance is disposed,
    // and nothing publishes it through `EventV2.publish`. It sat in the bus manifest until
    // 2026-09-03, which made the instance streams look like they were REFUSING an event rather than
    // never having carried one.
    Schema.Struct({
      id: EventV2.ID,
      type: Schema.Literal(ServerEvent.Disposed.type),
      properties: Schema.Struct({}),
    }),
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
  /**
   * ⚠️ Under `/api/*`, not `/global/*` like its neighbours. Ruling 11: `/api/*` is the ONE contract
   * and the only half free to grow; the `/global/*` paths around it are a legacy surface pinned by
   * a shrink-only ledger. This shipped at `/global/identity/backup` and the sdk-js ledger caught it
   * — a guard the targeted suites I was running never touch.
   */
  identityBackup: "/api/identity/backup",
  identityRestore: "/api/identity/restore",
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
      InstancePressureEndpoint,
      // POST rather than GET, deliberately: a secret does not belong in a URL that proxies, browser
      // history and access logs will happily record, and the method makes taking a copy an act
      // rather than a page load.
      HttpApiEndpoint.post("identityBackup", GlobalPaths.identityBackup, {
        success: described(GlobalIdentityBackup, "The instance identity, including its secret key"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.identity.backup",
          summary: "Export the instance identity",
          description:
            "Export this instance's cryptographic identity INCLUDING its secret key, so it can be restored after a disk failure. Anyone holding the result can sign as this instance; there is no revocation.",
        }),
      ),
      /**
       * 🔴 The other half of backup, which shipped without it — a user could export an identity and
       * had no way to import it, against the spec's "key loss = identity loss, and with no authority
       * there is no reset".
       *
       * ⚠️ `replace` is a REQUIRED act, not a convenience flag. Restoring over an existing identity
       * orphans every contact and channel that knows this peer, and from outside it is independently
       * indistinguishable from the instance being taken over — so it cannot be the default, and the
       * refusal has to be legible enough that the caller knows what they are being asked to confirm.
       */
      HttpApiEndpoint.post("identityRestore", GlobalPaths.identityRestore, {
        payload: Schema.Struct({
          backup: GlobalIdentityBackup,
          replace: Schema.optional(Schema.Boolean),
        }),
        success: described(
          Schema.Struct({ id: Schema.String, networkID: Schema.String }),
          "The identity this instance now holds",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.identity.restore",
          summary: "Restore a backed-up instance identity",
          description:
            "Import an identity exported by `identity/backup`, so an instance rebuilt after a disk failure is the SAME peer to everyone who knew it. Refuses unless `replace` is set when this instance already has an identity: overwriting one orphans every contact and channel that knows it, and there is no authority to appeal to afterwards. Not reachable by an agent — this is a deliberate human action.",
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
