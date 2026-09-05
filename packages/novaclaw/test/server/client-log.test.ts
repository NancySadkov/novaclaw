import { describe, expect, test } from "bun:test"
import { Logging } from "@novaclaw/core/observability/logging"
import { Log } from "@novaclaw/schema/log"
import { RESERVED_ATTRIBUTES } from "@novaclaw/schema/log-events"
import { Effect, Logger, References } from "effect"
import { ClientLog } from "@/server/routes/instance/httpapi/handlers/client-log"

/**
 * `` 1g — the refusals on `POST /log`, exercised.
 *
 * The claim under test is not "the sanitizer returns a nice object"; it is **that a caller cannot
 * put a column of its choosing onto a line in `novaclaw.log`.** That is a claim about the LINE, so
 * the sharp tests below build a real record through `Log.event` and the production formatter and
 * read the columns off the string, exactly as `grep` and `cut` would.
 *
 * ⚠️ Every "the forged column is not there" assertion is paired, in the same run, with the same
 * value being present under its namespaced name. An absence on its own passes when the input never
 * arrived — which is how four vacuous assertions shipped in this repo on 2026-08-07.
 */

/** Capture what the PRODUCTION formatter emits, so the columns asserted on are the real ones. */
function emit<E>(effect: Effect.Effect<void, E>): string {
  const captured: string[] = []
  const capture = Logger.map(Logging.formatter("testrun0"), (line) => {
    captured.push(line)
  })
  Effect.runSync(
    effect.pipe(
      Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    ) as Effect.Effect<void>,
  )
  return captured[0]!
}

/** The column NAMES on a line, in order and with duplicates — the thing a naive reader sees. */
const columns = (line: string): string[] =>
  (line.match(/(?:^| )([A-Za-z][\w.-]*)=/g) ?? []).map((match) => match.trim().slice(0, -1))

/** One `POST /log` body's worth, rendered exactly as the handler renders it. */
const lineFor = (message: string, extra?: Record<string, unknown>) => {
  const fields = ClientLog.extra(extra)
  return emit(
    Log.event("client.log.info", {
      "client.service": ClientLog.service("renderer"),
      "client.message": ClientLog.truncate(message, ClientLog.MAX_MESSAGE_CHARS),
    }).pipe(
      Effect.annotateLogs({
        ...fields.annotations,
        ...(fields.dropped === 0 ? {} : { [ClientLog.DROPPED_ATTRIBUTE]: String(fields.dropped) }),
      }),
    ),
  )
}

describe("refusal 1 — a caller cannot forge one of the line's own columns", () => {
  test("EVERY reserved name is namespaced away, and the pairing proves it arrived", () => {
    for (const name of RESERVED_ATTRIBUTES) {
      const fields = ClientLog.extra({ [name]: `forged-${name}` })
      // ABSENCE: nothing under the bare reserved name…
      expect(Object.keys(fields.annotations)).not.toContain(name)
      // …and PRESENCE under the namespace, so the absence above cannot be satisfied by the input
      // having been thrown away.
      expect(fields.annotations[`${ClientLog.EXTRA_PREFIX}${name}`]).toBe(`forged-${name}`)
      expect(fields.dropped).toBe(0)
    }
    // The set really is the live one and not an empty array this loop iterated zero times over.
    expect(RESERVED_ATTRIBUTES.length).toBeGreaterThan(3)
    expect(ClientLog.reserved()).toContain("event")
  })

  test("on the real LINE there is exactly one `event=`, and it is ours", () => {
    const line = lineFor("boom", { event: "session.drain.exit", level: "ERROR", message: "mine" })
    // The forged values did arrive — they are on the line, namespaced.
    expect(line).toContain(`${ClientLog.EXTRA_PREFIX}event=session.drain.exit`)
    expect(line).toContain(`${ClientLog.EXTRA_PREFIX}level=ERROR`)
    // …and the line's own columns are unique and unchanged. A duplicate `event=` would make every
    // saved query, the telemetry clusters and the `log` tool's own filters answer wrongly.
    const names = columns(line)
    expect(names.filter((name) => name === "event")).toEqual(["event"])
    expect(names.filter((name) => name === "level")).toEqual(["level"])
    expect(names.filter((name) => name === "message")).toEqual(["message"])
    expect(line).toContain("event=client.log.info")
    expect(line).toContain("level=INFO")
    expect(line).toContain('message="client log"')
  })

  test("`client.dropped` is OURS because a caller cannot reach it", () => {
    const fields = ClientLog.extra({ [ClientLog.DROPPED_ATTRIBUTE]: "999" })
    expect(fields.annotations[ClientLog.DROPPED_ATTRIBUTE]).toBeUndefined()
    expect(fields.annotations[`${ClientLog.EXTRA_PREFIX}${ClientLog.DROPPED_ATTRIBUTE}`]).toBe("999")
  })
})

