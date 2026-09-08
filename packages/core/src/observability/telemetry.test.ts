import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ATTRIBUTE_CLASSES, egressSafe, EVENTS, type EventKey } from "@novaclaw/schema/log-events"
import {
  build,
  countRepeat,
  CRASH_FIELDS,
  type CrashField,
  disclosure,
  egressSafeClasses,
  type EgressSafeClass,
  type Envelope,
  endpointFromEnv,
  fields,
  filterAttributes,
  fingerprint,
  type Gate,
  type Host,
  ID_SHAPE,
  intakeReady,
  normalizeFrames,
  preview,
  status,
  refusals,
  releaseLine,
  report,
  probe,
  resetIntakeProbe,
  resetRepeats,
  resolveGate,
  send,
  valueFault,
} from "./telemetry"

/**
 * **The mechanical half of batch item 3.2.** Ruling 1: an invariant whose violation compiles green
 * ships with a check, or the invariant does not exist — and this is the single most important
 * absence assertion in the codebase, because the promise it defends is AGENTS.md's central one:
 * *the data plane never egresses.*
 *
 * The type system already closes two doors and they are not re-tested here except as a pin:
 * an undeclared log-event key does not compile, and a `CRASH_FIELDS` entry declared `class: "text"`
 * does not compile (`class` is `EgressSafeClass`, computed from `ATTRIBUTE_CLASSES`' own flags).
 * Everything below is what compiles green forever:
 *
 *   · a value that lies about its class — a path stuffed into an `id`, a stack into a `count`;
 *   · an attribute the event never declared, arriving from a call site that "knows" it is safe;
 *   · airgap collapsing into a DEFAULT for consent instead of an independent veto;
 *   · a refusal string where one condition masks the other;
 *   · a preview that re-describes the payload instead of building it;
 *   · a build stamp riding along in the version and near-uniquely identifying one machine.
 *
 * ⚠️ **Every absence assertion below is negative-controlled.** `expect(body).not.toContain(secret)`
 * against the real builder proves only that the builder is clean today — it cannot show the
 * assertion is capable of reporting anything at all. So each one has a sibling that drives the SAME
 * scan over a deliberately leaky builder and demands it fire. A test asserting "no user content was
 * sent" that could never go red is worse than no test.
 */

const HOST: Host = {
  version: "0.2.0-nightly.20260731t065756",
  channel: "prod",
  platform: "win32",
  arch: "x64",
  runtime: "bun-1.2.23",
}

const OPEN: Gate = { consent: true, airgap: false }
const ENDPOINT = "https://telemetry.example.invalid/crash"

/** A content-bearing event: `content: "user"`, with `path`/`fault` attributes. */
const CONTENT_EVENT = "filesystem.watcher.init.failed" satisfies EventKey
/** An egress-safe event: `content: "none"`, every attribute an `id`/`count`/`flag`. */
const SAFE_EVENT = "session.compaction.prune.planned" satisfies EventKey

/** The strings that must never reach the wire, in the shapes a real crash would carry them. */
const SECRETS = {
  message: "Cannot read properties of undefined (reading 'apiKey')",
  home: "C:\\Users\\nangl\\d\\code\\llm\\novaclaw\\packages\\core\\src\\session\\runner\\llm.ts",
  prompt: "summarise my divorce settlement and email it to my lawyer",
  project: "/home/nancy/clients/acme-merger-2026",
} as const

const STACK = [
  `TypeError: ${SECRETS.message}`,
  `    at drain (${SECRETS.home}:412:19)`,
  `    at processTicksAndRejections (node:internal/process/task_queues:95:5)`,
].join("\n")

beforeEach(() => {
  resetRepeats()
  resetIntakeProbe()
})

// ── 0. the sweep reached something ──────────────────────────────────────────────────────────────

describe("the sweep reached something", () => {
  test("the manifest, the class set and the event set are all non-trivial", () => {
    // Every assertion below is a filter over these. If a refactor emptied one, each would become a
    // tautology that passes forever — the guard-shaped no-op.
    expect(fields().length).toBeGreaterThanOrEqual(10)
    expect(egressSafeClasses().length).toBeGreaterThanOrEqual(2)
    expect(Object.keys(EVENTS).length).toBeGreaterThanOrEqual(50)
    expect(disclosure().length).toBe(fields().length)
  })

  test("the two fixture events really are the two classes this file needs", () => {
    // A fixture that quietly stopped being content-bearing would make the refusal test vacuous.
    expect(EVENTS[CONTENT_EVENT].content).toBe("user")
    expect(EVENTS[SAFE_EVENT].content).toBe("none")
    expect(Object.keys(EVENTS[CONTENT_EVENT].attributes).length).toBeGreaterThan(0)
    expect(Object.keys(EVENTS[SAFE_EVENT].attributes).length).toBeGreaterThan(0)
  })
})

// ── 1. the egress-safe class set ────────────────────────────────────────────────────────────────

