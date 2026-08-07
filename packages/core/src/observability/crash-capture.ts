import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { readRowsSync } from "#sqlite"
import { DatabasePath } from "../database/db-path"
import { Offline } from "../offline"
import { Telemetry } from "./telemetry"

/**
 * ── THE CRASH-CAPTURE SEAM — `telemetry.ts`'s missing caller ─────────────────────────────────────
 *
 * Batch item 3.2 shipped the sender and left it INERT: `Telemetry.report` had no caller, and there
 * was not one `uncaughtException` / `unhandledRejection` handler anywhere in `core`, `novaclaw` or
 * `desktop`. This file is the caller, and nothing else — it adds no field, no attribute and no
 * second door to the wire.
 *
 * ⚠️ **A crash handler is the one place a leak is most likely**, because a crash carries the most
 * context: the error's message, its stack with everyone's absolute paths, the cwd, argv, the env.
 * So the rule this file obeys is *hand the sender less, never more*: the ONLY things that cross into
 * `Telemetry` are the error's **constructor name** and its **stack**, and the stack is hashing input
 * that `build` discards — what leaves is `frames.length` and a 16-hex digest. `event` and
 * `attributes` are deliberately `undefined`. A field the sender does not declare is a conversation
 * about {@link Telemetry.CRASH_FIELDS}, never something a call site smuggles in.
 *
 * ── which handlers, and why THOSE ────────────────────────────────────────────────────────────────
 *
 * Measured on **bun 1.3.14** and **node 24.14.1**, win32, 2026-08-07 — every row is an observed run,
 * not a reading of the docs, because two of them are runtime-specific and one is a bun/node
 * divergence that decides the whole design:
 *
 * | probe | bun | node |
 * |---|---|---|
 * | `throw` in a timer → `uncaughtExceptionMonitor` | fires (`origin: uncaughtException`), **default crash preserved**, exit 1 | same |
 * | ESM top-level `throw` → monitor | fires (`origin: unhandledRejection` — an ESM module job IS a promise), exit 1 | same |
 * | `Promise.reject` with ONLY a monitor installed | 🔴 **does NOT fire**; process still dies, exit 1 | fires, exit 1 |
 * | an `unhandledRejection` LISTENER | **suppresses the crash** — process survives, exit 0 | same |
 * | an `unhandledRejection` listener that re-raises | crash restored: stack printed, exit 1 | same |
 * | a monitor that THROWS | replaces the crash, **exit 7** | replaces the crash |
 *
 * Two consequences, and they are the whole shape of this file:
 *
 *  1. **`uncaughtExceptionMonitor`, not `uncaughtException`.** The monitor is additive: it fires
 *     *alongside* the default handling instead of replacing it, so this seam structurally **cannot**
 *     swallow a crash, change an exit code, or keep a dying process alive. An `uncaughtException`
 *     listener would do all three by existing.
 *  2. **A rejection listener is needed anyway, and it must re-raise.** On bun the monitor does not
 *     see unhandled rejections at all — the most common async crash on our primary runtime would be
 *     invisible. But merely *adding* a listener suppresses the crash on both runtimes (measured), so
 *     the listener re-throws the original reason, which restores the printed stack and exit 1
 *     (measured). Re-raising means the monitor then fires for the SAME object, so
 *     {@link install} dedupes on identity — otherwise every rejection would report twice.
 *
 * ── exit safety: what happens when the endpoint is slow, dead, or the process is already dying ───
 *
 * **Nothing waits.** `capture` is synchronous end to end: two cheap reads, one pure `refusals()`
 * call, and a `runFork` that is never awaited. There is no `await`, no timer, no `process.exit`, no
 * `exitCode` write, and no `beforeExit`/`exit` hook anywhere in this file, so there is no mechanism
 * by which it could delay or prevent termination.
 *
 * · **Endpoint unreachable or slow** — the POST rides `CalloutPolicy.telemetryLogs`
 *   (async · 3 s · fail_open) inside `Telemetry.send`, which already ends in `Effect.catchCause`.
 *   A failure is a no-op; a slow endpoint is simply outlived by the process.
 * · **The process is already dying** — which is the normal case here — the forked fiber is torn down
 *   with it. ⚠️ **Stated plainly rather than implied, and MEASURED rather than assumed:** against a
 *   loopback intake on 2026-08-07 a real fatal `TypeError` reported `{state:"reported"}`, printed
 *   its stack, exited 1 — and **nothing arrived on the wire**. The same capture on a process that
 *   was not dying delivered in full. So the fatal path fires the sender and loses the packet.
 *   Closing that needs a durable spool (write on crash, flush on next boot), which is deliberately
 *   NOT built here: there is no intake VPS to flush to yet (`endpointFromEnv()` is `undefined` on
 *   every machine today, so the honest outcome is `refused: no_endpoint`), and an unattended spool
 *   with no drain is a directory that only grows. It is the next item, not this one.
 *
 * ── what a crash actually put on the wire (loopback capture, 2026-08-07) ─────────────────────────
 *
 * ```json
 * {"signature":{"arch":"x64","channel":"local","frames":2,"kind":"TypeError","plane":"server",
 *  "platform":"win32","release":"0.1.57","repeat":1,"runtime":"bun-1.3.14",
 *  "signature":"b1291a3b5b90f149","uptime":0},"attributes":{}}
 * ```
 *
 * The thrown error's message was *"Cannot read properties of undefined (reading 'apiKey')"* and its
 * stack held an absolute `C:\Users\…` path. Neither appears. Neither does a username, a cwd, a
 * project name or a build stamp — `release` is the line, not the `0.2.0-nightly.…` build.
 * · **Anything in here throws** — every handler body is wrapped, and the wrapper matters: a monitor
 *   that throws was measured to replace the crash and exit **7**, i.e. to destroy the very report it
 *   was trying to file. The re-raise in the rejection listener is the one statement deliberately
 *   OUTSIDE the wrapper.
 *
 * ── the two disable conditions stay two ──────────────────────────────────────────────────────────
 *
 * `Telemetry.resolveGate` reads consent and airgap from two sources with no shared derivation, and a
 * crash path is exactly where someone would collapse them into one boolean "because we are in a
 * hurry". Here: **consent** is a sync read of the `runtime_setting` row `telemetry` (the shape
 * `memory-setting.ts` and `server-token.ts` already use), **airgap** is {@link Offline}'s live
 * policy, and they meet only as the two arguments of `resolveGate`. `refusals()` is consulted as an
 * ARRAY so that when both hold, both are named.
 *
 * ⚠️ **Airgap FAILS CLOSED, and this is the one place where the seam is stricter than the sender.**
 * `Offline.currentPolicy()` answers `disabledPolicy` for two different facts — *the user is not
 * airgapped* and *no policy source has been installed in this process, so nothing is guarding yet*.
 * On the boot path the second is reachable: a crash before the Offline layer builds would otherwise
 * read as "not airgapped" and permit an upload from an airgapped machine. AGENTS.md's promise is
 * unconditional, so **not knowing reads as airgapped** — see {@link airgapFrom}.
 */
