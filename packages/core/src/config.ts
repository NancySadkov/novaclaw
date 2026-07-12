export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { type ParseError, parse } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Permission } from "@novaclaw/schema/permission"
import { Flag } from "./flag/flag"
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
import { ConfigReference } from "./config/reference"
import { ConfigServer } from "./config/server"
import { ConfigStrict } from "./config/strict"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigWatcher } from "./config/watcher"

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
  offline: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Offline/airgap mode (OFF-A): outbound HTTP restricted to loopback + configured provider hosts, fail-closed. GLOBAL config only — the chokepoint is machine-level",
  }),
  kb: Schema.Struct({
    url: Schema.String.pipe(Schema.optional).annotate({
      description: "Base URL of an external KB server implementing the same /kb API; unset = the built-in store",
    }),
  })
    .pipe(Schema.optional)
    .annotate({ description: "Knowledge-base facade (KB-A): consumers read this to find the KB endpoint" }),
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
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
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
    const names = ["config.json", "novaclaw.json", "novaclaw.jsonc"]
    const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
    const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return

      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return

      const info = Option.getOrUndefined(decodeInfo(input))
      if (!info) return
      return new Document({ type: "document", path: filepath, info })
    })

    const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      return [
        ...(yield* Effect.forEach(names, (file) => loadFile(path.join(directory, file))).pipe(
          Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
        )),
        new Directory({ type: "directory", path: directory }),
      ]
    })

    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    // Read configuration once when this location opens. Later calls reuse these
    // values until the location is reopened.
    const discovered = locationIsGlobal
      ? []
      : yield* fs
          .up({
            targets: [".novaclaw", ...names.toReversed()],
            start: location.directory,
            stop: location.project.directory,
          })
          .pipe(Effect.orDie)
    const directories = [
      globalDirectory,
      ...discovered
        .filter((item) => path.basename(item) === ".novaclaw")
        .toReversed()
        .map((directory) => AbsolutePath.make(directory)),
    ]
    // A config closer to the opened directory should win over one higher up.
    // Search starts nearby, so reverse the results before applying them.
    const directPaths = discovered.filter((item) => path.basename(item) !== ".novaclaw").toReversed()
    const direct = yield* Effect.forEach(directPaths, loadFile).pipe(
      Effect.orDie,
      Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
    )
    const supplementary = yield* Effect.forEach(directories, loadDirectory).pipe(Effect.orDie)
    // NOVACLAW_CONFIG_CONTENT is a first-class inline config source — the SDK's server launcher
    // passes app config exclusively through it, and headless/test embeddings rely on it. Mirrors
    // the V1 loader (which merges it as a "local" source after every file source): applied LAST =
    // most specific. Without this, such an instance sees none of its configured agents/permissions
    // on the V2 path. (catalog-seed.ts imports the same source for the provider catalog.)
    const inline = (() => {
      const text = Flag.NOVACLAW_CONFIG_CONTENT
      if (!text) return undefined
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return undefined
      const info = Option.getOrUndefined(decodeInfo(input))
      if (!info) return undefined
      return new Document({ type: "document", path: "NOVACLAW_CONFIG_CONTENT", info })
    })()
    // Apply general settings first and more specific settings last:
    // global config, project files, then `.novaclaw` files, then the inline env config.
    const configs = [
      ...(supplementary[0] ?? []),
      ...direct,
      ...supplementary.slice(1).flat(),
      ...(inline ? [inline] : []),
    ]
    // Rules use the opposite order so a user-global rule can override a
    // repository rule. Statement order inside each file stays unchanged.
    yield* policy.load(
      configs
        .filter((config): config is Document => config.type === "document")
        .toReversed()
        .flatMap((config) => config.info.experimental?.policies ?? []),
    )

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        return configs
      }),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node],
})
