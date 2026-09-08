import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Exit, Layer, Logger, References } from "effect"
import { Logging } from "@novaclaw/core/observability/logging"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { it } from "../lib/effect"

const readFlags = RuntimeFlags.Service.useSync((flags) => flags)

/**
 * **A typo in an environment variable was an unrecoverable boot defect.**
 *
 * `defaultLayer` used to be `Service.defaultLayer.pipe(Layer.orDie)` — one `Config.all` over ~18
 * boolean variables, with any `ConfigError` erased into a defect that no caller could catch. And
 * `Config.withDefault`/`Config.option` do not help: measured against the pinned
 * `effect@4.0.0-beta.83`, they cover MISSING data only, so `NOVACLAW_ENABLE_EXA=yess` propagated.
 *
 * An environment variable is an operational FACT, which is exactly the class AGENTS.md's self-healing
 * law reserves — *as long as at least one working model remains, the system must be restorable by
 * asking an agent* — and that law is void during boot, because there is no process to ask.
 * (`notes/reports/startup-classification-2026-08-07.md` §5, finding 1.)
 *
 * ⚠️ **Each claim below is paired with the raw `Config.all` layer over the SAME provider.** Asserting
 * only that the flags resolve would stay green if the poison stopped being a parse error at all —
 * a schema change, a wider `Boolean` codec — while proving nothing. The control asserts the poison
 * still kills the unguarded shape.
 *
 * **NEGATIVE CONTROL, measured 2026-08-07:** with `defaultLayer` reverted to
 * `Service.defaultLayer.pipe(Layer.orDie)`, "one malformed variable costs one flag" fails as a
 * **defect** rather than an assertion, and "the fault is named in the log" emits **0 lines**.
 */
describe("RuntimeFlags degrades instead of killing the boot", () => {
  /** The provider a user with a typo actually has: one bad value beside several good ones. */
  const typo = ConfigProvider.fromUnknown({
    NOVACLAW_ENABLE_EXA: "yess",
    NOVACLAW_ENABLE_PARALLEL: "true",
    NOVACLAW_CLIENT: "desktop",
  })

  /** Capture the formatted log lines a program produces, through the PRODUCTION formatter. */
  const linesOf = (effect: Effect.Effect<unknown>): string[] => {
    const captured: string[] = []
    const capture = Logger.map(Logging.formatter("testrun0"), (line) => {
      captured.push(line)
    })
    Effect.runSync(
      effect.pipe(
        Effect.asVoid,
        Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "Info"),
      ),
    )
    return captured
  }

  it.effect("the CONTROL: the raw Config.all layer still dies on that same environment", () =>
    Effect.gen(function* () {
      const raw = RuntimeFlags.Service.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(typo)))
      const exit = yield* Effect.exit(readFlags.pipe(Effect.provide(raw)))

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("one malformed variable costs one flag, not the instance", () =>
    Effect.gen(function* () {
      const flags = yield* readFlags.pipe(Effect.provide(RuntimeFlags.defaultLayer), Effect.provide(ConfigProvider.layer(typo)))

      // The bad one falls back to its DECLARED default…
      expect(flags.enableExa).toBe(false)
      // …and every sibling in the same environment is still read. This is the assertion that says
      // the cost is per-flag: a whole-set reset would have made both of these `false`/`"cli"`.
      expect(flags.enableParallel).toBe(true)
      expect(flags.client).toBe("desktop")
    }),
  )

  it.effect("the fault names the variable, mechanically rather than from a hand-kept list", () =>
    Effect.gen(function* () {
      const { faults } = yield* RuntimeFlags.resolve.pipe(Effect.provide(ConfigProvider.layer(typo)))

      expect(faults.map((fault) => fault.field)).toEqual(["enableExa"])
      // `enableExa` is a composite of three variables; the recorder finds all of them from the
      // `Config` itself, so this list cannot drift from the declaration the way a literal would.
      expect(faults[0]!.variables).toContain("NOVACLAW_ENABLE_EXA")
      expect(faults[0]!.variables).toContain("NOVACLAW_EXPERIMENTAL")
      // The cause is the parser's own sentence: which variable, and what would have been legal.
      expect(faults[0]!.cause).toContain("NOVACLAW_ENABLE_EXA")
      expect(faults[0]!.cause).toContain("yess")
    }),
  )

  it.effect("a clean environment reports no faults (negative control)", () =>
    Effect.gen(function* () {
      const clean = ConfigProvider.fromUnknown({ NOVACLAW_ENABLE_EXA: "true" })
      const { flags, faults } = yield* RuntimeFlags.resolve.pipe(Effect.provide(ConfigProvider.layer(clean)))

      expect(faults).toEqual([])
      expect(flags.enableExa).toBe(true)
    }),
  )

  it.effect("the fault is named in the log — ruling 2, on the boot path", () =>
    Effect.gen(function* () {
      const emitted = linesOf(
        Effect.void.pipe(Effect.provide(RuntimeFlags.defaultLayer), Effect.provide(ConfigProvider.layer(typo))),
      )
      const line = emitted.find((entry) => entry.includes("event=instance.flags.parse.failed"))

      expect(line).toBeDefined()
      expect(line).toContain("level=WARN")
      expect(line).toContain("NOVACLAW_ENABLE_EXA")
      expect(line).toContain("instance.cause=")

      // …and a healthy environment emits nothing at all: the degraded path costs a line, the
      // healthy one costs zero.
      expect(
        linesOf(
          Effect.void.pipe(
            Effect.provide(RuntimeFlags.defaultLayer),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
          ),
        ),
      ).toEqual([])
    }),
  )
})