export * as CrashCapture from "./crash-capture"

// ── what a crash is allowed to hand the sender ──────────────────────────────────────────────────

/** Which handler saw it. **Local only** — it is not a declared crash field and is never sent. */
export type Origin = "uncaughtException" | "unhandledRejection"

/**
 * The error's constructor name — the ONE identifying string this seam reads off a thrown value.
 *
 * ⚠️ `err.name` is deliberately not used: `Error.prototype.name` is a writable data property, so a
 * library (or a caller) can set it to anything, including a message. A constructor name is
 * code-derived. It is still not trusted — `Telemetry.build` runs it through `ID_SHAPE`, which drops
 * anything with a space, a slash, a colon, an `@` or a newline — and the test drives a thrown object
 * whose `constructor.name` IS a prompt to prove the second line of defence actually fires.
 */
export function errorKind(value: unknown): string {
  try {
    if (value === undefined) return "undefined"
    if (value === null) return "null"
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name
    return typeof name === "string" && name !== "" ? name : typeof value
  } catch {
    // A throwing getter on the crashing object must not become a second crash.
    return "unknown"
  }
}

/**
 * The raw stack, or `undefined`.
 *
 * This is HASHING INPUT and nothing else. `Telemetry.normalizeFrames` reduces it to
 * `callee@basename:line:col` (every directory, drive letter and URL scheme discarded), `fingerprint`
 * digests that, and the envelope carries the digest plus a frame COUNT. The message line — the one
 * part of a stack that routinely contains user content — never even reaches the reducer, because
 * only lines starting with `at ` are read.
 */
