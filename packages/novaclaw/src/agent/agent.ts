import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { PermissionRuleset } from "@novaclaw/schema/permission-ruleset"
import { Config } from "@/config/config"
import { serviceUse } from "@novaclaw/core/effect/service-use"

import { LLM, LLMError, Message, SystemPart } from "@novaclaw/llm"
import { Catalog } from "@novaclaw/core/catalog"
import { Integration } from "@novaclaw/core/integration"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { llmClient } from "@novaclaw/core/effect/app-node-platform"
import { COMPACTION_SYSTEM } from "@novaclaw/core/compaction-system-prompt"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@novaclaw/core/global"
import path from "path"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { AbsolutePath, type DeepMutable } from "@novaclaw/core/schema"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ModelV2 } from "@novaclaw/core/model"
import { AgentV2 } from "@novaclaw/core/agent"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Location } from "@novaclaw/core/location"
import { PluginV2 } from "@novaclaw/core/plugin"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionRuleset.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

// Built-in agent ids — mirrors the `native: true` set the `agents` map defines
// below. Used to restore the V1 `native` flag when projecting a V2 agent.
const NATIVE_IDS = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"])

// Project an authoritative V2 `AgentV2.Info` onto this legacy V1 `Info` wire shape.
// V2 (`@novaclaw/v2/Agent`) is the store the RUNNER reads and is a SUPERSET —
// built-ins + config agents + PLUGIN-registered agents — so listing through this
// projection is what makes plugin-contributed agents visible in `/agent` + the CLI
// (they run today but never appeared, because those read this V1-shaped store).
export function fromV2(info: AgentV2.Info): Info {
  const body = info.request?.body ?? {}
  const topP = body["top_p"]
  const temperature = body["temperature"]
  return {
    name: info.id,
    description: info.description,
    mode: info.mode,
    native: NATIVE_IDS.has(info.id) || undefined,
    hidden: info.hidden,
    topP: typeof topP === "number" ? topP : undefined,
    temperature: typeof temperature === "number" ? temperature : undefined,
    color: info.color,
    permission: (info.permissions ?? []).map((r) => ({ permission: r.action, pattern: r.resource, action: r.effect })),
    model: info.model ? { modelID: info.model.id, providerID: info.model.providerID } : undefined,
    variant: info.model?.variant,
    prompt: info.system,
    options: body,
    steps: info.steps,
  }
}

// List all agents from the authoritative V2 store, projected onto the V1 shape.
// Runs INSIDE a location context (needs `AgentV2` + `PluginV2`). The V2 agent store
// is populated by the built-in `agent` (built-ins) and `config-agent` (config +
// markdown) plugins during location startup, so a freshly-resolved location races
// an empty read — await those plugins first (same pattern as the reference wait in
// the state builder below). External-plugin agents rely on the location being fully
// booted (the serve path), which the runner also depends on.
export const listV2 = Effect.gen(function* () {
  const plugins = yield* PluginV2.Service
  yield* plugins.wait(PluginV2.ID.make("agent"))
  yield* plugins.wait(PluginV2.ID.make("config-agent"))
  const agents = yield* AgentV2.Service.use((svc) => svc.all())
  return agents.map(fromV2)
})

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

// Raised when `generate` can't find a usable model — either the requested
// `provider/model` isn't in the catalog, or no default model is configured.
export class ModelUnconfiguredError extends Schema.TaggedErrorClass<ModelUnconfiguredError>()(
  "Agent.ModelUnconfiguredError",
  { requested: Schema.optional(Schema.String) },
) {
  override get message() {
    return this.requested ? `Requested model is not available: ${this.requested}` : "No model is configured"
  }
}

// Raised when the model's response can't be parsed/decoded into the agent config
// JSON shape (`{ identifier, whenToUse, systemPrompt }`).
export class GenerateOutputError extends Schema.TaggedErrorClass<GenerateOutputError>()("Agent.GenerateOutputError", {
  detail: Schema.String,
}) {
  override get message() {
    return `The model did not return a valid agent configuration: ${this.detail}`
  }
}

export type GenerateError =
  | ModelUnconfiguredError
  | GenerateOutputError
  | SessionRunnerModel.UnsupportedApiError
  | Integration.AuthorizationError
  | LLMError

