import crypto from "node:crypto"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
  ATTRIBUTE_CLASSES,
  type AttributeClass,
  type AttributeValue,
  egressSafe,
  EVENTS,
  type EventKey,
  mayEgress,
  subsystemOf,
} from "@novaclaw/schema/log-events"
import { CalloutPolicy } from "../callout-policy"
import { InstallationChannel, InstallationVersion } from "../installation/version"

/**
 * ── THE MAINTENANCE PLANE'S ONE OUTBOUND PATH ───────────────────────────────────────────────────
 *
 * `v0.2.0-batch-plan.md` item 3.2. This is the **only** subsystem in the product that deliberately
 * sends bytes off the user's machine, and AGENTS.md promises the data plane (chats, code, the KB)
 * **never egresses** and is fully airgappable. So a leak here is not a bug — it is the product's
 * central promise broken, and per ruling 1 the filter that prevents it ships with a machine behind
 * it rather than a code review.
 *
 * ── where the decision actually lives ───────────────────────────────────────────────
 *
 * 🔴 **The CLASSIFICATION is not done here, and that is stronger than any scrubber.**
 * `schema/log-events.ts` declares an `egress: true|false` class per attribute, so *"may this field
 * leave the machine?"* is answered at AUTHORING time rather than by a filter run over a log that has
 * already captured a prompt. Consent (`config.ts` `telemetry: { enabled }`) and its Developer-gated
 * switch (`settings-v2/general.tsx`, `minLevel="developer"`) live in their own places too.
 *
 * This file is only the consumer: a payload shape, the gates, and the transport — deliberately
 * **pure up to the last function**. `build` is a total function from inputs to a refusal or an
 * envelope, so every claim below is assertable without a server, a network, or a running instance.
 *
 * ── the four gates, and why they are four ───────────────────────────────────────────────────────
 *
 * Nothing is built at all until every gate passes, and the gates are independent on purpose:
 *
 *  1. **Consent** — `telemetry.enabled !== false`. On by default (AGENTS.md: a common user is
 *     *maintained, not surveilled* — they are helped, not handed a pager).
 *  2. **Airgap** — the live offline policy. ⚠️ **A SEPARATE CONDITION, not a default for gate 1.**
 *     AGENTS.md says telemetry is *"forced off in offline/airgap mode"* **regardless of the
 *     setting**, so a user who explicitly set `enabled: true` and then went airgapped must still
 *     send nothing. `refusals()` returns an ARRAY precisely so that when both hold, both are
 *     named — a single `reason` string lets one condition mask the other, and a masked condition is
 *     the shape "airgap merely flips the default" takes when someone refactors this later.
 *  3. **A destination** — no configured endpoint is a refusal with a name (`no_endpoint`), not
 *     silence. This is the state on every machine today: the intake VPS does not exist yet, so the
 *     honest report is *"refused: no_endpoint"* rather than a path that pretends to be live.
 *  4. **The event may egress** — a crash reported through a keyed log event is refused outright
 *     when `mayEgress(key)` is false.
 *
 * ── what stops the UNSAFE direction (the question ruling 1 makes us answer) ──────────────────────
 *
 * *What stops a future attribute from defaulting to sendable?* Nothing about a class is optional —
 * `ATTRIBUTE_CLASSES` has no default and a new class must state its `egress` — but a class could
 * still be classified WRONGLY. So misclassification is caught a second time, at the VALUE:
 * `valueFault` requires an egress-safe string to match {@link ID_SHAPE}, a bounded closed-vocabulary
 * token. A path (`/` or `\` or `:`), a prompt or a message (spaces), a stack trace (newlines,
 * parens) and an email (`@`) each fail it. A field that lies about its class therefore still cannot
 * carry content.
 *
 * *What stops someone adding a crash-signature field that carries user content?* Three things, and
 * the first is a compiler:
 *
 *  · {@link CRASH_FIELDS} declares `class: EgressSafeClass`, which is COMPUTED from
 *    `ATTRIBUTE_CLASSES` — `{[C in AttributeClass]: …egress extends true ? C : never}[…]`. Writing
 *    `class: "text"` (or `path`, or `fault`) does not compile. The unsafe direction is the one that
 *    fails the build.
 *  · every value is checked against its class by `valueFault`, and a field that fails is **omitted**
 *    from the envelope — never sent raw, never truncated into something that passes.
 *  · `telemetry.test.ts` walks the built envelope and demands that every leaf is a declared field
 *    or a declared egress-safe attribute of the declared event, with a value its class admits. The
 *    walk is negative-controlled: the same assertion is driven over poisoned input and must fail.
 *
 * ── what is deliberately NOT in the payload ─────────────────────────────────────────────────────
 *
 * No error message. No stack text. No file path. No hostname, username, machine id, session id,
 * project name or working directory. No wall-clock timestamp of the build.
 *
 * 🔴 **A session id is class `correlate` (`content: "correlated"`), and THAT is what keeps the
 * "no session id" clause true.** Do not weaken it to `id`: `correlate` makes those events
 * `mayEgress === false` and refuses them at gate 4, one rung EARLIER than the attribute pass. The
 * clause was once false precisely because the class was `id` and `id` was egress-safe — gate 4
 * passed the event and {@link filterAttributes} kept the field. The TYPE is the enforcement; a
 * filter in this file is not.
 * ⭐ The lesson that generalises: **an absence stated in prose is the one claim nothing tests.**
 * Every positive field here is walked by `telemetry.test.ts`; the sentence listing what is *not*
 * sent was the only assertion in the module with no machine behind it, and it was the one that was
 * wrong. `telemetry.test.ts` now drives that envelope and demands a refusal.
 *
 * ⚠️ **The build-stamp rule is a threat model, not tidiness.** A stamp like
 * `-nightly.20260731t065756` is near-unique and would identify one machine, so {@link releaseLine}
 * strips everything after `major.minor.patch`. A crash signature that fingerprints the reporter is a
 * data-plane leak wearing a maintenance-plane label.
 *
 * ── one manifest, so the disclosure cannot drift from the payload ───────────────────────────────
 *
 * `CRASH_FIELDS` carries each field's `meaning` and `condition` next to its class, and `preview` IS
 * `build` — the same reference, pinned by a test. ⚠️ **Never hand-write the user-facing
 * disclosure.** A prose copy of the payload is a second source of truth that a schema change
 * falsifies silently, and a disclosure that is quietly wrong is worse than none — it IS the promise,
 * not documentation of it. The manifest is authored first and the prose derives from it.
 */
