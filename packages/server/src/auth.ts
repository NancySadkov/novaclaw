export * as ServerAuth from "./auth"

import { ServerToken } from "@novaclaw/core/server-token"
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"

// THE server-auth implementation. `packages/novaclaw/src/server/auth.ts` used to carry a second,
// line-for-line copy of everything below; since 2026-07-28 (v0.2.0 PREP, Wave 1 follow-up) it
// re-exports these bindings instead of redeclaring them. The direction is forced: `novaclaw` depends
// on `@novaclaw/server` (package.json), never the reverse, so the shared half has to live down here.
// What the instance package still owns is exactly two things, and only because they genuinely differ:
// its own `Config` Context key, and the environment source `header()` falls back to (see below).
// Pinned by `packages/novaclaw/test/server/server-auth-single-implementation.test.ts`.

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

/**
 * The environment fallback `header()` consults when the caller supplies no explicit credentials.
 *
 * ⚠️ This is a PARAMETER, not a hardcoded read, because the two surfaces really do differ and merging
 * them would be a silent change to how an outbound request authenticates. `packages/server` reads
 * `process.env` at CALL time; the instance package reads `Flag`, whose `NOVACLAW_SERVER_*` entries are
 * plain properties evaluated once when `core/flag/flag.ts` is imported — a SNAPSHOT, not a getter. So
 * an env var set after that import is visible to one and invisible to the other. The filing that led
 * to this collapse recorded the two `header()`s as merely "different", which understated it; the
 * divergence is measured, both directions, in the test named above.
 */
export type EnvCredentials = {
  readonly password: string | undefined
  readonly username: string | undefined
}

/** Build a HTTP Basic `Authorization` value; explicit credentials always beat the env fallback. */
export function headerFrom(env: EnvCredentials, credentials?: Credentials) {
  const password = credentials?.password ?? env.password
  if (!password) return undefined

  const username = credentials?.username ?? env.username ?? "novaclaw"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headersFrom(env: EnvCredentials, credentials?: Credentials) {
  const authorization = headerFrom(env, credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}

/** Reads `process.env` at call time — see `EnvCredentials` for why this differs from the instance one. */
function processEnvCredentials(): EnvCredentials {
  return {
    password: process.env.NOVACLAW_SERVER_PASSWORD,
    username: process.env.NOVACLAW_SERVER_USERNAME,
  }
}

export function header(credentials?: Credentials) {
  return headerFrom(processEnvCredentials(), credentials)
}

export function headers(credentials?: Credentials) {
  return headersFrom(processEnvCredentials(), credentials)
}
