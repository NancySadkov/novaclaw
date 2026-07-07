import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("NOVACLAW_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@novaclaw/RuntimeFlags", {
  pure: bool("NOVACLAW_PURE"),
  disableDefaultPlugins: bool("NOVACLAW_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("NOVACLAW_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("NOVACLAW_DISABLE_EXTERNAL_SKILLS"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("NOVACLAW_DISABLE_CLAUDE_CODE"),
    direct: bool("NOVACLAW_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("NOVACLAW_DISABLE_CLAUDE_CODE"),
    direct: bool("NOVACLAW_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("NOVACLAW_ENABLE_EXA"),
    legacy: bool("NOVACLAW_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("NOVACLAW_ENABLE_PARALLEL"),
    legacy: bool("NOVACLAW_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("NOVACLAW_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("NOVACLAW_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("NOVACLAW_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("NOVACLAW_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalOxfmt: enabledByExperimental("NOVACLAW_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("NOVACLAW_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("NOVACLAW_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("NOVACLAW_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("NOVACLAW_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("NOVACLAW_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("NOVACLAW_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("NOVACLAW_EXPERIMENTAL_NATIVE_LLM"),
  // F1b (2026-07-07): the V2 native session IS the engine — the F0-era
  // NOVACLAW_EXPERIMENTAL_NATIVE_SESSION off-switch is deleted; there is no route
  // back to the legacy V1 prompt stack (it is removed wholesale in F1f).
  experimentalWebSockets: bool("NOVACLAW_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("NOVACLAW_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export const node = LayerNode.make({ service: Service, layer: defaultLayer, deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