export * as Telemetry from "./telemetry"

// ── the classes a payload may carry ─────────────────────────────────────────────────────────────

/**
 * **The attribute classes that may leave this machine — DERIVED, never listed.**
 *
 * Computed from each class's own declared plane (`ATTRIBUTE_CLASSES[c].content === "none"`), so it
 * cannot fall out of step with it: re-classifying `path` as content-free in `schema/log-events.ts`
 * would widen this type here, in core, with no edit — which is exactly why the test PINS the
 * resulting set. Widening the set is a decision someone makes on purpose in two files, not a side
 * effect of one.
 *
 * ⚠️ **The `correlate` class is excluded by this computation and by
 * nothing else.** It was not added to a list here, and there is no list here to add it to — a
 * session id is `content: "correlated"`, so `extends "none"` is false and the class is not
 * expressible in {@link CRASH_FIELDS}. That is the property this derivation exists for.
 */
export type EgressSafeClass = {
  [C in AttributeClass]: (typeof ATTRIBUTE_CLASSES)[C]["content"] extends "none" ? C : never
}[AttributeClass]

/** The same set as a runtime value, derived the same way. Sorted, so the test can compare it. */
export const egressSafeClasses = (): ReadonlyArray<EgressSafeClass> =>
  (Object.keys(ATTRIBUTE_CLASSES) as AttributeClass[])
    .filter((name): name is EgressSafeClass => egressSafe(name))
    .sort()

