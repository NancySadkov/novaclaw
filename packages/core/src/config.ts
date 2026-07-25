export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Permission } from "@novaclaw/schema/permission"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { Policy } from "./policy"
import { AbsolutePath } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCompaction } from "./config/compaction"
import { ConfigCommand } from "./config/command"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigAdhocTools } from "./config/adhoc-tools"
import { ConfigAffective } from "./config/affective"
import { ConfigIntrospection } from "./config/introspection"
import { ConfigMCP } from "./config/mcp"
import { ConfigPersona } from "./config/persona"
import { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigProviderPreset } from "./config/provider-preset"
import { ConfigReference } from "./config/reference"
import { ConfigServer } from "./config/server"
import { ConfigStrict } from "./config/strict"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigWatcher } from "./config/watcher"
import { SettingsConfigSeed } from "./settings-config-seed"
import { SettingsConfigStore } from "./settings-config-store"

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  autoupdate: Schema.Union([Schema.Boolean, Schema.Literal("notify")])
    .pipe(Schema.optional)
    .annotate({
      description: "Automatically update or notify when a new version is available",
    }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: "Username displayed in conversations and used for telemetry identity",
  }),
  expertise: Schema.Literals(["normal", "advanced", "developer"])
    .pipe(Schema.optional)
    .annotate({
      description:
        "The user's expertise level, mirrored from the UI (uix.md §6) so the model can meet them there — 'normal' adds a plain-language system hint",
    }),
  server: ConfigServer.Info.pipe(Schema.optional).annotate({
    description: "Server configuration for `novaclaw serve` and web commands (port/hostname/mDNS/CORS)",
  }),
  permissions: Permission.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  paranoid: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Require explicit permission before an agent READS anything outside its project folder. Off by default: reading outside the folder is normal work (a compiler, an SDK, a system header). Writing outside is guarded regardless of this setting.",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  formatter: ConfigFormatter.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output truncation thresholds",
  }),
  mcp: ConfigMCP.Info.pipe(Schema.optional).annotate({
    description: "MCP server configuration",
  }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior",
  }),
  persona: ConfigPersona.Info.pipe(Schema.optional).annotate({
    description: "Persona baseline prepended to every agent's system prompt (B3)",
  }),
  user_profile: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.optional).annotate({
      description:
        "When true, the assistant may look up this profile on demand via the `profile` tool (instead of it being absent). Off = the profile is not shared with the model (B4).",
    }),
    name: Schema.String.pipe(Schema.optional).annotate({ description: "The user's name" }),
    about: Schema.String.pipe(Schema.optional).annotate({
      description: "Background / 'about me' the assistant should know (role, expertise, preferences)",
    }),
  })
    .pipe(Schema.optional)
    .annotate({
      description:
        "User profile the model can read (name + background). Delivered on demand through the `profile` tool when enabled (B4)",
    }),
  introspection: ConfigIntrospection.Info.pipe(Schema.optional).annotate({
    description: "Introspection mode — a judge model periodically checks whether the session is stuck (P2)",
  }),
  adhoc_tools: ConfigAdhocTools.Info.pipe(Schema.optional).annotate({
    description: "Ad-hoc tool recipes: name + description listed in the system prompt, manual pulled on demand (P4)",
  }),
  affective: ConfigAffective.Info.pipe(Schema.optional).annotate({
    description: "Affective mode — emotion-modulated sampling + loop-breaking nudges (P3)",
  }),
  strict: ConfigStrict.Info.pipe(Schema.optional).annotate({
    description: "Strict mode — the Juvenile Harness posture for weak/local models: harness-owned decomposition, per-step verification, recovery (jh.md; E6)",
  }),
  instances: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({ description: "Peer name (also keys the NOVACLAW_INSTANCE_<NAME>_* env vars)" }),
      url: Schema.String.annotate({ description: "The peer's base URL, e.g. http://127.0.0.1:4097" }),
      token: Schema.String.pipe(Schema.optional).annotate({
        description: "The peer's incoming API token (its server.password)",
      }),
    }),
  )
    .pipe(Schema.optional)
    .annotate({
      description:
        "P2P: peer NovaClaw instances this instance's AGENTS may drive over HTTP (full API access — sessions, registry, config). Surfaced to models as env vars in bash plus a system-prompt line.",
    }),
  folder_bookmarks: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description:
      "User-pinned folder bookmarks shown in the directory picker's rail (absolute paths on the " +
      "instance host). Instance-wide, exported with config, and agent-editable via PATCH /config " +
      "(self-healing: an agent can add/fix pins; the array replaces wholesale per the patch contract).",
  }),
  virtualFs: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "FS-3: force the app-private virtual filesystem root (phones/sandboxes without a browsable FS); the NOVACLAW_VIRTUAL_FS env flag also enables it",
  }),
  offline: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Offline/airgap mode (OFF-A): outbound HTTP restricted to loopback + configured provider hosts, fail-closed. GLOBAL config only — the chokepoint is machine-level",
  }),
  // Dependability P6: the telemetry CONTRACT. No upload system exists today — nothing is ever sent
  // regardless of this value; the field gates any future crash/usage reporting (which must obey the
  // scrub spec: no user content, ever) and airgap mode force-disables it independently.
  telemetry: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.optional).annotate({
      description: "Allow future crash/usage telemetry uploads (default: true; offline mode forces off)",
    }),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Telemetry consent — gates any future crash/usage reporting; no upload exists today",
    }),
  memory: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.optional).annotate({
      description:
        "Remember things across chats (graph memory / KB-G). Default ON; OFF = the runtime flows stand down (no auto-recall, auto-extraction, `kb` tool, or consolidation) — a privacy switch. The engine still needs the NOVACLAW_KB_MEMORY env to run at all",
    }),
    rerank: Schema.Boolean.pipe(Schema.optional).annotate({
      description:
        "Let the MODEL order recalled memories (it reads the wording, so a definitive older statement can outrank a newer offhand musing — measured 4/4 vs 1/4 for metadata ordering). Costs one short call per turn (~0.4s at 5 candidates). Default ON; off = metadata ordering only",
    }),
    embedding: Schema.Struct({
      url: Schema.String.pipe(Schema.optional).annotate({
        description:
          "OpenAI-compatible embeddings base URL for the LAN embedding device (e.g. http://spark:8001/v1). Unset = keyword-only (FTS) memory search",
      }),
      model: Schema.String.pipe(Schema.optional).annotate({
        description: "Embedding model id as served (e.g. qwen3-embedding). Its width must match the graph's vector column (1024)",
      }),
    })
      .pipe(Schema.optional)
      .annotate({
        description:
          "The memory VECTOR leg (measured: hybrid vector+FTS retrieval 85% vs keyword-only 77%). LAN-local, airgap-safe; unreachable = degrade to FTS, never fail",
      }),
  })
    .pipe(Schema.optional)
    .annotate({ description: "Graph-memory (KB-G) privacy switch — the lay Memory on/off (notes/kb-graph-plan.md §5)" }),
  quality: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.optional),
    cadence: Schema.Finite.pipe(Schema.optional).annotate({
      description: "Run the whole-module typecheck every N writes (default 2)",
    }),
    testTimeout: Schema.Finite.pipe(Schema.optional).annotate({
      description: "Hard timeout for the test gate in ms (default 300000)",
    }),
    commands: Schema.Struct({
      syntax: Schema.String.pipe(Schema.optional).annotate({ description: "Per-file syntax check ({file} placeholder)" }),
      check: Schema.String.pipe(Schema.optional).annotate({ description: "Per-file incremental verifier ({file})" }),
      typecheck: Schema.String.pipe(Schema.optional).annotate({ description: "Whole-module type/compile check" }),
      test: Schema.String.pipe(Schema.optional).annotate({ description: "Test-gate command" }),
      lint: Schema.String.pipe(Schema.optional).annotate({ description: "Structural/lint pass" }),
    }).pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description:
        "Quality Enforcement mode (QE): provisioned check commands run at write/turn boundaries; failures steer the agent to fix and re-run — per-project override is first-class",
    }),
  web_search: Schema.Struct({
    searxngUrl: Schema.String.pipe(Schema.optional).annotate({
      description: "A SearXNG instance URL (e.g. http://localhost:8080). When set it REPLACES the built-in engines.",
    }),
    disabledEngines: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
      description: "Built-in engine ids to turn off (currently: duckduckgo, wikipedia) — for one that starts misbehaving.",
    }),
    timeoutMs: Schema.Finite.pipe(Schema.optional).annotate({ description: "Per-engine timeout in ms (default 8000)" }),
    // The web traffic governor (core/web/fetch-pace.ts). Governs ALL outbound web reads — search AND
    // article fetches — not just search; it lives here because this is the user-facing home for web
    // access. ⚠️ Loosening these is how a runaway agent gets the USER'S ip banned: the defaults keep our
    // traffic in the range of a person reading articles, which is the whole basis for treating robots.txt
    // as informational rather than binding.
    throttle: Schema.Struct({
      hostIntervalMs: Schema.Finite.pipe(Schema.optional).annotate({
        description: "Sustained delay between reads of the SAME site, in ms (default 4000). Lower = more bot-like.",
      }),
      burst: Schema.Finite.pipe(Schema.optional).annotate({
        description: "Reads allowed back-to-back per site before the delay applies (default 3) — a person opening a few tabs.",
      }),
      perHostConcurrency: Schema.Finite.pipe(Schema.optional).annotate({
        description: "Simultaneous requests to ONE site (default 1). Above 1 is swarming and is the fastest way to get blocked.",
      }),
      dailyPerHost: Schema.Finite.pipe(Schema.optional).annotate({
        description: "Reads per site per UTC day (default 150) — a heavy human reader, far below mirroring a site.",
      }),
      sameUrlLimit: Schema.Finite.pipe(Schema.optional).annotate({
        description: "Refuse re-fetching one URL more than this many times per session (default 3) — the fetch-loop guard.",
      }),
    })
      .pipe(Schema.optional)
      .annotate({
        description:
          "Outbound web-read pacing + per-site daily caps. Defaults imitate a person reading; loosening them risks the user's IP being blocked.",
      }),
  })
    .pipe(Schema.optional)
    .annotate({
      description:
        "Web search: a power user's own SearXNG when set, else NovaClaw's built-in in-process meta-search (no setup, offline-gated). GLOBAL config only.",
    }),
  skills: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  instructions: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs supplying ambient instructions",
  }),
  references: ConfigReference.Info.pipe(Schema.optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  plugins: ConfigPlugin.Plugins.pipe(Schema.optional).annotate({
    description: "Ordered external plugin packages to load",
  }),
  experimental: ConfigExperimental.Experimental.pipe(Schema.optional),
  provider_presets: Schema.Record(Schema.String, ConfigProviderPreset.Info)
    .pipe(Schema.optional)
    .annotate({
      description:
        "Overrides/additions to the BUILT-IN provider import presets (Settings → Models → Add models). " +
        "Merged field-wise over the builtins by id — e.g. {\"anthropic\":{\"baseURL\":\"https://…\"}} repairs a " +
        "moved vendor endpoint at RUNTIME (self-healing: any working model can PATCH /config with this key; " +
        "no config-file edits, no rebuild). Unknown ids add new presets; hidden:true hides one. " +
        "Already-imported providers are repaired via providers.<id>.api.url instead — presets shape future imports only.",
    }),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
  // Models-primary (notes/models-primary-plan.md P1): the flat successor to `providers` — a map
  // of models keyed by id, each with its OWN endpoint `url` + params + `tier`. Decoded in
  // PARALLEL with `providers` (both accepted) until P6 retires the nested path. Inert until the
  // P2 seed reads it; additive here so authored configs and the equivalence gate can use it.
  models: Schema.Record(Schema.String, ConfigProvider.ModelEntry).pipe(Schema.optional).annotate({
    description: "Models-primary flat model map (id → { url, params, tier, … }); successor to nested providers",
  }),
  // Transitional — dies with the models-primary data model (a model is just a URL; there is
  // no first-class provider entity). Promoted into V2 (F1d D2) because the Settings UI and the
  // `/provider` filter still read these by name today.
  disabled_providers: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Providers to disable that would otherwise load automatically",
  }),
  enabled_providers: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "When set, ONLY these providers are enabled; all others are ignored",
  }),
}) {}

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Config") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service

    // Config→SQLite 8c: jsonc is NOT a runtime config source. The one config DOCUMENT is
    // synthetic — the instance-wide settings store's snapshot (read once per location boot;
    // the per-subsystem stores feed their own loaders directly). The directory walk-up
    // SURVIVES for Directory entries only: the D2 filesystem resources (markdown agents/
    // commands, `skill(s)/` dirs, plugin files) ride them. jsonc files are read exclusively
    // by the boot-time import seeds (isEmpty-gated, server startup) and the explicit Import
    // button — import/export wire format, never resolution.
    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    const discovered = locationIsGlobal
      ? []
      : yield* fs
          .up({
            targets: [".novaclaw"],
            start: location.directory,
            stop: location.root,
          })
          .pipe(Effect.orDie)
    const directories: Entry[] = [
      new Directory({ type: "directory", path: globalDirectory }),
      ...discovered
        .filter((item) => path.basename(item) === ".novaclaw")
        .toReversed()
        .map((directory) => new Directory({ type: "directory", path: AbsolutePath.make(directory) })),
    ]

    const settingsStore = yield* SettingsConfigStore.Service
    const settingsInfo = SettingsConfigSeed.settingsInfoFromStore(yield* settingsStore.all())
    const allConfigs = settingsInfo
      ? [...directories, new Document({ type: "document", info: settingsInfo })]
      : directories

    // Policies come from the store-backed synthetic document; the import seed preserved the
    // historical reversed-concat order, so loading them verbatim keeps rule precedence.
    yield* policy.load(settingsInfo?.experimental?.policies ? [...settingsInfo.experimental.policies] : [])

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        return allConfigs
      }),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node, SettingsConfigStore.node],
})
