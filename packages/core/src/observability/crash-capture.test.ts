import { beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { build, type Envelope, type Host, resetRepeats } from "./telemetry"
import {
  airgapFrom,
  capture,
  durableSpool,
  errorKind,
  errorStack,
  type HandlerTarget,
  install,
  installed,
  lastOutcome,
  liveSources,
  readConsent,
  resetForTest,
  type Sources,
  type TransmitInput,
} from "./crash-capture"

/**
 * **The mechanical half of the crash-capture seam.**
 *
 * `telemetry.test.ts` proves the SENDER cannot leak. This file proves the CALLER cannot make it
 * leak, which is a different claim: the sender is a total function over what it is handed, and a
 * crash handler is the one call site with everything worth leaking in scope — the message, the
 * stack, the cwd, argv, the env.
 *
 * Four claims, and each one has a negative control, because every one of them is an ABSENCE:
 *
 *   · nothing but a constructor name and a hashed stack crosses into the sender;
 *   · the two disable conditions stay two, and airgap fails CLOSED when it cannot be known;
 *   · the handlers cannot swallow a crash, cannot throw, and cannot be installed twice;
 *   · a test run does not report its own crashes.
 *
 * ⚠️ **Two vacuous-assertion traps this file was written against**, both of which shipped elsewhere
 * on 2026-08-06 and were caught only by mutation:
 *   · `expect(wire).not.toContain("C:\\Users\\…")` can NEVER fire, because `JSON.stringify` escapes
 *     every backslash. So {@link expectAbsent} scans the parsed LEAVES *and* the serialised wire
 *     against the JSON-escaped body of the secret, and {@link POISON} proves both halves can fire.
 *   · `not.toHaveProperty("a.b")` passes vacuously, because bun reads a dotted argument as a PATH.
 *     No dotted `toHaveProperty` appears below; membership is asserted over explicit key lists.
 */

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

const HOST: Host = {
  version: "0.2.0-nightly.20260731t065756",
  channel: "prod",
  platform: "win32",
  arch: "x64",
  runtime: "bun-1.2.23",
}

const ENDPOINT = "https://telemetry.example.invalid/crash"

/** The strings a real crash carries and that must never reach the wire. */
const SECRETS = {
  message: "Cannot read properties of undefined (reading 'apiKey')",
  windowsPath: "C:\\Users\\nangl\\d\\code\\llm\\novaclaw\\packages\\core\\src\\session\\runner\\llm.ts",
  posixPath: "/home/nancy/clients/acme-merger-2026/secret-plan.md",
  username: "nangl",
  prompt: "summarise my divorce settlement and email it to my lawyer",
} as const

/** A thrown error whose message AND stack carry every secret, in the shape a real crash has them. */
function poisonedError(): Error {
  const error = new TypeError(SECRETS.message)
  error.stack = [
    `TypeError: ${SECRETS.message}`,
    `    at resolveModel (${SECRETS.windowsPath}:412:19)`,
    `    at async runTurn (${SECRETS.posixPath}:88:7)`,
    `    at Object.<anonymous> (/Users/${SECRETS.username}/app/index.ts:1:1)`,
  ].join("\n")
  return error
}

let transmitted: TransmitInput[] = []

function sourcesWith(overrides: Partial<Sources> = {}): Sources {
  return {
    config: () => undefined,
    airgap: () => false,
    endpoint: () => ENDPOINT,
    host: () => HOST,
    plane: "server",
    transmit: (input) => transmitted.push(input),
    ...overrides,
  }
}

/** A fake `process`: records what was registered, and can fire it. */
function fakeTarget() {
  const listeners = new Map<string, Array<(...args: never[]) => void>>()
  const target: HandlerTarget & {
    events(): string[]
    emit(event: string, ...args: unknown[]): void
    count(event: string): number
  } = {
    on(event, listener) {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return target
    },
    off(event, listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
      return target
    },
    events: () => [...listeners.keys()].filter((key) => (listeners.get(key) ?? []).length > 0).sort(),
    count: (event) => (listeners.get(event) ?? []).length,
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])])
        (listener as unknown as (...a: unknown[]) => void)(...args)
    },
  }
  return target
}

beforeEach(() => {
  transmitted = []
  resetForTest()
  resetRepeats()
})

// ── 0. the durable retry queue ─────────────────────────────────────────────────────────────────