/**
 * **The shape an egress-safe STRING must have.** A bounded closed-vocabulary token: a leading
 * alphanumeric, then up to 63 more of `[A-Za-z0-9._-]`.
 *
 * This is the second line of defence and the one that catches a MISCLASSIFIED field, so the
 * exclusions are the point: no space (a message, a prompt, a command line), no `/` or `\` or `:`
 * (a path, a URL, a drive letter), no `@` (an email), no newline or `(` or `)` (a stack trace), no
 * quote. And 64 characters is short enough that nothing interesting survives truncation — which is
 * why a value that fails is DROPPED rather than trimmed to fit.
 */
export const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Why `value` is not admissible for `class`, or `undefined` when it is.
 *
 * Pure and exported so the test can drive it over synthetic poison — a validator that is only ever
 * run against inputs it already accepts proves nothing (AGENTS.md: a counter that can lie about the
 * thing it counts is worse than no counter).
 */
export function valueFault(cls: EgressSafeClass, value: unknown): string | undefined {
  switch (cls) {
    case "flag":
      return typeof value === "boolean" ? undefined : `expected a boolean, got ${typeof value}`
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? undefined
        : `expected a safe integer, got ${typeof value === "number" ? String(value) : typeof value}`
    case "id":
      if (typeof value !== "string") return `expected a string, got ${typeof value}`
      return ID_SHAPE.test(value)
        ? undefined
        : `"${value.slice(0, 24)}…" is not a bounded closed-vocabulary token (ID_SHAPE)`
  }
}

// ── the crash signature: the field manifest ─────────────────────────────────────────────────────

/** One declared payload field. `class` is `EgressSafeClass`, so a content-bearing class does not compile. */
export type FieldDeclaration = {
  /** The attribute class this field carries. Only egress-safe classes are expressible. */
  readonly class: EgressSafeClass
  /** What the field means, in one sentence. The disclosure reads this — there is no second copy. */
  readonly meaning: string
  /** When it is collected. `"always"`, or the condition under which it is present. */
  readonly condition: string
}

/**
 * **THE CRASH SIGNATURE — every field the maintenance plane may ever carry, declared once.**
 *
 * ⚠️ The compile-time guard lives in the two words `satisfies Record<string, FieldDeclaration>`
 * combined with `class: EgressSafeClass`. A field declared `class: "text"` — or `path`, or
 * `fault` — is a type error, so the leak this whole file exists to prevent is caught before the
 * tree builds. Adding a field is deliberately cheap; adding an UNSAFE field is deliberately
 * impossible.
 */
export const CRASH_FIELDS = {
  plane: {
    class: "id",
    meaning: "Which half of the instance faulted: the server or the UI.",
    condition: "always",
  },
  signature: {
    class: "id",
    meaning:
      "A hex digest over the error kind and its normalised stack frames. The frames themselves are hashed and never sent — this is what lets two reports be recognised as the same bug without carrying anyone's paths.",
    condition: "always",
  },
  kind: {
    class: "id",
    meaning: "The error's constructor name (TypeError, HttpClientError, …). Code-derived, never user-derived.",
    condition: "always",
  },
  frames: {
    class: "count",
    meaning: "How many stack frames fed the signature. A depth, not a location.",
    condition: "when a stack was available",
  },
  event: {
    class: "id",
    meaning: "The declared log-event key the crash was reported through, when it arrived through one.",
    condition: "when the report names a log event that may egress",
  },
  subsystem: {
    class: "id",
    meaning: "The event key's first segment, parsed. Lets a fault be routed without reading the key.",
    condition: "with `event`",
  },
  release: {
    class: "id",
    meaning:
      "The release line — major.minor.patch only. Any pre-release or build stamp is stripped, because a per-build timestamp is near-unique and would identify one machine.",
    condition: "always",
  },
  channel: {
    class: "id",
    meaning: "The installation channel this build ships on (local, dev, beta, prod).",
    condition: "always",
  },
  platform: {
    class: "id",
    meaning: "The OS family (win32, linux, darwin). Not a version, not a hostname.",
    condition: "always",
  },
  arch: {
    class: "id",
    meaning: "The CPU architecture (x64, arm64).",
    condition: "always",
  },
  runtime: {
    class: "id",
    meaning: "The JavaScript runtime and its version (bun-1.2.23).",
    condition: "always",
  },
  repeat: {
    class: "count",
    meaning:
      "How many times this signature has fired since this process booted. A loop reads differently from a one-off.",
    condition: "always",
  },
  uptime: {
    class: "count",
    meaning: "Whole seconds since this process started. Distinguishes a boot fault from a fault after hours of work.",
    condition: "always",
  },
} as const satisfies Record<string, FieldDeclaration>