// Small-model tolerant JSON extraction: strip a ```json fence if present, else
// take the outermost `{...}` block — so a stray reasoning preamble or fences
// (despite the "return ONLY the JSON" instruction) still parse.
const extractJsonObject = (text: string): string => {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const body = (fence ? fence[1] : trimmed).trim()
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  return start !== -1 && end > start ? body.slice(start, end + 1) : body
}

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    GenerateError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Agent") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const locations = yield* LocationServiceMap.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        // ⚠️ **Only `*`, `skill` and `task` are ever read out of this ruleset.** It is not the gate —
        // `packages/novaclaw/src/permission/index.ts` says so at the top, and it is structural rather
        // than a convention: `packages/core` cannot import `packages/novaclaw`, so the live evaluator
        // (`core/src/permission.ts`) never sees what is written here. The two consumers are
        // `skill/index.ts` (`evaluate("skill", …)`) and `tool/truncate.ts` (`evaluate("task", …)`).
        // Any other action written below is a rule nobody reads.
        //
        // 🔴 That is why the `external_directory` whitelist that used to sit here is gone (2026-09-04)
        // along with the `skillDirs`/`referenceDirs` walk that built it and the
        // "Ensure Truncate.GLOB is allowed" loop that appended to it. None of them granted anything.
        // The grants they were imitating are real and live one package over, in
        // `core/src/plugin/agent.ts`'s `floor({scratchDirs: SCRATCH_DIRS})`, which allows
        // `external_directory_read` and `external_directory_write` on the truncation glob and the temp
        // dir and is pinned by `core/test/permission-baseline.test.ts`. Deleting the imitation loses
        // no capability; it removes a second, false answer to who may write outside the folder.
        // ⚠️ It also removed this service's only `PluginV2.wait("core/config-reference")`. That wait
        // existed to enumerate reference dirs for the inert whitelist and appeared nowhere else in the
        // tree — every other `Reference.list()` caller (`server/src/handlers/reference.ts`,
        // `core/src/reference/guidance.ts`) runs without it. It was this dead path's ordering
        // dependency, not a shared one.
        //
        // Do not add an action here expecting it to gate. Add it to the V2 floor.
        const defaults = Permission.fromConfig({
          "*": "allow",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors the standard Node ignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        // V2 config `permissions` is an ordered Ruleset ({action,resource,effect}); the V1 agent service
        // works in the {permission,pattern,action} ruleset shape, so remap the fields.
        const user = (cfg.permissions ?? []).map((r) => ({
          permission: r.action,
          pattern: r.resource,
          action: r.effect,
        }))

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                task: {
                  general: "deny",
                },
                edit: {
                  "*": "deny",
                  [path.join(".novaclaw", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                // ⚠️ `grep`/`glob`/`list` were granted here and are gone (2026-07-30). Nothing spends
                // them: `list` never named a tool or an action anywhere in the tree, and glob/grep were
                // remapped onto the single `explore` action, which the V2 tools assert through
                // `PermissionV2` — not through this legacy ruleset. No `explore` grant replaces them
                // for the same reason: the only names this island actually evaluates are `task`
                // (`tool/truncate.ts`) and `skill` (`skill/index.ts`), so a grant here would be one
                // more rule nobody reads. The V2 explore subagent's grants live in
                // `core/src/plugin/agent.ts` and are pinned by `core/test/permission-baseline.test.ts`.
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: COMPACTION_SYSTEM,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [key, value] of Object.entries(cfg.agents ?? {})) {
          if (value.disabled) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          // V2 ConfigAgent.Info: prompt→system, disable→disabled, permission(dict)→permissions(ruleset),
          // and options/temperature/top_p are folded into request.body (no top-level name — it is the key).
          if (value.model) item.model = ModelV2.parse(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.system ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = (value.request?.body?.temperature as number | undefined) ?? item.temperature
          item.topP = (value.request?.body?.top_p as number | undefined) ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.request?.body ?? {})
          item.permission = Permission.merge(
            item.permission,
            (value.permissions ?? []).map((r) => ({ permission: r.action, pattern: r.resource, action: r.effect })),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const directory = yield* InstanceState.directory
        const system = [PROMPT_GENERATE]
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // Resolve the target model natively from the V2 catalog + integration
        // credentials and run one structured generation through `@novaclaw/llm`
        // (a forced `generate_object` tool call). The V1 provider layer's AI-SDK
        // `generateObject`/`LanguageModelV3` path is gone. Location-scoped
        // services (Catalog, Integration) plus the hoisted global LLMClient come
        // from the instance-directory's location graph.
        return yield* Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          const integrations = yield* Integration.Service

          const selected = input.model
            ? (yield* catalog.model.available()).find(
                (m) => m.providerID === input.model!.providerID && m.id === input.model!.modelID,
              )
            : yield* Effect.gen(function* () {
                const preferred = yield* catalog.model.default()
                if (preferred && SessionRunnerModel.supported(preferred)) return preferred
                return (yield* catalog.model.available()).find(SessionRunnerModel.supported)
              })
          if (!selected)
            return yield* new ModelUnconfiguredError({
              requested: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
            })

          const provider = yield* catalog.provider.get(selected.providerID)
          const connection = yield* integrations.connection.active(
            provider?.integrationID ?? Integration.ID.make(selected.providerID),
          )
          const credential = connection ? yield* integrations.connection.resolve(connection) : undefined
          const model = yield* SessionRunnerModel.fromCatalogModel(selected, credential)

          // One-shot text generation + JSON parse rather than a forced synthetic
          // tool call: the canonical qwen vLLM build 500s on a forced `tool_choice`
          // (guided decoding), so we prompt for the JSON object (the system prompt
          // already instructs "return ONLY the JSON") and parse the response.
          const response = yield* LLM.generate(
            LLM.request({
              model,
              system: system.map((content) => SystemPart.make(content)),
              messages: [
                Message.user(
                  `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing
                    .map((i) => i.name)
                    .join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
                ),
              ],
              generation: { temperature: 0.3 },
            }),
          )

          const parsed = yield* Effect.try({
            try: () => JSON.parse(extractJsonObject(response.text)) as unknown,
            catch: (error) =>
              new GenerateOutputError({ detail: error instanceof Error ? error.message : String(error) }),
          })
          return yield* Schema.decodeUnknownEffect(GeneratedAgent)(parsed).pipe(
            Effect.mapError((error) => new GenerateOutputError({ detail: String(error) })),
          )
        }).pipe(
          // Catalog + Integration come from the instance-directory's location graph;
          // LLMClient is a global service the location graph consumes internally but
          // does not re-export, so provide its self-contained node chain (which keeps
          // the OFF-A offline HttpClient guard) directly for this one call.
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
          Effect.provide(AppNodeBuilder.build(llmClient)),
        )
      }),
    })
  }),
)

// ⚠️ The map MUST be the ONE server-wide instance (ServerLocationServiceMap) — a private map
// here splits per-location state (pending permission asks) from the V2 runner's locations.
export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(ServerLocationServiceMap.layer),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Skill.node, ServerLocationServiceMap.node],
})

export * as Agent from "./agent"
