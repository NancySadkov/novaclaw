import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { Flag } from "@novaclaw/core/flag/flag"
import { ServerLaunchCredential } from "@novaclaw/core/server-launch-credential"
import { ServerAuth as Instance, Config as InstanceAuthConfig } from "../../src/server/auth"
import { ServerAuth as Shared, Config as SharedAuthConfig } from "@novaclaw/server/auth"
import type { Info as SharedInfo } from "@novaclaw/server/auth"

// The mechanical half of "the two `ServerAuth` modules are value-identical apart from `header()`, so one
// should absorb the other" (v0.2.0 PREP, Wave 1 follow-up). `packages/server/src/auth.ts` is now the one
// implementation and `packages/novaclaw/src/server/auth.ts` re-exports it, keeping exactly two things of
// its own: a distinct Context key, and a distinct env fallback for `header()`.
//
// Per todo.md ruling 1, the invariant ships with a check or it does not exist. There are three claims
// here and each has a negative control in the same describe block:
//   1. There is ONE implementation — asserted by REFERENCE identity, so a re-copied function fails.
//   2. The two tags stay distinct — asserted behaviourally, by reading both from one merged context.
//   3. `header()`'s difference is real and preserved — measured in BOTH directions, because the filing
//      called the two "different" without saying how, and the difference turns out to be a TIMING one:
//      the instance reads a module-load SNAPSHOT (`Flag`), the shared module reads `process.env` live.
//
// ⚠️ Deliberately no synthetic duplicate `Context.Service` id is declared in this file:
// `packages/protocol/test/context-key-uniqueness.test.ts` statically scans every `.ts` under
// `packages/`, so a fake collision authored here would fail THAT ledger. The collision failure mode is
// reproduced instead by provisioning one real tag twice.

const original = {
  flagPassword: Flag.NOVACLAW_SERVER_PASSWORD,
  flagUsername: Flag.NOVACLAW_SERVER_USERNAME,
  envPassword: process.env.NOVACLAW_SERVER_PASSWORD,
  envUsername: process.env.NOVACLAW_SERVER_USERNAME,
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  // 🔴 Stated explicitly rather than left to the `Flag` assignments below. Those DO forward to the
  // launch-credential holder now, so they would happen to reset it — but an invariant that holds
  // because two unrelated lines alias each other is the kind that breaks the day someone adds an
  // early `return` or reorders them. Clear first, then restore the snapshot.
  ServerLaunchCredential.clear()
  Flag.NOVACLAW_SERVER_PASSWORD = original.flagPassword
  Flag.NOVACLAW_SERVER_USERNAME = original.flagUsername
  restoreEnv("NOVACLAW_SERVER_PASSWORD", original.envPassword)
  restoreEnv("NOVACLAW_SERVER_USERNAME", original.envUsername)
})

/** The exports the instance module is allowed to declare for itself. Everything else must BE the shared one. */
const INSTANCE_OWNED = new Set([
  "ServerAuth", // the module's own `export * as ServerAuth from "./auth"` self-barrel
  "Config", // its own Context key — see claim 2
  "header", // its own env fallback — see claim 3
  "headers",
])

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * A TYPE-level assertion that the instance tag's inferred shape IS the shared `Info`.
 *
 * ⚠️ Bun type-strips, so this line only bites under `tsgo` — adding a field to one side and not the
 * other turns `Exact<…>` into `false` and `const … : false = true` stops compiling. The `expect` below
 * exists so the constant is not dead weight at runtime.
 */
const CONFIG_SHAPE_IS_SHARED_INFO: Exact<Context.Service.Shape<typeof InstanceAuthConfig>, SharedInfo> = true