export type CrashField = keyof typeof CRASH_FIELDS

/**
 * The payload type, DERIVED from the manifest — so a field's TypeScript type is decided by its
 * declared class and there is no place to write one down twice.
 */
export type CrashSignature = {
  readonly [F in CrashField]?: AttributeValue[(typeof CRASH_FIELDS)[F]["class"]]
}

/** Every declared field, sorted. */
export const fields = (): ReadonlyArray<CrashField> => (Object.keys(CRASH_FIELDS) as CrashField[]).sort()

// ── the two independent disable conditions ──────────────────────────────────────────────────────

/**
 * The two conditions, held apart.
 *
 * ⚠️ **Two fields, not one boolean**, and `resolveGate` reads each from a different source with no
 * cross-reference. The test drives all four combinations and asserts that changing only the config
 * never moves `airgap` and changing only the policy never moves `consent` — which is what makes
 * "airgap force-disables INDEPENDENTLY" a checked fact rather than a sentence in a comment.
 */
export interface Gate {
  /** `telemetry.enabled !== false`. Absent config means ON — the managed-by-default stance. */
  readonly consent: boolean
  /** The live offline/airgap policy. Forces telemetry off regardless of `consent`. */
  readonly airgap: boolean
}

/** Every reason a report can be refused. Named, so a refusal is never silence. */
export type Refusal =
  | "consent_off"
  | "airgap"
  | "no_endpoint"
  | "content_bearing_event"
  | "unknown_event"
  | "empty_signature"

/**
 * Read the two conditions from the two sources.
 *
 * ⚠️ `config` is `unknown` on purpose: this must not import the config schema, because the moment
 * it does, "the airgap flag" and "the consent flag" become two fields of one object that a later
 * refactor can collapse into one expression. Two parameters, two reads, no shared derivation.
 */
export function resolveGate(input: { readonly config: unknown; readonly policy: { readonly enabled: boolean } }): Gate {
  const telemetry = (input.config as { telemetry?: { enabled?: unknown } } | undefined)?.telemetry
  return {
    // Default ON. AGENTS.md design-principle 4: on by default, disableable only in Developer mode.
    consent: telemetry?.enabled !== false,
    airgap: input.policy.enabled === true,
  }
}

/**
 * Every gate condition that currently refuses, in a stable order.
 *
 * ⚠️ An ARRAY, not a first-match string. When consent is off AND the machine is airgapped, both
 * appear — so a status surface tells the truth about both, and a refactor that made one condition
 * mask the other changes this function's output and fails its truth table.
 */
export function refusals(gate: Gate, endpoint: string | undefined): ReadonlyArray<Refusal> {
  const out: Refusal[] = []
  if (!gate.consent) out.push("consent_off")
  if (gate.airgap) out.push("airgap")
  if (endpoint === undefined || endpoint.trim() === "") out.push("no_endpoint")
  return out
}

/**
 * The configured intake endpoint, or `undefined`.
 *
 * The environment is the emergency override. Normal builds use the compiled maintenance-plane
 * intake from `endpointFromConfig`; the runtime `telemetry.endpoint` setting can point a staged or
 * self-hosted build elsewhere without replacing the application.
 */
export function endpointFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env["NOVACLAW_TELEMETRY_ENDPOINT"]
  return value === undefined || value.trim() === "" ? undefined : value.trim()
}

/** The maintenance-plane intake shipped with the application. A deployment may override it at runtime. */
export const DEFAULT_ENDPOINT = "https://telemetry.novaclaw.app/v1/crashes"