describe("the egress-safe class set is derived, and pinned", () => {
  test("exactly these three classes may leave the machine", () => {
    // ⚠️ This is the ONE place the set is written down twice, on purpose. `EgressSafeClass` is
    // computed from `ATTRIBUTE_CLASSES`, so flipping `path` to `egress: true` in schema/ would
    // silently widen every payload in this file with no edit in core. Widening it must be a
    // decision someone makes in two files.
    expect(egressSafeClasses()).toEqual(["count", "flag", "id"])
  })

  test("and the pin agrees with the declarations it was derived from", () => {
    const derived = (Object.keys(ATTRIBUTE_CLASSES) as Array<keyof typeof ATTRIBUTE_CLASSES>)
      .filter((name) => egressSafe(name))
      .sort()
    expect(egressSafeClasses()).toEqual(derived as ReadonlyArray<EgressSafeClass>)
    // and the content-bearing ones are still content-bearing
    expect(egressSafe("path")).toBe(false)
    expect(egressSafe("text")).toBe(false)
    expect(egressSafe("fault")).toBe(false)
    expect(egressSafe("list")).toBe(false)
    // ⚠️ **`correlate` is the class that split correlation ids out of `id`, and it is the reason the pin above
    // still reads `["count","flag","id"]`.** A session id used to be class `id` and therefore
    // egress-safe; it is now its own class, content-free but never sent. Asserted here rather than
    // only in the pin, because the pin would also stay green if the class had simply never been
    // added — this is the assertion that says it exists AND is excluded.
    expect(egressSafe("correlate")).toBe(false)
    expect(ATTRIBUTE_CLASSES.correlate.content).toBe("correlated")
    // …and `egress` is not a second field anybody can set: the answer is computed from `content`.
    expect("egress" in ATTRIBUTE_CLASSES.id).toBe(false)
  })

  test("every crash field's class is one of them — the runtime twin of the compile-time guard", () => {
    const safe = new Set<string>(egressSafeClasses())
    const unsafe = fields().filter((f) => !safe.has(CRASH_FIELDS[f].class))
    expect(unsafe).toEqual([])
    // negative control: the same predicate, over a synthetic manifest entry that is NOT safe.
    const forged = { class: "text", meaning: "m", condition: "c" } as const
    expect(safe.has(forged.class)).toBe(false)
  })

  test("every crash field carries a meaning and a condition — the disclosure has no blank rows", () => {
    const blank = disclosure().filter((row) => row.meaning.trim().length < 10 || row.condition.trim().length === 0)
    expect(blank).toEqual([])
  })
})

// ── 2. valueFault — the second line of defence ──────────────────────────────────────────────────

describe("valueFault admits closed vocabulary and refuses content", () => {
  test("the shapes a real payload uses all pass", () => {
    for (const value of ["win32", "x64", "bun-1.2.23", "0.2.0", "session.compaction.prune.planned", "a1b2c3d4e5f60718"])
      expect(valueFault("id", value)).toBeUndefined()
    expect(valueFault("count", 0)).toBeUndefined()
    expect(valueFault("count", 4096)).toBeUndefined()
    expect(valueFault("flag", false)).toBeUndefined()
  })

  test("⚠️ NEGATIVE CONTROL — every content shape a misclassified field could carry is refused", () => {
    const poison: ReadonlyArray<readonly [string, unknown]> = [
      ["a windows path", SECRETS.home],
      ["a posix path", SECRETS.project],
      ["an error message", SECRETS.message],
      ["a user prompt", SECRETS.prompt],
      ["a stack frame", "    at drain (llm.ts:412:19)"],
      ["a whole stack", STACK],
      ["an email", "nangld85@gmail.com"],
      ["a url", "https://novaclaw.app/x"],
      ["a newline", "ok\nnot-ok"],
      ["a quoted string", 'say "hello"'],
      ["a shell command", "rm -rf /"],
      ["an over-long token", "a".repeat(65)],
      ["an empty string", ""],
      ["a leading dot", ".hidden"],
    ]
    for (const [label, value] of poison) {
      const fault = valueFault("id", value)
      expect(`${label}: ${fault ?? "ACCEPTED"}`).not.toContain("ACCEPTED")
    }
    // and the classes cannot be fooled by a value of the wrong TYPE either
    expect(valueFault("count", "12")).toBeDefined()
    expect(valueFault("count", 1.5)).toBeDefined()
    expect(valueFault("count", Number.NaN)).toBeDefined()
    expect(valueFault("count", Number.POSITIVE_INFINITY)).toBeDefined()
    expect(valueFault("flag", "true")).toBeDefined()
    expect(valueFault("flag", 1)).toBeDefined()
    expect(valueFault("id", 7)).toBeDefined()
    expect(valueFault("id", null)).toBeDefined()
    expect(valueFault("id", { toString: () => "safe" })).toBeDefined()
  })

  test("ID_SHAPE is bounded — nothing interesting survives 64 characters", () => {
    expect(ID_SHAPE.test("a".repeat(64))).toBe(true)
    expect(ID_SHAPE.test("a".repeat(65))).toBe(false)
  })
})