export function errorStack(value: unknown): string | undefined {
  try {
    const stack = (value as { stack?: unknown } | undefined)?.stack
    return typeof stack === "string" ? stack : undefined
  } catch {
    return undefined
  }
}

// ── the sources, held apart ─────────────────────────────────────────────────────────────────────

/** Exactly what `Telemetry.report` needs. Assembled in one place so no other shape can reach it. */
export interface TransmitInput {
  readonly report: Telemetry.Report
  readonly gate: Telemetry.Gate
  readonly endpoint: string | undefined
  readonly host: Telemetry.Host
}

/**
 * Everything the crash path reads, injected — so the gates are assertable without a network, a
 * database, an offline layer or a running instance.
 */
export interface Sources {
  /** The **consent** source: an object shaped `{telemetry:{enabled}}`, or `undefined` (⇒ default ON). */
  readonly config: () => unknown
  /** The **airgap** source. Independent of {@link Sources.config} by construction. */
  readonly airgap: () => boolean
  readonly endpoint: () => string | undefined
  readonly host: () => Telemetry.Host
  /** Which half of the instance faulted. */
  readonly plane: "server" | "ui"
  /** Fire the report. MUST NOT block; MUST NOT throw (it is called inside the wrapper anyway). */
  readonly transmit: (input: TransmitInput) => void
}

/**
 * Is this machine airgapped, from the two facts that answer it.
 *
 * Pure and exported because the interesting case is the one that is hard to stage live: `builds === 0`
 * means no Offline layer has ever been built in this process, so `enabled` carries no information.
 * Not-knowing must read as airgapped — the alternative is an upload from an airgapped machine during
 * a boot crash, which is the product's central promise broken at its least-observable moment.
 */
export function airgapFrom(input: { readonly builds: number; readonly enabled: boolean }): boolean {
  return input.builds === 0 ? true : input.enabled
}

/**
 * The consent row, read straight from the settings store.
 *
 * The same 2 s-TTL sync read `kb-graph/memory-setting.ts` uses, for the same reason: a Settings
 * toggle must apply live without threading a store service into a `process.on` callback. Fail-open
 * to `undefined`, which `resolveGate` reads as consent ON — the managed-by-default stance, and the
 * sender's own default, so an unreadable store cannot make the two disagree.
 *
 * ⚠️ The db path is resolved ONCE, at install, never here: `Global.Path.data` creates seven
 * directories on first touch, and a crash handler is the last place that should be doing it.
 */
const CONSENT_TTL_MS = 2_000
let consentAt = 0
let consentKey: string | undefined
let consentCache: unknown

export function readConsent(dbFile: string | undefined, now = Date.now()): unknown {
  if (dbFile === undefined) return undefined
  // Keyed on the FILE as well as the clock. A TTL keyed on time alone would hand one instance's
  // consent row to another instance in the same process (and would make two tests share an answer).
  if (dbFile === consentKey && now - consentAt < CONSENT_TTL_MS) return consentCache
  let value: unknown
  try {
    const rows = readRowsSync(dbFile, "SELECT value FROM runtime_setting WHERE key = 'telemetry'")
    const raw = rows?.[0]?.value
    value = typeof raw === "string" ? { telemetry: JSON.parse(raw) } : undefined
  } catch {
    value = undefined // never set / unreadable / not JSON → the default, which is ON
  }
  consentAt = now
  consentKey = dbFile
  consentCache = value
  return value
}

/**
 * POST it, and never wait. `catchCause` rather than `catch` on purpose — `Effect.catch` does not see
 * defects (measured against the pinned effect source in the startup classification), and a layer
 * build is exactly where one would come from.
 */
function defaultTransmit(input: TransmitInput): void {
  Effect.runFork(
    Telemetry.report(input).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.catchCause(() => Effect.void),
      Effect.asVoid,
    ),
  )
}