/** Resolve the endpoint in the same order in every producer: environment, runtime settings, default. */
export function endpointFromConfig(
  config: unknown,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const explicit = endpointFromEnv(env)
  if (explicit !== undefined) return explicit
  const configured = (config as { telemetry?: { endpoint?: unknown } } | undefined)?.telemetry?.endpoint
  return typeof configured === "string" && configured.trim() !== "" ? configured.trim() : DEFAULT_ENDPOINT
}

// ── normalisation ───────────────────────────────────────────────────────────────────────────────

/**
 * `0.1.57` → `0.1.57`. `0.2.0-nightly.20260731t065756` → `0.2.0`. Anything else → `unknown`.
 *
 * The stripping is the threat model, not cosmetics — see this module's header.
 */
export function releaseLine(version: string | undefined): string {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})/.exec(version ?? "")
  return match ? `${match[1]}.${match[2]}.${match[3]}` : "unknown"
}

/**
 * A stack, reduced to the frames that identify the bug: the callee and `basename:line:col`.
 *
 * The absolute path is dropped HERE rather than at the sender, so the same crash on two machines
 * produces the same digest — which is the only reason a signature is worth clustering. Nothing this
 * returns is ever sent; it is hashing input.
 */
export function normalizeFrames(stack: string | undefined, limit = 12): ReadonlyArray<string> {
  if (!stack) return []
  const out: string[] = []
  for (const raw of stack.split("\n")) {
    const line = raw.trim()
    if (!line.startsWith("at ")) continue
    const body = line.slice(3)
    const open = body.lastIndexOf("(")
    const callee = open > 0 ? body.slice(0, open).trim() : "<anonymous>"
    const location = open > 0 ? body.slice(open + 1).replace(/\)$/, "") : body
    // `basename:line:col`, with any drive letter, URL scheme or directory chain discarded.
    const tail = location.split(/[\\/]/).pop() ?? location
    out.push(`${callee}@${tail}`)
    if (out.length >= limit) break
  }
  return out
}

/** The digest that identifies a bug without identifying a machine. 16 hex characters of SHA-256. */
export function fingerprint(kind: string, frames: ReadonlyArray<string>): string {
  return crypto
    .createHash("sha256")
    .update([kind, ...frames].join("\n"))
    .digest("hex")
    .slice(0, 16)
}

/** A code-derived identifier, coerced into ID_SHAPE or dropped. Never a message, never a path. */
function token(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return ID_SHAPE.test(trimmed) ? trimmed : undefined
}

// ── the repeat counter ──────────────────────────────────────────────────────────────────────────

/**
 * How many times each signature has fired since boot. BOUNDED at 64 distinct signatures: a process
 * generating more than 64 distinct crash shapes has a different problem, and an unbounded map on
 * the crash path is a second fault waiting for the first one.
 */
const REPEAT_LIMIT = 64
const repeats = new Map<string, number>()

/** Count `signature` and return its new total. Saturates at the limit rather than growing. */
export function countRepeat(signature: string): number {
  const seen = repeats.get(signature)
  if (seen !== undefined) {
    const next = seen + 1
    repeats.set(signature, next)
    return next
  }
  if (repeats.size >= REPEAT_LIMIT) return 1
  repeats.set(signature, 1)
  return 1
}

/** Tests only: forget the counters so one file's reports cannot leak into the next. */
export function resetRepeats(): void {
  repeats.clear()
}

// ── the envelope ────────────────────────────────────────────────────────────────────────────────

/** What a caller hands in. Everything here is raw — nothing is trusted, everything is filtered. */
export interface Report {
  readonly plane: "server" | "ui"
  /** The error's constructor name. */
  readonly kind: string
  /** The raw stack. Hashed into `signature` and then discarded — never sent. */
  readonly stack?: string
  /** The declared log-event key this fault was reported through, if any. */
  readonly event?: string
  /** The event's attributes, exactly as the call site had them. Filtered by declared class. */
  readonly attributes?: Readonly<Record<string, unknown>>
  /** Whole seconds since process start. Defaults to the live `process.uptime()`. */
  readonly uptimeSeconds?: number
}

/** The host facts the envelope reports. Injected so the test is not a mirror of the machine. */
export interface Host {
  readonly version: string
  readonly channel: string
  readonly platform: string
  readonly arch: string
  readonly runtime: string
}

