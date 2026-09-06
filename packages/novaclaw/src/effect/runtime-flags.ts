import { Cause, Config, ConfigProvider, Context, Effect, Exit, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"
import { Log } from "@novaclaw/schema/log"

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

// `NOVACLAW_PURE` is deliberately ABSENT here. It gates external-plugin loading, which now lives in
// core's V2 loader (`core/config/plugin/external.ts`) and reads `Flag.NOVACLAW_PURE` directly — one
// reader, at the seam it protects. `NOVACLAW_DISABLE_DEFAULT_PLUGINS` is gone with the V1 arm: it
// gated an internal-plugin list that had been empty since the NovaClaw detach.
/**
 * The flag declarations, hoisted out of the `Service` call so the resilient resolver below can walk
 * them field by field. `Service` is still the only consumer that decides the service SHAPE.
 */
const fields = {
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
} as const

export class Service extends ConfigService.Service<Service>()("@novaclaw/RuntimeFlags", fields) {}

export type Info = Context.Service.Shape<typeof Service>

/** The provider that answers "nothing is set", i.e. the source of every flag's declared default. */
const noEnvironment = ConfigProvider.fromUnknown({})

/** One flag that could not be read from the environment, and what NovaClaw is using instead. */
export interface FlagFault {
  /** The service field, e.g. `enableExa`. */
  readonly field: string
  /** Every environment variable that flag reads. Recorded from the `Config`, never hand-kept. */
  readonly variables: readonly string[]
  /** The parse failure, rendered — it names the variable and the values that would have been legal. */
  readonly cause: string
}

export interface Resolution {
  readonly flags: Info
  readonly faults: readonly FlagFault[]
}

/**
 * Which environment variables a flag reads, measured by resolving it against a provider that answers
 * `undefined` for everything and remembers each path it was asked for.
 *
 * Derived rather than declared on purpose: a hand-written name list beside the `Config` definitions
 * would drift the first time somebody adds a second variable to a composite flag, and it would drift
 * silently, in the one message a user with a typo'd variable is going to read.
 */
const variablesOf = (config: Config.Config<unknown>): readonly string[] => {
  const seen = new Set<string>()
  const recorder = ConfigProvider.make((path) => {
    seen.add(path.map(String).join("_"))
    return Effect.succeed(undefined)
  })
  try {
    Effect.runSync(Effect.exit(config.pipe(Effect.provideService(ConfigProvider.ConfigProvider, recorder))))
  } catch {
    // A reporter must never become the next boot-killer. An empty list is a worse message, not a
    // dead process; the `cause` below still names the variable.
    return []
  }
  return [...seen].sort()
}

/**
 * **Resolve every flag, and never fail.**
 *
 * ⚠️ This used to be `Service.defaultLayer.pipe(Layer.orDie)` — one `Config.all` over ~18 boolean
 * variables, with any `ConfigError` erased into a defect. `Config.withDefault` and `Config.option`
 * only cover MISSING data (measured against `effect@4.0.0-beta.83`: *"Only applies when the error is
 * a SchemaError caused exclusively by missing data … Validation errors still propagate"*), so
 * `NOVACLAW_ENABLE_EXA=yess` was an unrecoverable boot defect. An environment variable is an
 * operational fact, which is exactly the class AGENTS.md's self-healing law says must be repairable
 * by asking an agent — and no agent can be asked anything inside a process that never came up.
 * (`notes/reports/startup-classification-2026-08-07.md` §5, finding 1.)
 *
 * Each field is resolved on its own, always — not only after a combined read has failed — so the
 * degraded path IS the path and cannot rot as a branch nothing exercises. One malformed variable now
 * costs exactly one flag, which falls back to its declared default and is named in the log.
 *
 * `Effect.exit` is what makes this hold: `Effect.catch` and `Effect.ignore` do NOT see defects, and a
 * defect is what a `Config` decode failure becomes downstream. An `Exit` carries the whole `Cause`.
 */
export const resolve: Effect.Effect<Resolution> = Effect.gen(function* () {
  const flags: Record<string, unknown> = {}
  const faults: FlagFault[] = []
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the field types differ per key; this walk only needs "some Config".
  const declarations = Object.entries(fields) as ReadonlyArray<readonly [string, Config.Config<unknown>]>
  for (const [field, config] of declarations) {
    const attempt = yield* Effect.exit(config)
    if (Exit.isSuccess(attempt)) {
      flags[field] = attempt.value
      continue
    }
    const fallback = yield* Effect.exit(config.pipe(Effect.provideService(ConfigProvider.ConfigProvider, noEnvironment)))
    flags[field] = Exit.isSuccess(fallback) ? fallback.value : undefined
    faults.push({ field, variables: variablesOf(config), cause: Cause.pretty(attempt.cause) })
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- every key of `fields` is assigned above, in order.
  return { flags: flags as Info, faults }
})

/** The resolution, with any faults named in the log before the service is handed out. */
const announced = Effect.flatMap(resolve, (resolution) =>
  resolution.faults.length === 0
    ? Effect.succeed(resolution.flags)
    : Log.event("instance.flags.parse.failed", {
        "instance.flags": resolution.faults.flatMap((fault) => fault.variables).join(","),
        "instance.cause": resolution.faults.map((fault) => `${fault.field}: ${fault.cause}`).join(" | "),
      }).pipe(Effect.as(resolution.flags)),
)

export const defaultLayer = Layer.effect(Service, Effect.map(announced, Service.of))

const emptyConfigLayer = defaultLayer.pipe(Layer.provide(ConfigProvider.layer(noEnvironment)))

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: defaultLayer, deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