/** The live wiring. The db path is resolved here — at install — and never on the crash path. */
export function liveSources(plane: "server" | "ui" = "server"): Sources {
  let dbFile: string | undefined
  try {
    dbFile = DatabasePath.path()
  } catch {
    // `db-path.ts` throws by design when a test run has no NOVACLAW_DB. Consent then defaults ON,
    // and the endpoint gate still refuses. Never fatal: this runs on the boot path.
    dbFile = undefined
  }
  return {
    config: () => readConsent(dbFile),
    airgap: () => airgapFrom({ builds: Offline.serviceBuilds(), enabled: Offline.currentPolicy().enabled }),
    endpoint: () => Telemetry.endpointFromEnv(),
    host: () => Telemetry.host(),
    plane,
    transmit: defaultTransmit,
  }
}

// ── the capture ─────────────────────────────────────────────────────────────────────────────────

/** What the last capture decided. Local, in-memory, never sent — the seam's own observable. */
export type Outcome =
  | { readonly state: "refused"; readonly origin: Origin; readonly refusals: ReadonlyArray<Telemetry.Refusal> }
  | { readonly state: "reported"; readonly origin: Origin }
  | { readonly state: "duplicate"; readonly origin: Origin }
  | { readonly state: "faulted"; readonly origin: Origin; readonly reason: string }

let last: Outcome | undefined

/** The last capture's outcome. Ruling 2: *refused because airgapped* is a different fact from *sent*. */
export function lastOutcome(): Outcome | undefined {
  return last
}

/**
 * One line to stderr, and only when the operator already asked for logs.
 *
 * Not the Effect logger: the logger can itself be the subsystem that failed (`observability.ts`'s
 * file leg is a named boot-killer), and a crash handler that needs a live runtime to say anything is
 * a handler that says nothing exactly when it matters. Silent by default, because "refused:
 * no_endpoint" is the state on every machine today and printing it on every crash would be noise
 * added to the worst moment of a user's session.
 */
function note(outcome: Outcome): void {
  try {
    if (process.env["NOVACLAW_PRINT_LOGS"] !== "1") return
    const detail =
      outcome.state === "refused"
        ? `refused (${outcome.refusals.join(", ")})`
        : outcome.state === "faulted"
          ? `faulted (${outcome.reason})`
          : outcome.state
    process.stderr.write(`[novaclaw] crash-capture ${outcome.origin}: ${detail}\n`)
  } catch {
    // stderr can be a closed pipe on a dying process. Never a second fault.
  }
}

/**
 * Decide and fire. Total: every path returns an {@link Outcome} and none throws.
 *
 * The order is the sender's order, deliberately — `refusals()` is consulted BEFORE anything is
 * assembled, so a refused crash never materialises a payload. It is not a second gate either:
 * `Telemetry.report` re-runs `build`, which re-runs the same `refusals`, so `build` remains the only
 * door to the wire. Calling `refusals` here (rather than `build`) also keeps the repeat counter
 * honest — `build` mutates it, so counting a crash we then refuse would be a lie about repetition.
 */
export function capture(value: unknown, origin: Origin, sources: Sources): Outcome {
  let outcome: Outcome
  try {
    // TWO reads, TWO sources. They meet only as the two arguments below.
    const config = sources.config()
    const airgap = sources.airgap()
    const gate = Telemetry.resolveGate({ config, policy: { enabled: airgap } })
    const endpoint = sources.endpoint()
    const refused = Telemetry.refusals(gate, endpoint)
    if (refused.length > 0) {
      outcome = { state: "refused", origin, refusals: refused }
    } else {
      sources.transmit({
        report: {
          plane: sources.plane,
          kind: errorKind(value),
          stack: errorStack(value),
          // ⚠️ Left undefined ON PURPOSE, and this is the call site's whole discipline. There is no
          // declared log event for "the process crashed", and an attribute bag assembled from a
          // crash is precisely how a prompt reaches a wire. Widening this is a change to
          // `CRASH_FIELDS`, not a change here.
          event: undefined,
          attributes: undefined,
        },
        gate,
        endpoint,
        host: sources.host(),
      })
      outcome = { state: "reported", origin }
    }
  } catch (fault) {
    outcome = { state: "faulted", origin, reason: fault instanceof Error ? fault.message : String(fault) }
  }
  last = outcome
  note(outcome)
  return outcome
}