/**
 * Reads BOTH tags from ONE launch credential, sequentially.
 *
 * 🔴 This used to inject a `ConfigProvider` carrying `NOVACLAW_SERVER_PASSWORD`, and that channel no
 * longer exists: the server stopped reading its credential from the environment, so a provider-shaped
 * test would now be asserting nothing at all — both tags would answer "open" no matter what the test
 * wrote. The credential holder is what replaced it, and it is the honest subject: this is the same
 * value `--password` fills before the graph builds.
 *
 * ⚠️ Sequentially, and that is not a style choice. The holder is one process-global, so the two reads
 * would race if they ran in a `Promise.all` — the second could observe the first's credential. The
 * version this replaced could run them in parallel precisely BECAUSE its input was a per-layer
 * provider; a shared global is the price of having one credential source instead of two.
 */
const readBothConfigs = async (credential: { readonly password?: string; readonly username?: string }) => {
  ServerLaunchCredential.clear()
  ServerLaunchCredential.set(credential)
  const instance = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* InstanceAuthConfig
    }).pipe(Effect.provide(InstanceAuthConfig.defaultLayer)),
  )
  const shared = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* SharedAuthConfig
    }).pipe(Effect.provide(SharedAuthConfig.defaultLayer)),
  )
  return { instance, shared }
}

/**
 * The five credential shapes the Wave-1 rename measured behaviour-identity across, restated as launch
 * credentials now that the env var is gone. Kept — and re-run against the MERGED modules, because
 * merging is a stronger claim than renaming was.
 *
 * What is still under test is not "do two env readers agree" (there is one reader now), but whether
 * both tags SHAPE one credential identically: the same `Option` for an unset password, the same
 * default username, empty string treated as unset on both sides. A `Some("")` on one side and
 * `none()` on the other is exactly the drift this matrix catches.
 */
const CREDENTIAL_SHAPES: readonly { readonly password?: string; readonly username?: string }[] = [
  {},
  { password: "secret" },
  { username: "kit" },
  { password: "secret", username: "kit" },
  { password: "", username: "" },
]