/** The live host, read once per call. */
export function host(): Host {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun?.version
  return {
    version: InstallationVersion,
    channel: InstallationChannel,
    platform: process.platform,
    arch: process.arch,
    runtime: bun ? `bun-${bun}` : `node-${process.versions.node}`,
  }
}

/** The envelope that goes on the wire. Nothing else does. */
export interface Envelope {
  readonly signature: CrashSignature
  /** The declared, egress-safe attributes of the declared event. Empty when there is no event. */
  readonly attributes: Readonly<Record<string, string | number | boolean>>
}

/** Why each field the caller offered did not make it into the envelope. The disclosure's other half. */
export interface Dropped {
  readonly name: string
  readonly reason: string
}

export type Build =
  | { readonly ok: true; readonly envelope: Envelope; readonly dropped: ReadonlyArray<Dropped> }
  | { readonly ok: false; readonly refusals: ReadonlyArray<Refusal>; readonly dropped: ReadonlyArray<Dropped> }

/**
 * **The attribute filter — three passes, deliberately redundant.**
 *
 *   · a name the declaration does not carry is DROPPED. An undeclared field has no class, so there
 *     is no honest way to decide it, and *unknown* must never mean *send it*.
 *   · a declared name whose class is not egress-safe is DROPPED.
 *   · a surviving value that does not match its class is DROPPED — never coerced, never truncated.
 *
 * ⚠️ **Exported, and separate from `build`, because the middle pass is currently UNREACHABLE through
 * `build` and that is only true by someone else's test.** Every declared event whose `content` is
 * `"none"` has only egress-safe attributes today — `log-events.test.ts` asserts that declared and
 * derived content agree — so the `mayEgress` gate refuses those events before this pass ever sees
 * one. A guard whose failure mode cannot be reached is a guard nobody has shown to work, so this
 * function takes its declaration map as a PARAMETER and the test drives it with a synthetic one.
 * The day `schema/log-events.ts` drifts, this is what still stands.
 */
export function filterAttributes(
  declared: Readonly<Record<string, AttributeClass>> | undefined,
  attributes: Readonly<Record<string, unknown>> | undefined,
): { readonly kept: Record<string, string | number | boolean>; readonly dropped: ReadonlyArray<Dropped> } {
  const kept: Record<string, string | number | boolean> = {}
  const dropped: Dropped[] = []
  for (const [name, value] of Object.entries(attributes ?? {})) {
    const cls = declared?.[name]
    if (cls === undefined) {
      dropped.push({ name, reason: declared ? "not declared on this event" : "no event declared" })
      continue
    }
    if (!egressSafe(cls)) {
      dropped.push({ name, reason: `class "${cls}" never egresses` })
      continue
    }
    const fault = valueFault(cls as EgressSafeClass, value)
    if (fault !== undefined) {
      dropped.push({ name, reason: fault })
      continue
    }
    kept[name] = value as string | number | boolean
  }
  return { kept, dropped }
}

/**
 * **THE ONE FUNCTION THAT DECIDES WHAT LEAVES THIS MACHINE.**
 *
 * Total, pure and synchronous: no I/O, no clock beyond an injected uptime, no config read. `send`
 * transmits what this returns and `preview` IS this function, so the payload a user is shown and the
 * payload we transmit are the same bytes by construction rather than by discipline.
 *
 * The order matters and is asserted: the gates are consulted BEFORE anything is built, so a refused
 * report never materialises a payload that a later edit could accidentally log, cache or return.
 */
