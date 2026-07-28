export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { ServerAuth as Shared } from "@novaclaw/server/auth"
import { Flag } from "@novaclaw/core/flag/flag"
import { Config as EffectConfig } from "effect"

// ONE implementation, two tags. Everything below the `Config` class used to be a second, line-for-line
// copy of `packages/server/src/auth.ts`; as of 2026-07-28 (v0.2.0 PREP, Wave 1 follow-up) the shared
// half is re-exported from there rather than redeclared here. Absorption went DOWN the dependency
// graph because it is the only direction that exists: `novaclaw` lists `@novaclaw/server` in its
// dependencies, `@novaclaw/server` does not list `novaclaw`, and importing upward would be a cycle.
//
// Two things stay local, and only because they genuinely differ from the shared module:
//  1. `Config` — a distinct Context key (see the warning on the class).
//  2. `header()`/`headers()` — a distinct env FALLBACK SOURCE (see `flagCredentials`).
//
// Both differences are pinned, with negative controls, by
// `test/server/server-auth-single-implementation.test.ts`. Re-copying any of the re-exports below into
// this file fails that test on reference identity, so drift is unrepresentable rather than discouraged.
export { authorized, effective, headerFrom, headersFrom, required } from "@novaclaw/server/auth"
export type { Credentials, DecodedCredentials, EnvCredentials, Info } from "@novaclaw/server/auth"

// ⚠️ NOT `@novaclaw/ServerAuthConfig` — that key belongs to `packages/server/src/auth.ts`, and this is a
// SECOND, independent declaration that happens to carry the same two env vars. Both registered the same
// id until 2026-07-28 (v0.2.0 PREP, Wave 1 / U3): an Effect `Context` is keyed by that string, so the two
// classes were ONE entry, and `httpapi/server.ts` fed THIS class into `@novaclaw/server`'s authorization
// middleware — which type-checked and ran only because the shapes happened to match field for field.
// Adding a field to either side would have broken it with nothing failing to compile. Keep the ids
// distinct; `packages/protocol/test/context-key-uniqueness.test.ts` fails if they ever converge again,
// and the sibling test named above proves at RUNTIME that the two tags resolve independently.
export class Config extends ConfigService.Service<Config>()("@novaclaw/InstanceServerAuthConfig", {
  password: EffectConfig.string("NOVACLAW_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("NOVACLAW_SERVER_USERNAME").pipe(EffectConfig.withDefault("novaclaw")),
}) {}

/**
 * The instance-side env fallback: the `Flag` SNAPSHOT, not `process.env`.
 *
 * ⚠️ These two `Flag` entries are plain properties (`env("NOVACLAW_SERVER_PASSWORD")`), evaluated once
 * when `core/flag/flag.ts` is imported — not the getters used further down that file. So this surface
 * cannot see an env var exported after that import, while `@novaclaw/server`'s `header()` can. That is
 * a real behavioural difference and it is preserved deliberately: `header()` decides how an OUTBOUND
 * request authenticates, so quietly handing one surface the other's source would be a security-adjacent
 * change made by a refactor. The properties are read per call (not captured here), which is what lets
 * `test/server/auth.test.ts` and friends drive this path by assigning to `Flag`.
 */
function flagCredentials(): Shared.EnvCredentials {
  return {
    password: Flag.NOVACLAW_SERVER_PASSWORD,
    username: Flag.NOVACLAW_SERVER_USERNAME,
  }
}

export function header(credentials?: Shared.Credentials) {
  return Shared.headerFrom(flagCredentials(), credentials)
}

export function headers(credentials?: Shared.Credentials) {
  return Shared.headersFrom(flagCredentials(), credentials)
}
