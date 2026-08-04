import { Config, Context, Effect, Layer } from "effect"

type ConfigMap = Record<string, Config.Config<unknown>>

/**
 * The service shape inferred from an object of Effect `Config` definitions.
 */
export type Shape<Fields extends ConfigMap> = {
  readonly [Key in keyof Fields]: Config.Success<Fields[Key]>
}

/**
 * A Context service class with generated layers for config-backed services.
 */
export type ServiceClass<Self, Id extends string, Service> = Context.ServiceClass<Self, Id, Service> & {
  /** Provide already-parsed config, useful in tests. */
  readonly layer: (input: Service) => Layer.Layer<Self>
  /** Parse config once from the active Effect ConfigProvider and provide the service. */
  readonly defaultLayer: Layer.Layer<Self, Config.ConfigError>
}

/**
 * Create a Context service whose implementation is derived from Effect `Config`.
 *
 * This keeps Effect `Config` as the source of truth for env names, defaults, and
 * validation while generating a typed service plus convenient production/test
 * layers.
 *
 * The id below is deliberately FAKE. It used to read `@novaclaw/ServerAuthConfig`, which is a real,
 * live Context key owned by `packages/server/src/auth.ts` — a doc example naming another package's key
 * is how a copy-paste reintroduces the collision that `packages/protocol/test/context-key-uniqueness.
 * test.ts` exists to catch (that scan blanks comments, so it cannot see this one). (2026-07-28.)
 *
 * ```ts
 * class ExampleConfig extends ConfigService.Service<ExampleConfig>()(
 *   "@example/NotARealKey",
 *   {
 *     password: Config.string("EXAMPLE_PASSWORD").pipe(Config.option),
 *     username: Config.string("EXAMPLE_USERNAME").pipe(Config.withDefault("novaclaw")),
 *   },
 * ) {}
 *
 * const live = ExampleConfig.defaultLayer
 * const test = ExampleConfig.layer({ password: Option.some("secret"), username: "kit" })
 * ```
 */
export const Service =
  <Self>() =>
  <const Id extends string, const Fields extends ConfigMap>(id: Id, fields: Fields) => {
    class ConfigTag extends Context.Service<Self, Shape<Fields>>()(id) {
      static layer(input: Shape<Fields>) {
        return Layer.succeed(this, this.of(input))
      }

      static get defaultLayer() {
        const tag = this
        return Layer.effect(
          tag,
          Effect.gen(function* () {
            const config = yield* Config.all(fields)
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Config.all preserves the field shape, but its conditional return type also supports iterable inputs.
            return tag.of(config as Shape<Fields>)
          }),
        )
      }
    }

    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The generated class carries typed static helpers.
    return ConfigTag as ServiceClass<Self, Id, Shape<Fields>>
  }

export * as ConfigService from "./config-service"