export function build(input: {
  readonly report: Report
  readonly gate: Gate
  readonly endpoint: string | undefined
  readonly host: Host
}): Build {
  const dropped: Dropped[] = []

  // Gate 1–3. Nothing is constructed until these pass.
  const refused = refusals(input.gate, input.endpoint)
  if (refused.length > 0) return { ok: false, refusals: refused, dropped }

  const { report } = input

  // Gate 4 — the event, if one was named, must be declared AND may-egress.
  let event: EventKey | undefined
  if (report.event !== undefined) {
    if (!(report.event in EVENTS)) return { ok: false, refusals: ["unknown_event"], dropped }
    if (!mayEgress(report.event as EventKey)) return { ok: false, refusals: ["content_bearing_event"], dropped }
    event = report.event as EventKey
  }

  const filtered = filterAttributes(event ? EVENTS[event].attributes : undefined, report.attributes)
  const attributes = filtered.kept
  dropped.push(...filtered.dropped)

  const frames = normalizeFrames(report.stack)
  const kind = token(report.kind) ?? "unknown"
  const signatureHash = fingerprint(kind, frames)
  const uptime = report.uptimeSeconds ?? Math.floor(process.uptime())

  // Every field is offered, then checked against its declared class exactly like an attribute is.
  // A field that fails is omitted — the manifest says a field MAY be present, never that it is.
  const offered: { readonly [F in CrashField]?: unknown } = {
    plane: report.plane,
    signature: signatureHash,
    kind,
    ...(frames.length > 0 ? { frames: frames.length } : {}),
    ...(event ? { event, subsystem: subsystemOf(event) } : {}),
    release: releaseLine(input.host.version),
    channel: token(input.host.channel) ?? "unknown",
    platform: token(input.host.platform) ?? "unknown",
    arch: token(input.host.arch) ?? "unknown",
    runtime: token(input.host.runtime) ?? "unknown",
    repeat: countRepeat(signatureHash),
    uptime: Number.isSafeInteger(uptime) && uptime >= 0 ? uptime : 0,
  }

  const signature: Record<string, string | number | boolean> = {}
  for (const name of fields()) {
    const value = offered[name]
    if (value === undefined) continue
    const fault = valueFault(CRASH_FIELDS[name].class, value)
    if (fault !== undefined) {
      dropped.push({ name, reason: fault })
      continue
    }
    signature[name] = value as string | number | boolean
  }

  // A signature that lost its identifying fields is not a report worth sending; it is noise with a
  // shape. Refuse rather than transmit an envelope that says nothing.
  if (signature["signature"] === undefined || signature["plane"] === undefined)
    return { ok: false, refusals: ["empty_signature"], dropped }

  return { ok: true, envelope: { signature: signature as CrashSignature, attributes }, dropped }
}

/**
 * **`telemetry status` — the payload we WOULD send, built by the send path itself.**
 *
 * ⚠️ It is `build`, by reference, and a test pins that identity. A preview that re-describes the
 * payload in its own code is a second copy and will eventually lie — which is the open issue
 * (kirodotdev/kirocrew#1037) this design was taken from. A privacy promise stated in prose is a
 * claim; a function that prints the bytes is checkable by someone who cannot read source, which is
 * the anti-obscurantist version of the same promise.
 *
 * ⚠️ **This must never inherit the Developer gate that hides the disable SWITCH.** A disclosure only
 * the developer tier can read is theatre.
 */
export const preview = build

// Readiness is intentionally process-local. A configured URL is not evidence that this instance's
// collector accepts reports; only the end-to-end probe below can promote that exact destination.
let readyEndpoint: string | undefined

export function intakeReady(endpoint: string | undefined): boolean {
  return endpoint !== undefined && endpoint === readyEndpoint
}

/** Tests only: clear the last successful intake probe. */
export function resetIntakeProbe(): void {
  readyEndpoint = undefined
}

/**
 * Exercise the collector's probe contract without creating a crash record. The collector must
 * return 2xx to the same intake URL; the body is a fixed code-derived marker and contains no
 * envelope, error, or user data.
 */
export const probe = (endpoint: string): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.setHeader("x-novaclaw-intake-probe", "1"),
      HttpClientRequest.bodyJsonUnsafe({ probe: "novaclaw-crash-intake" }),
      client.execute,
      Effect.timeout(CalloutPolicy.telemetryLogs.timeoutMs),
      Effect.map((response) => response.status >= 200 && response.status < 300),
      Effect.tap((accepted) =>
        accepted
          ? Effect.sync(() => {
              readyEndpoint = endpoint
            })
          : Effect.void,
      ),
      Effect.catchCause(() => Effect.succeed(false)),
    )
  })