const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`

describe("ServerAuth absorption", () => {
  test("declares no export of its own beyond the tag and the two header builders", () => {
    // Guards the guard AND ratchets: a NEW export on the instance module must either be classified as
    // instance-owned above (with a reason) or be the shared binding itself.
    const reExported = Object.keys(Instance)
      .filter((name) => !INSTANCE_OWNED.has(name))
      .sort()

    expect(reExported).toEqual(["authorized", "effective", "headerFrom", "headersFrom", "required", "resolve"])
  })

  test("re-exports the shared implementation rather than redeclaring it", () => {
    const record = Instance as unknown as Record<string, unknown>
    const shared = Shared as unknown as Record<string, unknown>
    const drifted = Object.keys(Instance)
      .filter((name) => !INSTANCE_OWNED.has(name))
      .filter((name) => record[name] !== shared[name])

    // Reference identity, not deep equality: a re-copied function is deep-equal to nothing and `===` to
    // nothing either, so drift is unrepresentable rather than discouraged.
    expect(drifted).toEqual([])
  })

  test("distinguishes a shared binding from a separate one", () => {
    // Negative control for the test above — proof that `===` is not trivially true across these two
    // module namespaces. `header` is the one value export that is deliberately NOT shared.
    expect(Instance.header).not.toBe(Shared.header)
    expect(Instance.headers).not.toBe(Shared.headers)
    expect(Instance.Config).not.toBe(Shared.Config)
  })

  test("carries the instance tag shape as exactly the shared Info type", () => {
    expect(CONFIG_SHAPE_IS_SHARED_INFO).toBe(true)
  })
})

describe("ServerAuth config tags", () => {
  test("resolve independently from one merged context", async () => {
    // The two tags must remain SEPARATE Context entries. They carried one id until 2026-07-28, which is
    // how `httpapi/server.ts` fed the instance config to `@novaclaw/server`'s middleware and it ran.
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const instance = yield* InstanceAuthConfig
        const shared = yield* SharedAuthConfig
        return [instance.username, shared.username]
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            InstanceAuthConfig.layer({ password: Option.some("instance-secret"), username: "instance-user" }),
            SharedAuthConfig.layer({ password: Option.some("server-secret"), username: "server-user" }),
          ),
        ),
      ),
    )

    expect(seen).toEqual(["instance-user", "server-user"])
    expect(new Set(seen).size).toBe(2)
  })

  test("collapse to a single value when one key is provisioned twice", async () => {
    // Negative control for the test above: this IS what a re-collision looks like. One key answers once,
    // so the two distinct values become one and the assertion above could not stay green.
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* SharedAuthConfig
        const second = yield* SharedAuthConfig
        return [first.username, second.username]
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            SharedAuthConfig.layer({ password: Option.some("instance-secret"), username: "instance-user" }),
            SharedAuthConfig.layer({ password: Option.some("server-secret"), username: "server-user" }),
          ),
        ),
      ),
    )

    expect(new Set(seen).size).toBe(1)
  })

  // ⚠️ Spread + annotate: bun's `test.each` overloads do not accept a `readonly` array, and without
  // the parameter type it infers `unknown` and both calls below fail TS2345. Bun type-strips, so this
  // was green at runtime and only `tsgo` saw it.
  test.each([...CREDENTIAL_SHAPES])(
    "read the credential %o to the same value on both tags",
    async (credential: { readonly password?: string; readonly username?: string }) => {
      const { instance, shared } = await readBothConfigs(credential)

      expect(instance).toEqual(shared)
    },
  )

  test("read different credentials to different values", async () => {
    // Negative control for the matrix above: `toEqual` on these two shapes is not vacuously true.
    //
    // ⚠️ Its shape had to change with the code. It used to feed the two tags DIFFERENT environments and
    // watch them disagree, which was only possible because they read two different sources — the thing
    // this change removed on purpose. With one credential source they cannot be made to disagree by
    // input, so what this now proves is the property the matrix actually depends on: that the value it
    // compares MOVES when the credential changes. Same credential, both tags agreeing, is the claim;
    // different credential, different value, is what stops that agreement from being an accident.
    const first = await readBothConfigs({ password: "one", username: "kit" })
    const second = await readBothConfigs({ password: "two", username: "bob" })

    expect(first.instance).not.toEqual(second.instance)
    expect(first.shared).not.toEqual(second.shared)
    expect(first.instance).toEqual(first.shared)
    expect(second.instance).toEqual(second.shared)
  })
})

describe("ServerAuth header sources", () => {
  test("read the Flag snapshot on the instance and process.env in the shared module", () => {
    Flag.NOVACLAW_SERVER_PASSWORD = "flag-secret"
    Flag.NOVACLAW_SERVER_USERNAME = "flag-user"
    process.env.NOVACLAW_SERVER_PASSWORD = "env-secret"
    process.env.NOVACLAW_SERVER_USERNAME = "env-user"

    expect(Instance.header()).toBe(basic("flag-user", "flag-secret"))
    expect(Shared.header()).toBe(basic("env-user", "env-secret"))
  })

  test("diverge in both directions when only one source is set", () => {
    // ⚠️ THE FILING UNDERSTATED THIS. `Flag.NOVACLAW_SERVER_*` are plain properties in
    // `core/flag/flag.ts`, evaluated once at import — a snapshot, not a getter — so an env var exported
    // after that import is invisible to the instance surface and visible to the shared one. Absorbing
    // must not quietly pick one; `header()` decides how an OUTBOUND request authenticates.
    Flag.NOVACLAW_SERVER_PASSWORD = undefined
    process.env.NOVACLAW_SERVER_PASSWORD = "env-secret"
    expect(Instance.header()).toBeUndefined()
    expect(Shared.header()).toBe(basic("novaclaw", "env-secret"))

    Flag.NOVACLAW_SERVER_PASSWORD = "flag-secret"
    delete process.env.NOVACLAW_SERVER_PASSWORD
    expect(Instance.header()).toBe(basic("novaclaw", "flag-secret"))
    expect(Shared.header()).toBeUndefined()
  })

  test("agree on every input once BOTH fields are supplied explicitly", () => {
    // Everything except the SOURCE is shared, so a FULLY explicit credential must produce byte-identical
    // headers no matter how far apart the two environments are pulled.
    Flag.NOVACLAW_SERVER_PASSWORD = "flag-secret"
    Flag.NOVACLAW_SERVER_USERNAME = "flag-user"
    process.env.NOVACLAW_SERVER_PASSWORD = "env-secret"
    process.env.NOVACLAW_SERVER_USERNAME = "env-user"

    for (const credentials of [
      { password: "p", username: "bob" },
      { password: "pass:with:colons", username: "bob" },
      { password: "p", username: "" },
    ]) {
      expect(Instance.header(credentials)).toBe(Shared.header(credentials))
      expect(Instance.headers(credentials)).toEqual(Shared.headers(credentials))
    }
  })

  test("still consult their own source for whichever field the caller omits", () => {
    // Measured, not assumed — this assertion started life as "explicit credentials bypass the env" and
    // was WRONG: `header({ password })` with no username still takes the username from the env, so a
    // half-explicit credential diverges exactly like a fully implicit one. Worth pinning, because it is
    // the shape a caller is most likely to use (`--password` on the CLI with no `--username`).
    Flag.NOVACLAW_SERVER_PASSWORD = "flag-secret"
    Flag.NOVACLAW_SERVER_USERNAME = "flag-user"
    process.env.NOVACLAW_SERVER_PASSWORD = "env-secret"
    process.env.NOVACLAW_SERVER_USERNAME = "env-user"

    expect(Instance.header({ password: "p" })).toBe(basic("flag-user", "p"))
    expect(Shared.header({ password: "p" })).toBe(basic("env-user", "p"))

    expect(Instance.header({ username: "bob" })).toBe(basic("bob", "flag-secret"))
    expect(Shared.header({ username: "bob" })).toBe(basic("bob", "env-secret"))
  })
})

describe("ServerAuth request decision", () => {
  // The accept/reject predicates themselves — `packages/server/src/auth.ts` carried ZERO direct tests
  // before this file, and it is now the only copy, so the decision is covered where it lives. The
  // end-to-end 401/200 path over a real server stays in `httpapi-authorization.test.ts`.
  const config: SharedInfo = { password: Option.some("secret"), username: "alice" }

  test("stored runtime token outranks the launcher default", () => {
    const result = Shared.resolve(config, "rotated")

    expect(result.source).toBe("stored")
    expect(result.config.password).toEqual(Option.some("rotated"))
    expect(Shared.authorized({ username: "alice", password: Redacted.make("secret") }, result.config)).toBe(false)
    expect(Shared.authorized({ username: "alice", password: Redacted.make("rotated") }, result.config)).toBe(true)
  })

  test("launcher default is used only when no stored token exists, then the server is open", () => {
    expect(Shared.resolve(config, null).source).toBe("launcher")
    expect(Shared.resolve({ password: Option.none(), username: "alice" }, null)).toEqual({
      config: { password: Option.none(), username: "alice" },
      source: "open",
    })
  })

  test("accepts the configured username and password", () => {
    expect(Shared.required(config)).toBe(true)
    expect(Shared.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
  })

  test("rejects a wrong password", () => {
    expect(Shared.authorized({ username: "alice", password: Redacted.make("wrong") }, config)).toBe(false)
  })

  test("rejects a wrong username", () => {
    expect(Shared.authorized({ username: "novaclaw", password: Redacted.make("secret") }, config)).toBe(false)
  })

  test("requires no auth when the password is unset or empty", () => {
    expect(Shared.required({ password: Option.none(), username: "alice" })).toBe(false)
    expect(Shared.required({ password: Option.some(""), username: "alice" })).toBe(false)
    expect(
      Shared.authorized(
        { username: "alice", password: Redacted.make("") },
        { password: Option.none(), username: "alice" },
      ),
    ).toBe(false)
  })
})