// ── 3. the two disable conditions, held apart ───────────────────────────────────────────────────

describe("consent and airgap are INDEPENDENT, and the check is a cross-influence detector", () => {
  const combos = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const

  test("changing only the config never moves airgap; changing only the policy never moves consent", () => {
    // This is the shape of the defect being guarded: `consent: enabled && !offline`, or
    // `enabled ?? !offline`. Either one makes one field respond to the other's source, and either
    // one turns exactly half of these sixteen assertions red.
    for (const [enabled, offline] of combos) {
      const gate = resolveGate({ config: { telemetry: { enabled } }, policy: { enabled: offline } })
      expect(`consent(${enabled},${offline})=${gate.consent}`).toBe(`consent(${enabled},${offline})=${enabled}`)
      expect(`airgap(${enabled},${offline})=${gate.airgap}`).toBe(`airgap(${enabled},${offline})=${offline}`)
    }
  })

  test("consent defaults ON — a common user is maintained, not surveilled", () => {
    // ⚠️ Both airgap values on every row. Airgap must not become the DEFAULT for consent — the
    // shape `enabled ?? !offline` is invisible unless the unset case is exercised airgapped, and
    // it is the most natural wrong way to write "offline forces telemetry off".
    for (const offline of [false, true]) {
      const policy = { enabled: offline }
      expect(resolveGate({ config: undefined, policy }).consent).toBe(true)
      expect(resolveGate({ config: {}, policy }).consent).toBe(true)
      expect(resolveGate({ config: { telemetry: {} }, policy }).consent).toBe(true)
      expect(resolveGate({ config: { telemetry: { enabled: undefined } }, policy }).consent).toBe(true)
      // only an explicit `false` withdraws it — a stray truthy string does not silently disable
      expect(resolveGate({ config: { telemetry: { enabled: "no" } }, policy }).consent).toBe(true)
      expect(resolveGate({ config: { telemetry: { enabled: false } }, policy }).consent).toBe(false)
    }
    // Consent SURVIVES the airgap: an airgapped machine has not withdrawn consent, it has vetoed
    // the send. The two are different facts and the status surface reports them separately.
    expect(resolveGate({ config: undefined, policy: { enabled: true } })).toEqual({ consent: true, airgap: true })
  })

  test("refusals NAME both conditions — neither can mask the other", () => {
    expect(refusals({ consent: true, airgap: false }, ENDPOINT)).toEqual([])
    expect(refusals({ consent: false, airgap: false }, ENDPOINT)).toEqual(["consent_off"])
    expect(refusals({ consent: true, airgap: true }, ENDPOINT)).toEqual(["airgap"])
    // ⚠️ the load-bearing row: a first-match `reason` string would report only "consent_off" here
    expect(refusals({ consent: false, airgap: true }, ENDPOINT)).toEqual(["consent_off", "airgap"])
    // and a missing destination is its own named reason, not silence
    expect(refusals(OPEN, undefined)).toEqual(["no_endpoint"])
    expect(refusals(OPEN, "   ")).toEqual(["no_endpoint"])
    expect(refusals({ consent: false, airgap: true }, undefined)).toEqual(["consent_off", "airgap", "no_endpoint"])
  })

  test("airgap vetoes EXPLICIT consent — AGENTS.md: forced off regardless of the setting", () => {
    const gate = resolveGate({ config: { telemetry: { enabled: true } }, policy: { enabled: true } })
    expect(gate.consent).toBe(true)
    expect(gate.airgap).toBe(true)
    const built = build({ report: { plane: "server", kind: "TypeError" }, gate, endpoint: ENDPOINT, host: HOST })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.refusals).toContain("airgap")
  })

  test("no endpoint is the state on every machine today — nothing is built at all", () => {
    // `config.ts` says in-tree that no upload system exists. It stays true until the intake VPS
    // does: with no configured endpoint, `build` never even constructs a payload.
    const built = build({ report: { plane: "server", kind: "TypeError" }, gate: OPEN, endpoint: undefined, host: HOST })
    expect(built).toEqual({ ok: false, refusals: ["no_endpoint"], dropped: [] })
    expect(endpointFromEnv({})).toBeUndefined()
    expect(endpointFromEnv({ NOVACLAW_TELEMETRY_ENDPOINT: "  " })).toBeUndefined()
    expect(endpointFromEnv({ NOVACLAW_TELEMETRY_ENDPOINT: " https://x.invalid/c " })).toBe("https://x.invalid/c")
  })

  test("a refused build constructs NOTHING — the gates run before the payload exists", () => {
    for (const gate of [
      { consent: false, airgap: false },
      { consent: true, airgap: true },
      { consent: false, airgap: true },
    ] satisfies Gate[]) {
      const built = build({
        report: { plane: "server", kind: "TypeError", stack: STACK, event: SAFE_EVENT, attributes: {} },
        gate,
        endpoint: ENDPOINT,
        host: HOST,
      })
      expect(built.ok).toBe(false)
      // Nothing about the report reached a field — not even the fields that would have been safe.
      expect(JSON.stringify(built)).not.toContain("signature")
    }
  })
})