describe("refusal 2 — a caller cannot break logfmt", () => {
  test("a key with a space is dropped and COUNTED, while its safe neighbour survives", () => {
    const fields = ClientLog.extra({ "a b": 1, "x=y": 2, ok: 3 })
    expect(fields.dropped).toBe(2)
    // The presence half: the sanitizer is dropping the unsafe keys, not the whole map.
    expect(fields.annotations[`${ClientLog.EXTRA_PREFIX}ok`]).toBe("3")
  })

  test("the emitted line parses as key=value pairs with no name carrying a space", () => {
    const line = lineFor("boom", { "a b": 1, ok: 2 })
    for (const name of columns(line)) expect(name).toMatch(ClientLog.SAFE_KEY)
    // The drop is on the line rather than swallowed.
    expect(line).toContain(`${ClientLog.DROPPED_ATTRIBUTE}=1`)
  })

  test("a nested value becomes ONE string column, not several caller-named ones", () => {
    const fields = ClientLog.extra({ ctx: { "a b": { deep: 1 } } })
    expect(Object.keys(fields.annotations)).toEqual([`${ClientLog.EXTRA_PREFIX}ctx`])
    expect(fields.annotations[`${ClientLog.EXTRA_PREFIX}ctx`]).toBe('{"a b":{"deep":1}}')
    // …and the formatter agrees: the nested names never became columns.
    expect(columns(lineFor("boom", { ctx: { "a b": 1 } }))).not.toContain("client.extra.ctx.a b")
  })
})

describe("refusal 3 — nothing about one post is unbounded", () => {
  test("the message is truncated rather than rejected", () => {
    const long = "m".repeat(ClientLog.MAX_MESSAGE_CHARS * 3)
    expect(ClientLog.truncate(long, ClientLog.MAX_MESSAGE_CHARS)).toHaveLength(ClientLog.MAX_MESSAGE_CHARS + 1)
    // Rejecting a crash report during a crash is the failure this whole item forbids.
    expect(lineFor(long)).toContain("event=client.log.info")
  })

  test("extra keys and values are capped, and the overflow is counted", () => {
    const wide = Object.fromEntries(
      Array.from({ length: ClientLog.MAX_EXTRA_KEYS + 9 }, (_, index) => [`k${index}`, "v".repeat(2000)]),
    )
    const fields = ClientLog.extra(wide)
    expect(Object.keys(fields.annotations)).toHaveLength(ClientLog.MAX_EXTRA_KEYS)
    expect(fields.dropped).toBe(9)
    for (const value of Object.values(fields.annotations))
      expect(value.length).toBeLessThanOrEqual(ClientLog.MAX_EXTRA_VALUE_CHARS + 1)
  })

  test("the service name is slugged to its declared vocabulary shape", () => {
    expect(ClientLog.service("renderer")).toBe("renderer")
    expect(ClientLog.service("my renderer / v2")).toBe("my-renderer-v2")
    expect(ClientLog.service("   ")).toBe("unknown")
    expect(ClientLog.service("x".repeat(500))).toHaveLength(ClientLog.MAX_SERVICE_CHARS + 1)
  })
})

describe("refusal 4 — a client in a crash loop cannot evict the history that explains it", () => {
  test("the burst absorbs a full ring drain, then refuses, then refills", () => {
    const limiter = new ClientLog.Limiter(ClientLog.BURST, ClientLog.PER_SECOND, 0)
    // A 200-entry renderer ring flushes in one go — the feature's own primary use.
    for (let index = 0; index < 200; index += 1) expect(limiter.admit(0)).toBe(0)
    // …and a loop past the burst is refused, at the same instant.
    for (let index = 200; index < ClientLog.BURST; index += 1) expect(limiter.admit(0)).toBe(0)
    expect(limiter.admit(0)).toBeUndefined()
    expect(limiter.admit(0)).toBeUndefined()
    // The refusals are CARRIED, not forgotten: the next admitted line names how many were lost.
    expect(limiter.admit(10_000)).toBe(2)
    // …and the counter resets, so the number is "since the last line" rather than a running total.
    expect(limiter.admit(10_000)).toBe(0)
  })

  test("the sustained rate is the sustained rate (negative control on the refill)", () => {
    const limiter = new ClientLog.Limiter(2, 1, 0)
    expect(limiter.admit(0)).toBe(0)
    expect(limiter.admit(0)).toBe(0)
    expect(limiter.admit(0)).toBeUndefined()
    // Half a token after 500 ms is not a token. A refill that rounded up would make the ceiling a
    // suggestion, and this is the assertion that would go red.
    expect(limiter.admit(500)).toBeUndefined()
    expect(limiter.admit(1000)).toBe(2)
  })
})
