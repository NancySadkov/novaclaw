export * as ServerAuth from "./auth"

import { ServerLaunchCredential } from "@novaclaw/core/server-launch-credential"
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

export type EffectiveSource = "stored" | "launcher" | "open"

export type Effective = {
  readonly config: Info
  readonly source: EffectiveSource
}

export class Config extends Context.Service<Config, Info>()("@novaclaw/ServerAuthConfig") {
  static layer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  /**
   * 🔴 The launch credential comes from ARGV, never the environment.
   *
   * This used to be `EffectConfig.string("NOVACLAW_SERVER_PASSWORD")`, and Effect's default provider
   * reads the process environment — so an instance's authentication was decided by whatever the
   * launching shell happened to export. `ServerLaunchCredential` is filled from the CLI's
   * `--password` / `--username` before any layer builds, and `suspend` keeps the read LAZY: a plain
   * `Config.succeed(...)` would evaluate at class-definition time, i.e. before the CLI had parsed
   * anything, and every instance would boot open.
   */
  static get defaultLayer() {
    // ⚠️ `suspend`, and it is load-bearing rather than stylistic. The getter is ACCESSED at module
    // load — `routes/instance/httpapi/server.ts` builds `authOnlyRouterLayer` as a module-level
    // constant — which is long before the CLI handler parses argv. A plain `Layer.succeed` here would
    // therefore capture the credential as it stood at import time, i.e. empty, and every instance
    // would boot open while `--password` sat unread in the holder. `suspend` defers the read to the
    // first actual build of the layer, by which point the CLI has run.
    return Layer.suspend(() =>
      Layer.succeed(
        this,
        this.of({
          // Written out rather than via a helper: this Effect version's `Option.fromNullOr` wraps
          // `undefined` as `Some(undefined)`, which would read as "a password is set" and demand Basic
          // auth against the value `undefined`. An open server must be `Option.none()`.
          password: ServerLaunchCredential.get().password === undefined ? Option.none() : Option.some(ServerLaunchCredential.get().password!),
          username: ServerLaunchCredential.get().username,
        }),
      ),
    )
  }
}

/**
 * Resolve the incoming API credential and say where it came from without exposing the secret.
 *
 * The launch/environment credential is a bootstrap default: a stored `server.password` is the
 * runtime authority and therefore wins. Callers pass the live value from `SettingsConfigStore` on
 * every request; accepting it as an argument keeps this precedence function pure and testable.
 */
export function resolve(config: Info, stored?: string | null): Effective {
  if (stored) return { config: { ...config, password: Option.some(stored) }, source: "stored" }
  if (Option.isSome(config.password) && config.password.value !== "") return { config, source: "launcher" }
  return { config, source: "open" }
}

export function effective(config: Info, stored?: string | null): Info {
  return resolve(config, stored).config
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