// ── installation ────────────────────────────────────────────────────────────────────────────────

/** The `process`-shaped surface the handlers attach to. Injected so tests never touch the real one. */
export interface HandlerTarget {
  on(event: string, listener: (...args: never[]) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
}

export interface InstallOptions {
  readonly plane?: "server" | "ui"
  readonly sources?: Sources
  readonly target?: HandlerTarget
  /** Install even under `NODE_ENV=test`. Only this seam's own tests pass it. */
  readonly allowInTest?: boolean
}

/**
 * ⚠️ **A `Symbol.for` slot on `globalThis`, not a module-level boolean.**
 *
 * The double-install hazard is real in both directions and a module flag catches only one of them: a
 * process that calls `install()` twice (every `Server.listen` after the first — `web`, a test, a
 * relisten), and a process that loads this MODULE twice (the sidecar's vite bundle and a
 * dynamically-imported copy are two module instances with two sets of module state). A registry
 * keyed on a global symbol survives both, and a second install becomes an explicit no-op rather than
 * a second report for every crash.
 */
const SLOT = Symbol.for("novaclaw.observability.crash-capture.installed")
type Entry = { readonly uninstall: () => void }
const registry = globalThis as unknown as Record<symbol, Entry | undefined>

const noop = () => {}

/** The value re-raised by the rejection listener, awaiting its echo in the monitor. */
const NOTHING = Symbol("nothing")
let reraised: unknown = NOTHING

/** Whether a seam is installed in this process. */
export function installed(): boolean {
  return registry[SLOT] !== undefined
}

/**
 * Install the process-level capture. Returns the uninstaller; a refused install returns a no-op.
 *
 * **Refused when a seam is already installed** (see {@link SLOT}) **and when `NODE_ENV=test`** —
 * `bun test` sets that itself, and `Server.listen` is called by four test files, so without this the
 * suite would install a crash reporter that reports the suite's own deliberate failures. That guard
 * is the install-time half; the endpoint gate is the runtime half, and neither depends on the other.
 */
export function install(options: InstallOptions = {}): () => void {
  if (registry[SLOT] !== undefined) return noop
  if (options.allowInTest !== true && process.env["NODE_ENV"] === "test") return noop

  const target = options.target ?? (process as unknown as HandlerTarget)
  const sources = options.sources ?? liveSources(options.plane ?? "server")

  const onMonitor = ((error: unknown, origin?: unknown) => {
    try {
      // The echo of our own re-raise (measured: re-raising fires the monitor for the SAME object on
      // both runtimes). Reported once, by the listener that saw it first.
      if (reraised !== NOTHING && Object.is(error, reraised)) {
        reraised = NOTHING
        last = { state: "duplicate", origin: "unhandledRejection" }
        return
      }
      capture(error, origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException", sources)
    } catch {
      // ⚠️ Load-bearing: a monitor that throws was measured to REPLACE the crash and exit 7.
    }
  }) as (...args: never[]) => void

  const onRejection = ((reason: unknown) => {
    try {
      reraised = reason
      capture(reason, "unhandledRejection", sources)
    } catch {
      // never let the seam become the crash
    }
    // ⚠️ OUTSIDE the wrapper, and the only statement here that is allowed to throw. Merely having a
    // listener suppresses the crash on bun AND node (measured); re-raising restores the printed
    // stack and exit 1. This handler must not change what the process does.
    throw reason
  }) as (...args: never[]) => void

  const entry: Entry = {
    uninstall: () => {
      if (registry[SLOT] !== entry) return
      registry[SLOT] = undefined
      target.off("uncaughtExceptionMonitor", onMonitor)
      target.off("unhandledRejection", onRejection)
    },
  }

  target.on("uncaughtExceptionMonitor", onMonitor)
  target.on("unhandledRejection", onRejection)
  registry[SLOT] = entry
  return entry.uninstall
}

/** Tests only: forget the cached consent read, the re-raise latch and the last outcome. */
export function resetForTest(): void {
  consentAt = 0
  consentKey = undefined
  consentCache = undefined
  reraised = NOTHING
  last = undefined
}
