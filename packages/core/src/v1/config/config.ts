export * as ConfigV1 from "./config"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"
import { ConfigExperimental } from "../../config/experimental"
import { ConfigReference } from "../../config/reference"
import { ConfigAgentV1 } from "./agent"
import { ConfigAttachmentV1 } from "./attachment"
import { ConfigCommandV1 } from "./command"
import { ConfigFormatterV1 } from "./formatter"
import { ConfigLayoutV1 } from "./layout"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigPluginV1 } from "./plugin"
import { ConfigProviderV1 } from "./provider"
import { ConfigServerV1 } from "./server"
import { ConfigSkillsV1 } from "./skills"

export type Layout = ConfigLayoutV1.Layout

export const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

const LogLevelRef = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.optional(Schema.String).annotate({ description: "Default shell to use for terminal and bash tool" }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  server: Schema.optional(ConfigServerV1.Server).annotate({
    description: "Server configuration for novaclaw serve and web commands",
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info)).annotate({
    description: "Command configuration, see https://novaclaw.app/docs/commands",
  }),
  skills: Schema.optional(ConfigSkillsV1.Info).annotate({ description: "Additional skill folder paths" }),
  references: Schema.optional(ConfigReference.Info).annotate({
    description: "Named git or local directory references",
  }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "@deprecated Use 'references' field instead. Named git or local directory references",
  }),
  watcher: Schema.optional(Schema.Struct({ ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))) })),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPluginV1.Spec))),
  // F1f decision ④ (2026-07-07): the share feature is deleted — the `share`/`autoshare`/
  // `enterprise` keys are gone from the schema; old files carrying them decode fine (unknown
  // keys are ignored) and the values are simply inert.
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(Schema.String).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({ build: Schema.optional(ConfigAgentV1.Info), plan: Schema.optional(ConfigAgentV1.Info) }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        plan: Schema.optional(ConfigAgentV1.Info),
        build: Schema.optional(ConfigAgentV1.Info),
        general: Schema.optional(ConfigAgentV1.Info),
        explore: Schema.optional(ConfigAgentV1.Info),
        title: Schema.optional(ConfigAgentV1.Info),
        summary: Schema.optional(ConfigAgentV1.Info),
        compaction: Schema.optional(ConfigAgentV1.Info),
      }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "Agent configuration, see https://novaclaw.app/docs/agents" }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProviderV1.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  mcp: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([ConfigMCPV1.Info, Schema.Struct({ enabled: Schema.Boolean })])),
  ).annotate({ description: "MCP (Model Context Protocol) server configurations" }),
  formatter: Schema.optional(ConfigFormatterV1.Info).annotate({
    description:
      "Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  layout: Schema.optional(ConfigLayoutV1.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  attachment: Schema.optional(ConfigAttachmentV1.Info).annotate({
    description: "Attachment processing configuration, including image size limits and resizing behavior",
  }),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Maximum lines of tool output before it is truncated and saved to disk (default: 2000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 51200)",
      }),
    }),
  ).annotate({
    description:
      "Thresholds for truncating tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned.",
  }),
  persona: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Prepend the persona baseline to every agent's system prompt (default: true)",
      }),
      name: Schema.optional(Schema.String).annotate({
        description: "Persona name substituted into the default prompt (default: Nova)",
      }),
      prompt: Schema.optional(Schema.String).annotate({
        description: "Replace the default persona prompt wholesale",
      }),
    }),
  ).annotate({ description: "Persona baseline prepended to every agent's system prompt" }),
  introspection: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Periodically ask an introspecting model whether the session is stuck (default: false)",
      }),
      cadence: Schema.optional(Schema.Number).annotate({
        description: "Judge every N continuation steps within a turn drain (default: 3)",
      }),
      model: Schema.optional(Schema.String).annotate({
        description: 'Introspecting model as "provider/model" (default: the active turn\'s model)',
      }),
      prompt: Schema.optional(Schema.String).annotate({
        description: "The question the judge is asked about the recent context (default: the stuck/looping check)",
      }),
      interjection: Schema.optional(Schema.String).annotate({
        description: 'Text injected into the introspected session when the judge answers "yes"',
      }),
      generateInterjection: Schema.optional(Schema.Boolean).annotate({
        description:
          "Let the introspecting model WRITE the interjection instead of using the fixed text (default: false)",
      }),
    }),
  ).annotate({ description: "Introspection mode — a judge model periodically checks whether the session is stuck" }),
  adhoc_tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String.annotate({ description: "Tool name (lowercase slug) listed in the system prompt" }),
        description: Schema.String.annotate({
          description: "One-line description shown beside the name (the model decides from this alone)",
        }),
        manual: Schema.String.annotate({
          description: "Free-text manual the model pulls on demand: the API shape plus 1-2 curl/shell examples",
        }),
        enabled: Schema.optional(Schema.Boolean).annotate({
          description: "Set false to hide the recipe without deleting it",
        }),
      }),
    ),
  ).annotate({
    description: "Ad-hoc tool recipes: name + description listed in the system prompt, manual pulled on demand",
  }),
  affective: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "Emotion-modulated sampling + loop-breaking nudges (default: false)",
      }),
      temperature: Schema.optional(Schema.Number).annotate({
        description: "Calm-baseline temperature when the model config sets none (default: 0.7)",
      }),
      extended: Schema.optional(Schema.Boolean).annotate({
        description: "Also modulate extended params (top_k) — for engines that accept them (default: false)",
      }),
    }),
  ).annotate({ description: "Affective mode — emotion-modulated sampling + loop-breaking nudges" }),
  user_profile: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean).annotate({
        description: "When true, share this profile with the model; off = the profile is not shared (B4)",
      }),
      name: Schema.optional(Schema.String).annotate({ description: "The user's name" }),
      about: Schema.optional(Schema.String).annotate({
        description: "Background / 'about me' the assistant should know (role, expertise, preferences)",
      }),
    }),
  ).annotate({
    description: "User profile the model can read (name + background); shared only when enabled (B4)",
  }),
  offline: Schema.optional(Schema.Boolean).annotate({
    description:
      "Offline/airgap mode (OFF-A): outbound HTTP restricted to loopback + configured provider hosts, fail-closed. Only honored in the GLOBAL config",
  }),
  kb: Schema.optional(
    Schema.Struct({
      url: Schema.optional(Schema.String).annotate({
        description: "Base URL of an external KB server implementing the same /kb API; unset = the built-in store",
      }),
    }),
  ).annotate({ description: "Knowledge-base facade (KB-A): consumers read this to find the KB endpoint" }),
  quality: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      cadence: Schema.optional(Schema.Number).annotate({
        description: "Run the whole-module typecheck every N writes (default 2)",
      }),
      testTimeout: Schema.optional(Schema.Number).annotate({
        description: "Hard timeout for the test gate in ms (default 300000)",
      }),
      commands: Schema.optional(
        Schema.Struct({
          syntax: Schema.optional(Schema.String).annotate({ description: "Per-file syntax check ({file})" }),
          check: Schema.optional(Schema.String).annotate({ description: "Per-file incremental verifier ({file})" }),
          typecheck: Schema.optional(Schema.String).annotate({ description: "Whole-module type/compile check" }),
          test: Schema.optional(Schema.String).annotate({ description: "Test-gate command" }),
          lint: Schema.optional(Schema.String).annotate({ description: "Structural/lint pass" }),
        }),
      ),
    }),
  ).annotate({
    description:
      "Quality Enforcement mode (QE): provisioned check commands run at write/turn boundaries; failures steer the agent to fix and re-run",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description: "Enable pruning of old tool outputs (default: false)",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction (default: 2)",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Timeout in milliseconds for model context protocol (MCP) requests",
      }),
      policies: Schema.optional(Schema.mutable(Schema.Array(ConfigExperimental.Policy))).annotate({
        description: "Policy statements applied to supported resources, such as provider access",
      }),
    }),
  ),
}).annotate({ identifier: "Config" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