describe("the crash spool survives restart without becoming a second leak", () => {
  const envelope: Envelope = {
    signature: { plane: "server", signature: "0123456789abcdef", kind: "TypeError", frames: 1 },
    attributes: {},
  }

  test("writes atomically, reloads valid entries, ignores corrupt entries, and removes an ack", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-crash-spool-"))
    try {
      const first = durableSpool(directory)
      first.append(envelope)
      fs.writeFileSync(path.join(directory, "crash-corrupt.json"), "{not-json", "utf8")

      const afterRestart = durableSpool(directory)
      expect(afterRestart.entries()).toHaveLength(1)
      expect(afterRestart.entries()[0]?.envelope).toEqual(envelope)
      const file = afterRestart.entries()[0]?.file
      expect(file).toBeDefined()
      afterRestart.remove(file!)
      expect(durableSpool(directory).entries()).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

// ── 1. the handlers: what they register, and what they do to the process ────────────────────────

describe("the handlers, and the runtime facts that forced them", () => {
  test("installs exactly the two additive handlers — never an `uncaughtException` listener", () => {
    const target = fakeTarget()
    const off = install({ target, allowInTest: true, sources: sourcesWith() })
    try {
      expect(target.events()).toEqual(["uncaughtExceptionMonitor", "unhandledRejection"])
      // ⚠️ The absence is the point: an `uncaughtException` listener REPLACES node's default
      // handling, so its mere existence would stop the process crashing. The monitor is additive.
      expect(target.count("uncaughtException")).toBe(0)
    } finally {
      off()
    }
  })

  test("the monitor captures and returns — it cannot swallow the crash", () => {
    const target = fakeTarget()
    const off = install({ target, allowInTest: true, sources: sourcesWith() })
    try {
      // Emitting must not throw and must not report an outcome that stops anything.
      expect(() => target.emit("uncaughtExceptionMonitor", poisonedError(), "uncaughtException")).not.toThrow()
      expect(lastOutcome()).toEqual({ state: "reported", origin: "uncaughtException" })
      expect(transmitted).toHaveLength(1)
    } finally {
      off()
    }
  })

  test("the rejection listener RE-RAISES the original reason (restoring the default crash)", () => {
    const target = fakeTarget()
    const off = install({ target, allowInTest: true, sources: sourcesWith() })
    try {
      const reason = poisonedError()
      // Measured 2026-08-07 on bun 1.3.14 and node 24.14.1: merely HAVING this listener suppresses
      // the crash (process survives, exit 0); re-throwing restores the printed stack and exit 1.
      let thrown: unknown
      try {
        target.emit("unhandledRejection", reason)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(reason)
      expect(transmitted).toHaveLength(1)
    } finally {
      off()
    }
  })

  test("the re-raised reason is reported ONCE, not twice", () => {
    const target = fakeTarget()
    const off = install({ target, allowInTest: true, sources: sourcesWith() })
    try {
      const reason = poisonedError()
      expect(() => target.emit("unhandledRejection", reason)).toThrow()
      // Measured: the re-raise fires the monitor for the SAME object on both runtimes.
      target.emit("uncaughtExceptionMonitor", reason, "uncaughtException")
      expect(transmitted).toHaveLength(1)
      expect(lastOutcome()).toEqual({ state: "duplicate", origin: "unhandledRejection" })
    } finally {
      off()
    }
  })

  test("negative control for the dedupe: a DIFFERENT error after a rejection is still reported", () => {
    const target = fakeTarget()
    const off = install({ target, allowInTest: true, sources: sourcesWith() })
    try {
      expect(() => target.emit("unhandledRejection", poisonedError())).toThrow()
      target.emit("uncaughtExceptionMonitor", new RangeError("a second, unrelated fault"), "uncaughtException")
      expect(transmitted).toHaveLength(2)
      expect(lastOutcome()).toEqual({ state: "reported", origin: "uncaughtException" })
    } finally {
      off()
    }
  })
})

// ── 2. install discipline: twice, and in a test run ─────────────────────────────────────────────

describe("install discipline", () => {
  test("a second install is a no-op — one crash never becomes two reports", () => {
    const first = fakeTarget()
    const second = fakeTarget()
    const off = install({ target: first, allowInTest: true, sources: sourcesWith() })
    try {
      expect(installed()).toBe(true)
      const alsoOff = install({ target: second, allowInTest: true, sources: sourcesWith() })
      expect(second.events()).toEqual([])
      // The refused install's disposer must not tear down the real one.
      alsoOff()
      expect(installed()).toBe(true)
      expect(first.count("uncaughtExceptionMonitor")).toBe(1)
    } finally {
      off()
    }
    expect(installed()).toBe(false)
    expect(first.events()).toEqual([])
  })

  test("🔴 NODE_ENV=test refuses to install at all — the suite never reports its own crashes", () => {
    // This file runs under `bun test`, which sets NODE_ENV=test itself. Omitting `allowInTest` is
    // therefore the real production check, exercised in the exact condition it exists for.
    expect(process.env["NODE_ENV"]).toBe("test")
    const target = fakeTarget()
    const off = install({ target, sources: sourcesWith() })
    expect(target.events()).toEqual([])
    expect(installed()).toBe(false)
    off()
  })

  test("uninstall is idempotent and re-install works after it", () => {
    const target = fakeTarget()
    const off = install({ target, allowInTest: true, sources: sourcesWith() })
    off()
    off()
    expect(target.events()).toEqual([])
    const again = install({ target, allowInTest: true, sources: sourcesWith() })
    expect(target.events()).toEqual(["uncaughtExceptionMonitor", "unhandledRejection"])
    again()
  })
})

// ── 3. the two disable conditions, held apart ───────────────────────────────────────────────────

describe("consent and airgap are two conditions, not one", () => {
  const refusalsFor = (config: unknown, airgap: boolean, endpoint: string | undefined) => {
    capture(poisonedError(), "uncaughtException", sourcesWith({ config: () => config, airgap: () => airgap, endpoint: () => endpoint }))
    const outcome = lastOutcome()
    return outcome?.state === "refused" ? outcome.refusals : []
  }

  test("the truth table: four combinations, and both conditions are named when both hold", () => {
    expect(refusalsFor(undefined, false, ENDPOINT)).toEqual([])
    expect(refusalsFor({ telemetry: { enabled: false } }, false, ENDPOINT)).toEqual(["consent_off"])
    expect(refusalsFor(undefined, true, ENDPOINT)).toEqual(["airgap"])
    // ⚠️ BOTH, in a stable order. A first-match string would let one mask the other, and a masked
    // condition is the shape "airgap merely flips the default" takes when someone refactors this.
    expect(refusalsFor({ telemetry: { enabled: false } }, true, ENDPOINT)).toEqual(["consent_off", "airgap"])
  })

  test("🔴 an explicit `enabled: true` does NOT survive airgap", () => {
    // AGENTS.md: telemetry is forced off in offline/airgap mode REGARDLESS of the setting.
    expect(refusalsFor({ telemetry: { enabled: true } }, true, ENDPOINT)).toEqual(["airgap"])
    expect(transmitted).toHaveLength(0)
  })

  test("changing only the config never moves airgap, and vice versa", () => {
    expect(refusalsFor({ telemetry: { enabled: false } }, false, ENDPOINT)).not.toContain("airgap")
    expect(refusalsFor({ telemetry: { enabled: true } }, true, ENDPOINT)).not.toContain("consent_off")
  })

  test("no endpoint is a NAMED refusal, not silence — the state on every machine today", () => {
    expect(refusalsFor(undefined, false, undefined)).toEqual(["no_endpoint"])
    expect(refusalsFor(undefined, false, "   ")).toEqual(["no_endpoint"])
    expect(transmitted).toHaveLength(0)
  })

  test("a refused crash transmits NOTHING — no payload is even assembled", () => {
    refusalsFor({ telemetry: { enabled: false } }, true, undefined)
    expect(transmitted).toEqual([])
    expect(lastOutcome()).toEqual({
      state: "refused",
      origin: "uncaughtException",
      refusals: ["consent_off", "airgap", "no_endpoint"],
    })
  })
})

describe("airgap fails CLOSED when it cannot be known", () => {
  test("no Offline layer built in this process ⇒ airgapped, whatever the policy says", () => {
    expect(airgapFrom({ builds: 0, enabled: false })).toBe(true)
    expect(airgapFrom({ builds: 0, enabled: true })).toBe(true)
  })

  test("once a policy source exists, the live policy decides", () => {
    expect(airgapFrom({ builds: 1, enabled: false })).toBe(false)
    expect(airgapFrom({ builds: 1, enabled: true })).toBe(true)
  })

  test("the live wiring delegates to the two live sources", () => {
    const sources = liveSources("server")
    expect(sources.plane).toBe("server")
    // ⚠️ `sources.airgap()` is deliberately NOT asserted to a literal here. `bun test` runs many
    // files in ONE process and `Offline.serviceBuilds()` is process-global, so whether the
    // fail-closed branch is the live answer depends on which sibling file ran first — a claim about
    // test ORDER wearing the costume of a claim about this code. The branch itself is covered above
    // as a pure function, and was measured end to end on 2026-08-07 against a loopback intake with a
    // real `Offline` layer in a fresh process each time: `NOVACLAW_OFFLINE=1` ⇒ `airgap=true` ⇒
    // `refused ["airgap"]` and nothing on the wire; without it ⇒ `airgap=false` ⇒ `reported`.
    const previous = process.env["NOVACLAW_TELEMETRY_ENDPOINT"]
    try {
      process.env["NOVACLAW_TELEMETRY_ENDPOINT"] = "https://intake.example.invalid/x"
      expect(sources.endpoint()).toBe("https://intake.example.invalid/x")
      delete process.env["NOVACLAW_TELEMETRY_ENDPOINT"]
      expect(sources.endpoint()).toBe("https://telemetry.novaclaw.app/v1/crashes")
    } finally {
      if (previous === undefined) delete process.env["NOVACLAW_TELEMETRY_ENDPOINT"]
      else process.env["NOVACLAW_TELEMETRY_ENDPOINT"] = previous
    }
  })
})

// ── 4. the consent read ─────────────────────────────────────────────────────────────────────────

describe("consent is read from the settings store", () => {
  const makeDb = (value?: string): string => {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crash-consent-")), "novaclaw.db")
    const db = new Database(file)
    db.run("CREATE TABLE runtime_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    if (value !== undefined) db.run("INSERT INTO runtime_setting (key, value) VALUES ('telemetry', ?)", [value])
    db.close()
    return file
  }

  test("{enabled:false} in the store turns consent off", () => {
    expect(readConsent(makeDb(JSON.stringify({ enabled: false })))).toEqual({ telemetry: { enabled: false } })
  })

  test("never set, malformed, or a missing file all default to ON (the managed-by-default stance)", () => {
    expect(readConsent(makeDb())).toBeUndefined()
    expect(readConsent(makeDb("not json"))).toBeUndefined()
    expect(readConsent(path.join(os.tmpdir(), "definitely-missing-xyz", "no.db"))).toBeUndefined()
    expect(readConsent(undefined)).toBeUndefined()
  })

  test("the TTL cache is keyed on the FILE, so one instance never answers for another", () => {
    const off = makeDb(JSON.stringify({ enabled: false }))
    const on = makeDb(JSON.stringify({ enabled: true }))
    const now = Date.now()
    expect(readConsent(off, now)).toEqual({ telemetry: { enabled: false } })
    // Same instant, different file: a time-only TTL would hand back the previous answer.
    expect(readConsent(on, now)).toEqual({ telemetry: { enabled: true } })
  })
})

// ── 5. what a crash actually sends ──────────────────────────────────────────────────────────────

/** Every leaf of an envelope, as `[path, value]`. Paths are joined with `/`, never `.` (see header). */
function leaves(value: unknown, prefix = ""): Array<[string, unknown]> {
  if (value === null || typeof value !== "object") return [[prefix, value]]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    leaves(entry, prefix === "" ? key : `${prefix}/${key}`),
  )
}

/**
 * Assert a secret appears in NEITHER the parsed leaves NOR the serialised wire.
 *
 * The two halves are not redundant. A leaf scan misses nothing but reads only what the walker
 * reaches; a wire scan reads everything but is the one that silently cannot fire if you compare
 * against the RAW string — `JSON.stringify` turns `C:\Users` into `C:\\Users`, so
 * `not.toContain(windowsPath)` is vacuous. `escaped` is the secret as it would actually appear.
 */
function expectAbsent(envelope: Envelope, secret: string): void {
  const wire = JSON.stringify(envelope)
  const escaped = JSON.stringify(secret).slice(1, -1)
  for (const [, leaf] of leaves(envelope)) {
    if (typeof leaf === "string") expect(leaf.includes(secret)).toBe(false)
  }
  expect(wire.includes(escaped)).toBe(false)
}

/** A deliberately leaky envelope, so every assertion above is shown to be capable of firing. */
const POISON = (secret: string): Envelope =>
  ({ signature: { kind: secret as never }, attributes: { note: secret } }) as unknown as Envelope

function builtFromCrash(error: unknown): Envelope {
  const before = transmitted.length
  capture(error, "uncaughtException", sourcesWith())
  expect(transmitted).toHaveLength(before + 1)
  const result = build(transmitted[before]!)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("unreachable")
  return result.envelope
}

describe("what a crash sends, and the proof nothing else rides along", () => {
  test("the message, both paths, the username and a prompt are all absent", () => {
    const envelope = builtFromCrash(poisonedError())
    for (const secret of Object.values(SECRETS)) expectAbsent(envelope, secret)
  })

  test("🔴 NEGATIVE CONTROL — the same scan over a leaky envelope FAILS for every secret", () => {
    for (const secret of Object.values(SECRETS)) {
      expect(() => expectAbsent(POISON(secret), secret)).toThrow()
    }
  })

  test("negative control, wire half: a raw-string comparison would have passed vacuously", () => {
    // The trap, demonstrated rather than described. The secret IS in the wire; comparing against the
    // unescaped literal finds nothing, which is why `expectAbsent` compares the escaped body.
    const wire = JSON.stringify(POISON(SECRETS.windowsPath))
    expect(wire.includes(SECRETS.windowsPath)).toBe(false) // ← the vacuous assertion
    expect(wire.includes(JSON.stringify(SECRETS.windowsPath).slice(1, -1))).toBe(true) // ← the real one
  })

  test("the envelope carries exactly the declared crash fields, and no event/attributes", () => {
    const envelope = builtFromCrash(poisonedError())
    expect(Object.keys(envelope.signature).sort()).toEqual([
      "arch",
      "channel",
      "frames",
      "kind",
      "plane",
      "platform",
      "release",
      "repeat",
      "runtime",
      "signature",
      "uptime",
    ])
    expect(envelope.signature.plane).toBe("server")
    // No `event`, no `subsystem` — the crash path names no log event, so neither is offered.
    expect(Object.keys(envelope.signature)).not.toContain("event")
    expect(Object.keys(envelope.signature)).not.toContain("subsystem")
    expect(envelope.attributes).toEqual({})
  })

  test("the stack becomes a COUNT and a digest — a depth, not a location", () => {
    const envelope = builtFromCrash(poisonedError())
    expect(envelope.signature.frames).toBe(3)
    expect(envelope.signature.kind).toBe("TypeError")
    expect(envelope.signature.signature).toMatch(/^[0-9a-f]{16}$/)
  })

  test("the digest is stable across machines: the same bug from two homes hashes the same", () => {
    const one = new TypeError("boom")
    one.stack = "TypeError: boom\n    at run (C:\\Users\\alice\\app\\index.ts:1:2)"
    const two = new TypeError("boom")
    two.stack = "TypeError: boom\n    at run (/home/bob/app/index.ts:1:2)"
    expect(builtFromCrash(one).signature.signature).toBe(builtFromCrash(two).signature.signature)
  })

  test("🔴 the build stamp is stripped — a per-build timestamp would identify one machine", () => {
    const envelope = builtFromCrash(poisonedError())
    expect(envelope.signature.release).toBe("0.2.0")
    expect(JSON.stringify(envelope)).not.toContain("nightly")
  })

  test("the call site hands the sender NOTHING but a kind and a stack", () => {
    capture(poisonedError(), "uncaughtException", sourcesWith())
    const report = transmitted[0]!.report
    expect(Object.keys(report).sort()).toEqual(["attributes", "event", "kind", "plane", "stack"])
    expect(report.event).toBeUndefined()
    expect(report.attributes).toBeUndefined()
    // No cwd, no argv, no env, no message — the raw stack is hashing input and goes no further.
    expect(report.kind).toBe("TypeError")
  })
})

describe("a thrown value cannot smuggle content through `kind`", () => {
  test("🔴 a constructor name that IS a prompt is dropped, not sent", () => {
    class Fake {}
    Object.defineProperty(Fake, "name", { value: SECRETS.prompt })
    const envelope = builtFromCrash(new Fake())
    expect(envelope.signature.kind).toBe("unknown")
    expectAbsent(envelope, SECRETS.prompt)
  })

  test("negative control: a well-formed constructor name DOES survive", () => {
    class HttpClientError extends Error {}
    expect(builtFromCrash(new HttpClientError("x")).signature.kind).toBe("HttpClientError")
  })

  test("errorKind never reads the writable `name` property", () => {
    const error = new TypeError("x")
    error.name = SECRETS.prompt
    expect(errorKind(error)).toBe("TypeError")
  })

  test("errorKind and errorStack are total over hostile inputs", () => {
    expect(errorKind(undefined)).toBe("undefined")
    expect(errorKind(null)).toBe("null")
    expect(errorKind("a string reason")).toBe("String")
    expect(
      errorKind(
        new Proxy(
          {},
          {
            get() {
              throw new Error("hostile getter")
            },
          },
        ),
      ),
    ).toBe("unknown")
    expect(errorStack(undefined)).toBeUndefined()
    expect(errorStack({ stack: 42 })).toBeUndefined()
    expect(
      errorStack(
        new Proxy(
          {},
          {
            get() {
              throw new Error("hostile getter")
            },
          },
        ),
      ),
    ).toBeUndefined()
  })
})

// ── 6. the handler can never become the crash ───────────────────────────────────────────────────

describe("totality — a crash handler that throws is worse than none", () => {
  test("a transmit that throws is absorbed and NAMED", () => {
    const outcome = capture(
      poisonedError(),
      "uncaughtException",
      sourcesWith({
        transmit: () => {
          throw new Error("the network layer exploded")
        },
      }),
    )
    expect(outcome).toEqual({
      state: "faulted",
      origin: "uncaughtException",
      reason: "the network layer exploded",
    })
  })

  test("a consent source that throws refuses nothing and reports a fault — it does not send", () => {
    const outcome = capture(
      poisonedError(),
      "uncaughtException",
      sourcesWith({
        config: () => {
          throw new Error("the settings store is gone")
        },
      }),
    )
    expect(outcome.state).toBe("faulted")
    expect(transmitted).toEqual([])
  })

  test("an airgap source that throws does NOT fall through to sending", () => {
    capture(
      poisonedError(),
      "uncaughtException",
      sourcesWith({
        airgap: () => {
          throw new Error("offline module unavailable")
        },
      }),
    )
    expect(transmitted).toEqual([])
  })

  test("the monitor handler absorbs a fault instead of replacing the crash (measured: exit 7)", () => {
    const target = fakeTarget()
    const off = install({
      target,
      allowInTest: true,
      sources: sourcesWith({
        transmit: () => {
          throw new Error("boom inside the handler")
        },
      }),
    })
    try {
      expect(() => target.emit("uncaughtExceptionMonitor", poisonedError(), "uncaughtException")).not.toThrow()
      expect(lastOutcome()?.state).toBe("faulted")
    } finally {
      off()
    }
  })

  test("the rejection listener still re-raises even when the capture faults", () => {
    const target = fakeTarget()
    const off = install({
      target,
      allowInTest: true,
      sources: sourcesWith({
        transmit: () => {
          throw new Error("boom inside the handler")
        },
      }),
    })
    try {
      const reason = poisonedError()
      expect(() => target.emit("unhandledRejection", reason)).toThrow(reason as Error)
    } finally {
      off()
    }
  })
})

// ── 7. the SOURCE ledger — a guard's SITE is invisible to behaviour ─────────────────────────────

describe("the seam is installed on the shared server spine", () => {
  /**
   * ⚠️ This cannot be a behavioural test, and that is the whole reason it exists. `install()`
   * refuses under `NODE_ENV=test`, so no test can observe `Server.listen` installing anything — the
   * feature's SITE is invisible to the suite, exactly the shape that let a shipped guard sit inert.
   * So the check is over source.
   *
   * ⚠️ It matches on statement lines only (a line whose first non-space characters are the call),
   * rather than stripping comments: a regex over source counts PROSE, and this very file plus
   * `server.ts`'s own comment both mention `CrashCapture.install`.
   */
  const serverSource = fs.readFileSync(path.join(import.meta.dir, "../../../novaclaw/src/server/server.ts"), "utf8")

  test("`Server.listen` calls the seam, as a statement and not only in a comment", () => {
    const statements = serverSource
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("CrashCapture.install("))
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('plane: "server"')
  })

  test("it is imported from core rather than re-implemented locally", () => {
    const imports = serverSource
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import ") && line.includes("crash-capture"))
    expect(imports).toEqual(['import { CrashCapture } from "@novaclaw/core/observability/crash-capture"'])
  })

  test("no `uncaughtException` LISTENER was added anywhere on that path", () => {
    // The additive monitor is the contract. A plain `uncaughtException` listener would silently stop
    // the process crashing, which is the failure this seam must never introduce.
    expect(serverSource).not.toContain('process.on("uncaughtException"')
  })
})