export interface Status {
  /** The two independent live policy facts. */
  readonly gate: Gate
  /** Whether a real collector is configured. The URL itself is operational data and stays local. */
  readonly endpointConfigured: boolean
  /** True only after the configured collector accepted the fixed end-to-end intake probe. */
  readonly ready: boolean
  /** Every live reason an actual report would be refused, in enforcement order. */
  readonly refusals: ReadonlyArray<Refusal>
  /** A synthetic crash lowered by `preview` — the exact envelope shape, with no real crash context. */
  readonly payloadPreview?: Envelope
  /** The field manifest that generated both the envelope and the human-readable disclosure. */
  readonly disclosure: ReturnType<typeof disclosure>
}

/**
 * The ordinary-user telemetry status surface.
 *
 * The live gates are reported separately from the payload preview: a machine with no collector must
 * still be able to inspect what WOULD leave if one were configured. The preview therefore uses an
 * explicitly synthetic error and an inert placeholder endpoint, but still passes through `preview`
 * (which is `build` by reference). No real error, path, message, event or attribute enters this path.
 */
export function status(input: {
  readonly config: unknown
  readonly policy: { readonly enabled: boolean }
  readonly endpoint: string | undefined
  readonly host: Host
}): Status {
  const gate = resolveGate({ config: input.config, policy: input.policy })
  const endpoint = endpointFromConfig(input.config, { NOVACLAW_TELEMETRY_ENDPOINT: input.endpoint })
  const built = preview({
    report: {
      plane: "server",
      kind: "TelemetryPreview",
      stack: "TelemetryPreview\n    at status (telemetry-preview.ts:1:1)",
      uptimeSeconds: 0,
    },
    gate: { consent: true, airgap: false },
    endpoint: "https://telemetry-preview.invalid/intake",
    host: input.host,
  })
  return {
    gate,
    endpointConfigured: endpoint !== undefined,
    ready: intakeReady(endpoint),
    refusals: refusals(gate, endpoint),
    ...(built.ok ? { payloadPreview: built.envelope } : {}),
    disclosure: disclosure(),
  }
}

/** The disclosure table: every field, its meaning and when it is collected. One source, no copies. */
export function disclosure(): ReadonlyArray<{
  readonly field: CrashField
  readonly class: EgressSafeClass
  readonly meaning: string
  readonly condition: string
}> {
  return fields().map((field) => ({
    field,
    class: CRASH_FIELDS[field].class,
    meaning: CRASH_FIELDS[field].meaning,
    condition: CRASH_FIELDS[field].condition,
  }))
}

// ── the transport ───────────────────────────────────────────────────────────────────────────────

/**
 * POST one envelope. `CalloutPolicy.telemetryLogs` governs it: async, 3 s, fail_open — the
 * maintenance plane must never be able to slow down or fault the thing it is maintaining.
 *
 * It takes an `Envelope`, not a `Report`, so there is no way to reach the wire without going
 * through `build`. That is the whole point of the signature: the gates are not a step a caller can
 * skip, they are the only door that produces the argument this function needs.
 */
export const send = (endpoint: string, envelope: Envelope): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeader("content-type", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(envelope),
      client.execute,
      Effect.timeout(CalloutPolicy.telemetryLogs.timeoutMs),
      Effect.map((response) => response.status >= 200 && response.status < 300),
      // fail_open, and total: a crash report that fails must never become a second crash.
      Effect.catchCause(() => Effect.succeed(false)),
    )
  })

/**
 * Build and, if every gate passes, send. The one call a crash site makes.
 *
 * Returns the `Build` so the caller can record WHY nothing was sent — ruling 2: a fault is never
 * described falsely, and "we refused because the machine is airgapped" is a different fact from
 * "we tried and it failed".
 */
export const report = (input: {
  readonly report: Report
  readonly gate: Gate
  readonly endpoint: string | undefined
  readonly host: Host
}): Effect.Effect<Build, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const built = build(input)
    if (built.ok && input.endpoint !== undefined) yield* send(input.endpoint, built.envelope)
    return built
  })