// ── 4. the event gate ───────────────────────────────────────────────────────────────────────────

describe("a content-bearing event is refused outright", () => {
  test("mayEgress === false refuses, and the safe twin passes", () => {
    const refused = build({
      report: { plane: "server", kind: "TypeError", event: CONTENT_EVENT, attributes: { "filesystem.cause": "x" } },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.refusals).toEqual(["content_bearing_event"])

    const passed = build({
      report: { plane: "server", kind: "TypeError", event: SAFE_EVENT, attributes: { "session.targets": 3 } },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(passed.ok).toBe(true)
  })

  test("🔴 a session id is refused — the exact envelope this file's prose falsely promised", () => {
    // **This is a regression test for a measured leak, not a hypothetical.** On 2026-08-07 this
    // input returned `ok: true` with `attributes: { "session.id": "ses_…" }` in the envelope and
    // `dropped: []`, while the module doc above says in as many words *"No … session id"*. The
    // cause was in the type, not here: a session id was class `id`, `id` is egress-safe, and 38
    // keys carrying one were declared `content: "none"`. A session id is now class
    // `correlate`, so the refusal happens at gate 4 — one rung EARLIER than the attribute filter.
    const built = build({
      report: {
        plane: "server",
        kind: "TypeError",
        stack: STACK,
        event: "session.drain.exit",
        attributes: { "session.id": "ses_01JBQ8Z4K7T3", step: 4 },
      },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.refusals).toEqual(["content_bearing_event"])
    // The absence assertion, and it is over the WHOLE serialized result rather than one field —
    // a refusal that still carried the id somewhere in `dropped` would be a leak with a label.
    expect(JSON.stringify(built)).not.toContain("ses_01JBQ8Z4K7T3")

    // ⚠️ **Negative control, because "the id is absent" is exactly the assertion that can never
    // fire.** The same scan over a builder that IS allowed to carry the id must find it — otherwise
    // the check above would pass on a build() that returned `null`, on a typo'd id, or on any
    // future refactor that stopped serializing attributes at all.
    const leaky = build({
      report: {
        plane: "server",
        kind: "TypeError",
        stack: STACK,
        event: SAFE_EVENT,
        attributes: { "session.targets": 3 },
      },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(leaky.ok).toBe(true)
    expect(JSON.stringify(leaky)).toContain('"session.targets":3')
    // …and the id really is the thing being refused: the same event with the correlator removed is
    // still refused, because the KEY is what carries the class. That is the one-rung-earlier
    // property, stated as an assertion instead of a comment.
    const withoutTheId = build({
      report: { plane: "server", kind: "TypeError", event: "session.drain.exit", attributes: { step: 4 } },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(withoutTheId.ok).toBe(false)
  })

  test("no egress-safe event carries a correlation-classed attribute (the whole live set)", () => {
    // The property `filterAttributes` would otherwise have to be trusted for. Walked over every
    // declared event rather than the two fixtures, because 38 keys changed class for this.
    const carrying = Object.entries(EVENTS)
      .filter(([key]) => EVENTS[key as EventKey].content === "none")
      .flatMap(([key, declaration]) =>
        Object.entries(declaration.attributes)
          .filter(([, cls]) => cls === "correlate")
          .map(([name]) => `${key}.${name}`),
      )
    expect(carrying).toEqual([])
    // Non-vacuity: correlation-classed attributes exist in quantity, they are just never on an
    // egress-safe event. Without this line the assertion above passes on a tree with no such class.
    const total = Object.values(EVENTS).flatMap((declaration) =>
      Object.values(declaration.attributes).filter((cls) => cls === "correlate"),
    )
    expect(total.length).toBeGreaterThan(50)
  })

  test("a signature FIELD that fails its class is dropped, and a gutted signature is refused", () => {
    // `plane` and `kind` are typed, but a crash site is the one place types are least trustworthy:
    // this is the path a caught `unknown` travels. Every offered field runs the same check an
    // attribute does — and when the identifying ones do not survive it, the report is refused
    // rather than transmitted as noise with a shape.
    const built = build({
      report: { plane: SECRETS.prompt as never, kind: SECRETS.message, stack: STACK },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.refusals).toEqual(["empty_signature"])
    expect(built.dropped.map((d) => d.name)).toEqual(["plane"])
    expect(leakedSecrets(JSON.stringify(built))).toEqual([])
    // `kind` did not carry the message either — it was coerced to the honest fallback.
    const kindOnly = build({
      report: { plane: "server", kind: SECRETS.message, stack: STACK },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(kindOnly.ok).toBe(true)
    if (kindOnly.ok) expect(kindOnly.envelope.signature.kind).toBe("unknown")
  })

  test("a HOST fact that is not a token becomes `unknown`, never the raw string", () => {
    // The other place a raw string could ride in: a build that stamps its channel with prose, or a
    // future runtime string carrying a path. `token()` drops; it does not pass through.
    const messy: Host = {
      version: "0.2.0-nightly.20260731t065756",
      channel: "beta channel (nightly build)",
      platform: SECRETS.home,
      arch: "x64",
      runtime: SECRETS.prompt,
    }
    const built = build({ report: { plane: "server", kind: "TypeError" }, gate: OPEN, endpoint: ENDPOINT, host: messy })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.envelope.signature.channel).toBe("unknown")
    expect(built.envelope.signature.platform).toBe("unknown")
    expect(built.envelope.signature.runtime).toBe("unknown")
    expect(built.envelope.signature.arch).toBe("x64")
    expect(leakedSecrets(JSON.stringify(built.envelope))).toEqual([])
  })

  test("an undeclared event key is refused, not passed through", () => {
    const built = build({
      report: { plane: "server", kind: "TypeError", event: "totally.made.up" },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.refusals).toEqual(["unknown_event"])
  })
})

// ── 5. the attribute filter ─────────────────────────────────────────────────────────────────────

describe("only DECLARED, egress-safe, well-shaped attributes survive", () => {
  test("the three filters each drop, and each says why", () => {
    const built = build({
      report: {
        plane: "server",
        kind: "TypeError",
        event: SAFE_EVENT,
        attributes: {
          // declared, egress-safe, well-shaped → kept
          "session.targets": 7,
          "session.commit": true,
          // declared, egress-safe, WRONG SHAPE → dropped
          "session.reclaim": SECRETS.prompt,
          // NOT declared on this event → dropped (an unknown field has no class, and "unknown"
          // must never mean "send it")
          "session.prompt": SECRETS.prompt,
          "user.home": SECRETS.home,
        },
      },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.envelope.attributes).toEqual({ "session.targets": 7, "session.commit": true })
    expect(built.dropped.map((d) => d.name).sort()).toEqual(["session.prompt", "session.reclaim", "user.home"])
    for (const d of built.dropped) expect(d.reason.length).toBeGreaterThan(5)
  })

  test("⚠️ the content-CLASS pass is driven with a SYNTHETIC declaration, because the tree cannot reach it", () => {
    // Through `build`, this pass is dead code: every `content: "none"` event has only egress-safe
    // attributes, so the `mayEgress` gate refuses the content-bearing ones first. That is true only
    // because `log-events.test.ts` asserts declared content matches derived content — i.e. this
    // guard's reachability depends on ANOTHER FILE'S TEST. So it is exercised directly, against the
    // declaration map that file's drift would produce.
    const drifted = {
      "safe.id": "id",
      "safe.count": "count",
      "leaky.path": "path",
      "leaky.text": "text",
      "leaky.fault": "fault",
    } as const
    const filtered = filterAttributes(drifted, {
      "safe.id": "abc",
      "safe.count": 2,
      "leaky.path": SECRETS.home,
      "leaky.text": SECRETS.prompt,
      "leaky.fault": SECRETS.message,
      undeclared: SECRETS.project,
    })
    expect(filtered.kept).toEqual({ "safe.id": "abc", "safe.count": 2 })
    expect(filtered.dropped.map((d) => d.name).sort()).toEqual([
      "leaky.fault",
      "leaky.path",
      "leaky.text",
      "undeclared",
    ])
    expect(leakedSecrets(JSON.stringify(filtered.kept))).toEqual([])
    // negative control: the same scan over what a removed pass would have kept.
    expect(leakedSecrets(JSON.stringify({ ...filtered.kept, "leaky.path": SECRETS.home }))).toEqual(["home"])
  })

  test("a content-CLASS attribute is dropped even on an egress-safe event", () => {
    // Belt and braces, deliberately redundant with the `mayEgress` gate: the two agree today only
    // because `log-events.test.ts` asserts declared `content` matches derived `content`. This
    // filter does not depend on that other file's test still existing.
    const contentClassed = Object.entries(EVENTS)
      .flatMap(([key, decl]) =>
        Object.entries(decl.attributes)
          .filter(([, cls]) => !egressSafe(cls as keyof typeof ATTRIBUTE_CLASSES))
          .map(([name]) => [key, name] as const),
      )
      .slice(0, 1)
    expect(contentClassed.length).toBe(1) // non-vacuity: such a pair exists in the live tree
    const [key, name] = contentClassed[0]!
    const built = build({
      report: { plane: "server", kind: "TypeError", event: key, attributes: { [name]: SECRETS.prompt } },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    // Either the event gate refused it, or the attribute filter dropped it. Never sent.
    if (built.ok) expect(built.envelope.attributes[name]).toBeUndefined()
    expect(JSON.stringify(built.ok ? built.envelope : {})).not.toContain(SECRETS.prompt)
  })

  test("attributes are empty when there is no event", () => {
    const built = build({
      report: { plane: "server", kind: "TypeError", attributes: { anything: "at-all" } },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.envelope.attributes).toEqual({})
  })
})

// ── 6. normalisation: the machine must not be identifiable ──────────────────────────────────────

describe("normalisation strips what identifies the reporter", () => {
  test("releaseLine drops the build stamp — a per-build timestamp is near-unique", () => {
    // ⚠️ Never spell the CURRENT version here — `test/version-single-source.test.ts` sweeps
    // `packages/core/src` for that literal and this file is in its walk. A sample release only has
    // to be a well-formed one, so use a version that can never be current.
    expect(releaseLine("0.1.55")).toBe("0.1.55")
    expect(releaseLine("0.2.0-nightly.20260731t065756")).toBe("0.2.0")
    expect(releaseLine("1.10.3+sha.abcdef0")).toBe("1.10.3")
    expect(releaseLine("dev")).toBe("unknown")
    expect(releaseLine(undefined)).toBe("unknown")
    // and whatever it returns is always admissible as an `id`
    for (const v of ["0.1.55", "0.2.0-nightly.20260731t065756", "dev", undefined])
      expect(valueFault("id", releaseLine(v))).toBeUndefined()
  })

  test("normalizeFrames keeps callee+basename and discards every directory", () => {
    const frames = normalizeFrames(STACK)
    expect(frames.length).toBe(2)
    expect(frames[0]).toBe("drain@llm.ts:412:19")
    for (const frame of frames) {
      expect(frame).not.toContain("nangl")
      expect(frame).not.toContain("C:")
      expect(frame).not.toContain("\\")
    }
    expect(normalizeFrames(undefined)).toEqual([])
    expect(normalizeFrames("not a stack at all")).toEqual([])
  })

  test("the same bug on two machines produces the SAME signature", () => {
    // Which is the only reason a signature is worth clustering — and it is what proves the path
    // was genuinely dropped rather than merely hidden.
    const windows = `TypeError: x\n    at drain (C:\\Users\\nangl\\app\\llm.ts:412:19)`
    const linux = `TypeError: x\n    at drain (/home/otheruser/app/llm.ts:412:19)`
    const a = fingerprint("TypeError", normalizeFrames(windows))
    const b = fingerprint("TypeError", normalizeFrames(linux))
    expect(a).toBe(b)
    // …and a genuinely different bug does not collide
    expect(fingerprint("TypeError", normalizeFrames(windows.replace("412", "999")))).not.toBe(a)
    expect(valueFault("id", a)).toBeUndefined()
  })

  test("the repeat counter is bounded — an unbounded map on the crash path is a second fault", () => {
    expect(countRepeat("aaa")).toBe(1)
    expect(countRepeat("aaa")).toBe(2)
    expect(countRepeat("bbb")).toBe(1)
    for (let i = 0; i < 200; i++) countRepeat(`sig-${i}`)
    // A known signature still counts; a brand-new one past the cap does not grow the map.
    expect(countRepeat("aaa")).toBe(3)
    expect(countRepeat("brand-new-past-the-cap")).toBe(1)
    expect(countRepeat("brand-new-past-the-cap")).toBe(1)
  })
})

// ── 7. THE ENVELOPE WALK — the absence assertion, negative-controlled ────────────────────────────

/**
 * Which of {@link SECRETS} survive into a serialised payload — read back through `JSON.parse` and
 * walked leaf by leaf.
 *
 * ⚠️ **This is not paranoia about the parser; it is a trap this file fell into on the first run.**
 * `JSON.stringify` escapes `\` to `\\`, so a raw `expect(wire).not.toContain(windowsPath)` is an
 * assertion that could never go red no matter how badly the builder leaked — the exact "absence
 * assertion with no failure mode" this suite exists to avoid. Decoding first makes the comparison
 * one between the values, not between one value and an escaped copy of it.
 */
function leakedSecrets(wire: string | undefined): ReadonlyArray<string> {
  const found = new Set<string>()
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      for (const [label, secret] of Object.entries(SECRETS)) if (node.includes(secret)) found.add(label)
      return
    }
    if (node && typeof node === "object") for (const value of Object.values(node)) visit(value)
  }
  visit(JSON.parse(wire ?? "null"))
  return [...found].sort()
}

/**
 * Every leaf of an envelope must be a DECLARED field or a DECLARED egress-safe attribute of the
 * declared event, carrying a value its class admits. Returns the violations, so the same function
 * can be driven over a forged envelope and demanded to find them.
 */
function walk(envelope: Envelope, event: EventKey | undefined): ReadonlyArray<string> {
  const violations: string[] = []
  const declaredFields = new Set<string>(fields())
  for (const [name, value] of Object.entries(envelope.signature)) {
    if (!declaredFields.has(name)) {
      violations.push(`signature.${name}: not a declared crash field`)
      continue
    }
    const fault = valueFault(CRASH_FIELDS[name as CrashField].class, value)
    if (fault) violations.push(`signature.${name}: ${fault}`)
  }
  const declaredAttributes: Record<string, string> = event ? { ...EVENTS[event].attributes } : {}
  for (const [name, value] of Object.entries(envelope.attributes)) {
    const cls = declaredAttributes[name]
    if (cls === undefined) {
      violations.push(`attributes.${name}: not declared on ${event ?? "<no event>"}`)
      continue
    }
    if (!egressSafe(cls as keyof typeof ATTRIBUTE_CLASSES)) {
      violations.push(`attributes.${name}: class "${cls}" never egresses`)
      continue
    }
    const fault = valueFault(cls as EgressSafeClass, value)
    if (fault) violations.push(`attributes.${name}: ${fault}`)
  }
  return violations
}

describe("the envelope carries only what is declared — and the walk that says so can fail", () => {
  test("a real crash, with a poisoned everything, produces a clean envelope", () => {
    const built = build({
      report: {
        plane: "server",
        kind: "TypeError",
        stack: STACK,
        event: SAFE_EVENT,
        attributes: {
          "session.targets": 3,
          "session.reclaim": 900,
          "session.scanned": 41,
          "session.commit": true,
          // the poison a careless call site would add
          note: SECRETS.prompt,
          cwd: SECRETS.project,
          detail: SECRETS.message,
        },
        uptimeSeconds: 9021,
      },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(walk(built.envelope, SAFE_EVENT)).toEqual([])

    const wire = JSON.stringify(built.envelope)
    expect(leakedSecrets(wire)).toEqual([])
    // the stack is hashed, so no fragment of it survives either
    expect(wire).not.toContain("llm.ts")
    expect(wire).not.toContain("nangl")
    expect(wire).not.toContain("412")
    // and the build stamp did not ride along on the version
    expect(wire).not.toContain("20260731")
    expect(built.envelope.signature.release).toBe("0.2.0")
  })

  test("⚠️ NEGATIVE CONTROL — the walk and the secret scan both FIRE on a forged envelope", () => {
    // A guard that has only ever seen clean input has not been shown to work. This is the same
    // `walk` and the same scan, over the payload a regression would produce.
    const forged = {
      signature: {
        plane: "server",
        signature: "a1b2c3d4e5f60718",
        // the four regressions this file exists to prevent, one per line:
        kind: SECRETS.message, //           a message smuggled through an `id`
        release: SECRETS.home, //           a path smuggled through an `id`
        stackText: STACK, //                a field nobody declared
        repeat: "many", //                  a count that is not a number
      },
      attributes: {
        "session.targets": 3, //            legitimate
        "session.prompt": SECRETS.prompt, //  undeclared on this event
      },
    } as unknown as Envelope

    const violations = walk(forged, SAFE_EVENT)
    expect(violations.length).toBe(5)
    expect(violations.join("\n")).toContain("stackText")
    expect(violations.join("\n")).toContain("session.prompt")

    // ⚠️ and the SCAN fires too — three of the four secrets are recovered from the forged wire.
    // Without this leg, `leakedSecrets(...) === []` above would be an assertion with no failure mode.
    expect(leakedSecrets(JSON.stringify(forged))).toEqual(["home", "message", "prompt"])
  })

  test("⚠️ NEGATIVE CONTROL — a leaky BUILDER is caught by the same assertions", () => {
    // `build` with its filter removed: the single most likely regression, written out so the
    // suite has seen the thing it forbids.
    const leakyBuild = (attributes: Record<string, unknown>): Envelope => ({
      signature: { plane: "server", signature: "a1b2c3d4e5f60718" },
      attributes: attributes as Record<string, string | number | boolean>,
    })
    const leaked = leakyBuild({ "session.targets": 3, note: SECRETS.prompt, cwd: SECRETS.home })
    expect(walk(leaked, SAFE_EVENT).length).toBe(2)
    expect(leakedSecrets(JSON.stringify(leaked))).toEqual(["home", "prompt"])
    // …while the real builder, given the identical input, does not.
    const real = build({
      report: {
        plane: "server",
        kind: "TypeError",
        event: SAFE_EVENT,
        attributes: { "session.targets": 3, note: SECRETS.prompt },
      },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(real.ok).toBe(true)
    if (real.ok) {
      expect(walk(real.envelope, SAFE_EVENT)).toEqual([])
      expect(leakedSecrets(JSON.stringify(real.envelope))).toEqual([])
    }
  })
})

// ── 8. the preview cannot drift from the payload ────────────────────────────────────────────────

describe("the disclosure is built by the send path", () => {
  test("preview IS build, by reference", () => {
    // kirodotdev/kirocrew#1037: a status command that re-describes the payload in its own code is
    // a second copy and will eventually lie. This is the cheapest possible proof that it cannot.
    expect(preview).toBe(build)
  })

  test("every field the builder can emit is declared in the disclosure", () => {
    const built = build({
      report: { plane: "server", kind: "TypeError", stack: STACK, event: SAFE_EVENT, uptimeSeconds: 5 },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const documented = new Set(disclosure().map((row) => row.field))
    const undocumented = Object.keys(built.envelope.signature).filter((n) => !documented.has(n as CrashField))
    expect(undocumented).toEqual([])
    // and the emitted set is a real subset, not an empty one
    expect(Object.keys(built.envelope.signature).length).toBeGreaterThanOrEqual(10)
  })

  test("ordinary-user status names live gates and previews through the real builder even without an endpoint", () => {
    const got = status({
      config: { telemetry: { enabled: false } },
      policy: { enabled: true },
      endpoint: undefined,
      host: HOST,
    })
    expect(got.gate).toEqual({ consent: false, airgap: true })
    expect(got.endpointConfigured).toBe(true)
    expect(got.ready).toBe(false)
    expect(got.refusals).toEqual(["consent_off", "airgap"])
    expect(got.payloadPreview?.signature).toMatchObject({
      plane: "server",
      kind: "TelemetryPreview",
      repeat: 1,
      uptime: 0,
    })
    const documented = new Set(fields())
    expect(Object.keys(got.payloadPreview?.signature ?? {}).every((field) => documented.has(field as CrashField))).toBe(
      true,
    )
    expect(got.disclosure).toEqual(disclosure())
  })
})

describe("collector readiness", () => {
  test("promotes only the endpoint that accepts the end-to-end probe", async () => {
    const sink: { body?: string } = {}
    const client = (status: number) =>
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const body = request.body as { readonly _tag: string; readonly body?: unknown }
          sink.body = body._tag === "Uint8Array" ? new TextDecoder().decode(body.body as Uint8Array) : JSON.stringify(body.body)
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status })))
        }),
      )

    expect(intakeReady(ENDPOINT)).toBe(false)
    expect(await Effect.runPromise(probe(ENDPOINT).pipe(Effect.provide(client(204))))).toBe(true)
    expect(intakeReady(ENDPOINT)).toBe(true)
    expect(sink.body).toBe(JSON.stringify({ probe: "novaclaw-crash-intake" }))

    const other = "https://telemetry.other.invalid/crash"
    expect(await Effect.runPromise(probe(other).pipe(Effect.provide(client(503))))).toBe(false)
    expect(intakeReady(other)).toBe(false)
    expect(intakeReady(ENDPOINT)).toBe(true)
  })
})

// ── 9. the wire ─────────────────────────────────────────────────────────────────────────────────

/** Captures the exact bytes a request carried, so the assertion is about the WIRE, not the struct. */
function captureClient(sink: { body?: string; url?: string }) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      sink.url = url.toString()
      const body = request.body as { readonly _tag: string; readonly body?: unknown }
      sink.body =
        body._tag === "Uint8Array" ? new TextDecoder().decode(body.body as Uint8Array) : JSON.stringify(body.body)
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 202 })))
    }),
  )
}

describe("what actually goes on the wire", () => {
  test("the POST body is the envelope, byte for byte, and carries no secret", async () => {
    const sink: { body?: string; url?: string } = {}
    const built = build({
      report: {
        plane: "server",
        kind: "TypeError",
        stack: STACK,
        event: SAFE_EVENT,
        attributes: { "session.targets": 3, leak: SECRETS.prompt },
        uptimeSeconds: 12,
      },
      gate: OPEN,
      endpoint: ENDPOINT,
      host: HOST,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    await Effect.runPromise(send(ENDPOINT, built.envelope).pipe(Effect.provide(captureClient(sink))))
    expect(sink.url).toBe(ENDPOINT)
    expect(sink.body).toBe(JSON.stringify(built.envelope))
    expect(leakedSecrets(sink.body)).toEqual([])
    // non-vacuity: the scan ran over a real body, not over `undefined`.
    expect(sink.body?.length ?? 0).toBeGreaterThan(100)
  })

  test("a refused report never reaches the client at all", async () => {
    for (const [gate, endpoint] of [
      [{ consent: false, airgap: false }, ENDPOINT],
      [{ consent: true, airgap: true }, ENDPOINT],
      [OPEN, undefined],
    ] as ReadonlyArray<readonly [Gate, string | undefined]>) {
      const sink: { body?: string; url?: string } = {}
      const built = await Effect.runPromise(
        report({
          report: { plane: "server", kind: "TypeError", stack: STACK },
          gate,
          endpoint,
          host: HOST,
        }).pipe(Effect.provide(captureClient(sink))),
      )
      expect(built.ok).toBe(false)
      expect(sink.body).toBeUndefined()
      expect(sink.url).toBeUndefined()
    }
    // …and the open case DOES reach it, so the assertion above is not vacuous.
    const sink: { body?: string; url?: string } = {}
    const built = await Effect.runPromise(
      report({
        report: { plane: "server", kind: "TypeError", stack: STACK },
        gate: OPEN,
        endpoint: ENDPOINT,
        host: HOST,
      }).pipe(Effect.provide(captureClient(sink))),
    )
    expect(built.ok).toBe(true)
    expect(sink.url).toBe(ENDPOINT)
  })

  test("a transport failure is swallowed — a crash report never becomes a second crash", async () => {
    const exploding = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die(new Error("intake is down"))),
    )
    const envelope: Envelope = { signature: { plane: "server", signature: "a1b2c3d4e5f60718" }, attributes: {} }
    await Effect.runPromise(send(ENDPOINT, envelope).pipe(Effect.provide(exploding)))
  })
})
