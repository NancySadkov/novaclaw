export * as ServerAuth from "./auth"

import { ServerToken } from "@novaclaw/core/server-token"
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

export class Config extends Context.Service<Config, Info>()("@novaclaw/ServerAuthConfig") {
  static layer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get defaultLayer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: EffectConfig.string("NOVACLAW_SERVER_PASSWORD").pipe(EffectConfig.option),
            username: EffectConfig.string("NOVACLAW_SERVER_USERNAME").pipe(EffectConfig.withDefault("novaclaw")),
          }),
        )
      }),
    )
  }
}

/** P2P: env password wins; otherwise the settings store's server.password (live, TTL-cached). */
export function effective(config: Info): Info {
  if (Option.isSome(config.password) && config.password.value !== "") return config
  const stored = ServerToken.storedPassword()
  return stored ? { ...config, password: Option.some(stored) } : config
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? process.env.NOVACLAW_SERVER_PASSWORD
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? process.env.NOVACLAW_SERVER_USERNAME ?? "novaclaw"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
