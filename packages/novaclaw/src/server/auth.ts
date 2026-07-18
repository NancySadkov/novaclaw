export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { ServerToken } from "@novaclaw/core/server-token"
import { Flag } from "@novaclaw/core/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@novaclaw/ServerAuthConfig", {
  password: EffectConfig.string("NOVACLAW_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("NOVACLAW_SERVER_USERNAME").pipe(EffectConfig.withDefault("novaclaw")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

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
  const password = credentials?.password ?? Flag.NOVACLAW_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.NOVACLAW_SERVER_USERNAME ?? "novaclaw"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
