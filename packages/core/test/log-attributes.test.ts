import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ATTRIBUTE_CLASSES, type AttributeClass, EVENTS, type EventKey } from "@novaclaw/schema/log-events"
import {
  type AttributeSite,
  countAttributes,
  type LedgerEntry,
  ledgerFaults,
  scanAttributeSource,
  scanPackageAttributes,
  valueShape,
} from "./lib/log-event-ledger"

/**
 * **The two type seams of `` 1h, with the machine that keeps them closed.**
 *
 * 1a put redaction in the record type and 1b/1c drove every log call through it. What 1h names is
 * what the migration EXPOSED on the way: two places where the declared type is not actually the
 * single source, because the call site still decides the encoding.
 *
 *   · **`fault`.** A caught error becomes a string at the call site, and there were 21 different
 *     ways of doing it — `Cause.pretty(c)` ×39, `String(e)` ×18, `errorFormat(e)` ×9,
 *     `e instanceof Error ? e.message : String(e)` ×7, and a tail of `.message`, `.stderr`, bare
 *     strings. The item's word for this is *drift*, and it had already happened: the three common
 *     shapes disagree about whether a fault carries its stack, and `String()` on an Effect `Cause`
 *     loses the failure entirely. `Log.fault` is the one normalization; the ledger below is what
 *     gets the remaining sites onto it.
 *   · **`list`.** Ignore globs, argv, changed config keys and failure reasons were crossing the
 *     scalar-only boundary as hand-written `JSON.stringify(…)` — 20 call sites, each of which had
 *     silently become the owner of a truncation policy that did not exist. The `list` class takes a
 *     `readonly string[]` and `encodeList` owns the one bounded encoding, so that check is
 *     **absolute**: there is no ledger and a `JSON.stringify` in an attribute value fails outright.
 *
 * ⚠️ **Every check here is negative-controlled by driving the same pure function over synthetic
 * source.** An assertion of emptiness over a clean tree cannot show the scanner is capable of
 * reporting anything at all, and this file's whole job is to report things.
 *
 * ⚠️ **It reads the AST, deliberately.** A regex over source counts prose: the sibling scanner in
 * `log-event-migration-ledger.test.ts` shipped in a regex form for a few hours in August and counted
 * a `cause` inside a DOC COMMENT as a live defect. One scanner, or the two disagree and the wrong
 * one is believed.
 */

/** `packages/core/test` → the app repository root. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..")
const SITES = scanPackageAttributes(ROOT)

const classOf = (site: AttributeSite): AttributeClass | undefined =>
  (EVENTS as Readonly<Record<string, { attributes: Readonly<Record<string, AttributeClass>> } | undefined>>)[site.key]
    ?.attributes?.[site.name]

const FAULT_SITES = SITES.filter((site) => classOf(site) === "fault")

/**
 * 🔴 **The shrink-only ledger of `fault` values that do NOT yet go through `Log.fault`.**
 *
 * Seeded at **90** on 2026-08-07, parser-measured against app HEAD `34e45a066`; **73** after the
 * `packages/core/src/session/` pass on the same day; **61** after the snapshot/worktree/watcher pass
 * on 2026-08-08 (8 conversions and 4 re-classifications — see below); **51** after the `stderr`
 * ruling later the same day (10 re-classifications — see below). Modelled on
 * `log-event-migration-ledger.test.ts` (which ran 233 → 0) and on
 * `config-routing-ledger.test.ts` before it: a two-directional ratchet, so an unlisted site fails as
 * new and a listed site that no longer needs listing fails as stale. **The list can only shrink.**
 *
 * ⚠️ **The seed note claimed "two thirds of the remaining sites live under
 * `packages/core/src/session/`". Re-derived with this file's own scanner, it was 20 of 90 — 22%.**
 * The real concentration was elsewhere and diffuse: 18 in `session/runner/llm.ts`, then 10 in
 * `novaclaw/src/snapshot/index.ts`, 5 in `novaclaw/src/worktree/index.ts`, 4 in
 * `core/src/filesystem/watcher.ts`, and a tail of ~40 files holding 1–3 each. A prose share is not a
 * measurement; the scanner is, and it is three lines to run.
 *
 * ⚠️ Why a ledger rather than an absolute rule today: the remaining 61 are spread across four
 * packages, so no single agent can close them. The rule this file wants is absolute; a ratchet is
 * the only thing that reports the half-done state truthfully while it is true.
 *
 * ✅ **The three session sites left by the previous pass are GONE — by re-classification, which was
 * the right exit (2026-08-08).** `session.provider.message` is now `text`, because `fault` means
 * *produced by `Log.fault` from a caught error* and that value is a `Schema.String` field of the
 * structured `LLMErrorReason`. The reasoning, and the conversion that WAS available and why it was
 * rejected, live on the declaration in `schema/log-events.ts` rather than here — the class table is
 * where the next author will look. `snapshot.header` moved for the same reason.
 * ⚠️ **The filed claim that those sites "can leave the ledger only by re-classification, never by
 * conversion" was FALSE and the correction matters more than the pin.** `transient` and
 * `llmFailure` are caught `LLMError`s in hand, so `Log.fault(transient)` was expressible; the choice
 * between the two exits is a judgement about what the line should SAY, and an entry that says one
 * exit is impossible stops the next reader from making it.
 *
 * ✅ **ANSWERED 2026-08-08 — NO: a caught spawn failure may not live in a field called `stderr`,
 * and answering it took 10 entries off the ledger (61 → 51).**
 * `stderr` names *the child's own words*. A spawn that never produced a process has no stderr, so
 * writing our caught exception there says git complained when no git existed to complain — ruling 2,
 * and the same defect class as `worktree.runStartCommand`'s empty `stderr`. Those two are one
 * mistake pointing in opposite directions: one dropped the reason, the other filed it under a false
 * author.
 * **The exit was neither of the two the entry above imagined.** Not `Log.fault` at the log site
 * (the identity, correctly refused), and not "never convertible": the column held TWO things, so the
 * fix is to SPLIT them. Each `Effect.catch` arm now emits its own event —
 * `snapshot.git.spawn.failed`, `worktree.git.spawn.failed`, `worktree.start.spawn.failed` — carrying
 * `Log.fault(err)` at the point of the catch, and returns an empty `stderr`. The subsystem that is
 * unavailable names itself, which is ruling 2 read forwards instead of as a prohibition.
 * With the lie gone, every `snapshot.*.stderr` column and the two `worktree.cause` columns provably
 * hold only a foreign process's output, so they are `text` and leave this ledger honestly.
 * ⭐ **`snapshot.diff.load.fallback` was never blocked at all** — it reads a raw `appProcess.run`
 * result on a branch guarded by `exitCode !== 0`, so a child provably ran. It was listed by
 * ASSOCIATION with its seven siblings. A shared blocker is a cluster, and a cluster is where a wrong
 * label hides; check each member against the code, not against the group.
 * ⚠️ The class change has **no downstream effect**: `text` and `fault` are both `content: "user"`
 * and both `SPEAKS_FOR_OTHERS`, so egress, the crash-field set and the `log` tool's untrusted frame
 * are all byte-identical. What changed is that the column's NAME is now true.
 *
 * ⚠️ **When it reaches zero, DELETE the fixture — do not empty it.** An empty JSON array still reads
 * as *add your entry here*; the next author under time pressure appends one line and the invariant
 * is quietly a suggestion again. 1c learned this the expensive way and the note is kept verbatim.
 */
const LEDGER_PATH = path.join(ROOT, "packages/core/test/fixtures/unnormalized-fault-sites.json")
const LEDGER: readonly LedgerEntry[] = fs.existsSync(LEDGER_PATH)
  ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"))
  : []

describe("the sweep reached something", () => {
  test("the scanner walked the real call sites, not an empty set", () => {
    // Every assertion below is a filter over these. If the walk broke, each would become a
    // tautology that passes forever — the guard-shaped no-op.
    expect(SITES.length).toBeGreaterThan(300)
    expect(FAULT_SITES.length).toBeGreaterThan(50)
    expect(new Set(SITES.map((site) => site.file)).size).toBeGreaterThan(20)
  })

  test("every attribute a call site sets is DECLARED on that event", () => {
    // TypeScript already refuses an undeclared name through `Attributes<K>`. This is the runtime
    // twin, and it is not redundant: a unit's tests and its `typecheck` are separate gate entries,
    // and a file shipped 40/40 green with its typecheck RED in this very batch. It also caught two
    // real sites here — `storage.session`/`storage.message`, left behind by the 1e rename.
    const undeclared = SITES.filter((site) => classOf(site) === undefined).map(
      (site) => `${site.file} :: ${site.key} sets "${site.name}", which the declaration does not carry`,
    )
    expect(undeclared).toEqual([])
  })
})

describe("seam 1 — a fault has ONE normalization", () => {
  const unnormalized = (sites: readonly AttributeSite[]) =>
    countAttributes(sites.filter((site) => !/^Log\.fault\(/.test(site.expression)))

  test("the ledger only shrinks, in both directions", () => {
    const faults = ledgerFaults(unnormalized(FAULT_SITES), LEDGER)
    // A new `fault` attribute fed by anything but `Log.fault` is unlisted, and fails as growth.
    expect(faults.unlisted).toEqual([])
    // A converted site is stale until its allowance is removed in the SAME commit — which is what
    // makes the migration unable to be quietly abandoned half-done.
    expect(faults.stale).toEqual([])
  })

  test("zero debt means no allowance file, not an empty ledger", () => {
    const remaining = unnormalized(FAULT_SITES)
    expect(fs.existsSync(LEDGER_PATH)).toBe(remaining.length > 0)
    if (remaining.length === 0) expect(LEDGER).toEqual([])
  })

  test("the shape key is stable under a rename and reacts to a change of NORMALIZATION", () => {
    // The ledger keys on the shape, not the text, so renaming a local does not churn 90 entries —
    // and swapping `String()` for `Cause.pretty()` does show up, which is the point.
    expect(valueShape("String(cause)")).toBe("String(…)")
    expect(valueShape("String(err)")).toBe("String(…)")
    expect(valueShape("Cause.pretty(cause)")).toBe("Cause.pretty(…)")
    expect(valueShape("String(cause)")).not.toBe(valueShape("Cause.pretty(cause)"))
    // …and a shape with no call is left alone, so `.message` and `.stderr` stay distinguishable.
    expect(valueShape("error.message")).toBe("error.message")
    expect(valueShape("result.stderr")).toBe("result.stderr")
  })

  test("the scan bites on a fresh un-normalized fault, and not on a normalized one (negative control)", () => {
    const raw = scanAttributeSource(
      "packages/example/src/example.ts",
      'Log.event("snapshot.capture.failed", { "snapshot.cause": String(error) })',
    )
    expect(countAttributes(raw.filter((site) => !/^Log\.fault\(/.test(site.expression)))).toEqual([
      {
        name: "packages/example/src/example.ts :: snapshot.capture.failed.snapshot.cause = String(…)",
        count: 1,
      },
    ])
    // The same call, normalized, is not an offender.
    const normalized = scanAttributeSource(
      "packages/example/src/example.ts",
      'Log.event("snapshot.capture.failed", { "snapshot.cause": Log.fault(error) })',
    )
    expect(countAttributes(normalized.filter((site) => !/^Log\.fault\(/.test(site.expression)))).toEqual([])
    // …and against the real ledger it would fail as unlisted rather than pass silently.
    expect(
      ledgerFaults(countAttributes(raw.filter((site) => !/^Log\.fault\(/.test(site.expression))), LEDGER).unlisted,
    ).not.toEqual([])
  })

  test("a doc comment describing the bad shape is not a call site (negative control)", () => {
    // The exact false positive a regex version of this produced against `schema/log.ts`, which is a
    // file whose entire job is to DOCUMENT the shapes it replaces.
    expect(
      scanAttributeSource(
        "packages/example/src/example.ts",
        '/** Before 1h this read `{ "x.cause": String(error) }`. JSON.stringify(list) too. */',
      ),
    ).toEqual([])
  })
})

describe("seam 2 — a list is a list, and the encoding is not the call site's to choose", () => {
  test("🔴 no attribute value hand-encodes with JSON.stringify, anywhere", () => {
    // ABSOLUTE, with no ledger: all 20 sites were converted in the commit that added the `list`
    // class, so there is nothing to allow. A failure means someone re-opened the seam — the fix is
    // to declare the attribute `list` and pass the array, never to add an allowance here.
    const offenders = SITES.filter((site) => site.expression.includes("JSON.stringify")).map(
      (site) =>
        `${site.file} :: ${site.key}.${site.name} hand-encodes with JSON.stringify. ` +
        `Declare it class "list" in schema/log-events.ts and pass the array — encodeList owns the encoding, and it is bounded.`,
    )
    expect(offenders).toEqual([])
  })

  test("the JSON.stringify check bites (negative control)", () => {
    const offending = scanAttributeSource(
      "packages/example/src/example.ts",
      'Log.event("pty.session.create", { "pty.arguments": JSON.stringify(args) })',
    )
    expect(offending.filter((site) => site.expression.includes("JSON.stringify"))).toHaveLength(1)
    const clean = scanAttributeSource(
      "packages/example/src/example.ts",
      'Log.event("pty.session.create", { "pty.arguments": args })',
    )
    expect(clean.filter((site) => site.expression.includes("JSON.stringify"))).toHaveLength(0)
  })

  test("the list class exists, is local-only, and is actually USED", () => {
    // Non-vacuity for the check above: it would also pass on a tree with no `list` attribute at all.
    expect(ATTRIBUTE_CLASSES.list.content).toBe("user")
    const declared = Object.entries(EVENTS).flatMap(([key, declaration]) =>
      Object.entries(declaration.attributes)
        .filter(([, cls]) => cls === "list")
        .map(([name]) => `${key}.${name}`),
    )
    expect(declared.length).toBeGreaterThanOrEqual(10)
    // …and every declared `list` attribute is fed by a call site (no aspirational classes).
    const fed = new Set(SITES.filter((site) => classOf(site) === "list").map((site) => `${site.key}.${site.name}`))
    const unfed = declared.filter((entry) => !fed.has(entry))
    expect(unfed).toEqual([])
  })
})

describe("the parser sees what it must", () => {
  test("multiline calls, quoted and bare names, and nothing from a shorthand", () => {
    const sites = scanAttributeSource(
      "packages/example/src/example.ts",
      `
        Log.event(
          "filesystem.watcher.resubscribe.stale",
          {
            directory,
            "filesystem.ignore.attempted": item.ignore,
            "filesystem.watched": current !== undefined,
          },
        )
      `,
    )
    // `directory` is shorthand: there is no expression to classify, so it is not a site.
    expect(sites.map((site) => site.name)).toEqual(["filesystem.ignore.attempted", "filesystem.watched"])
    expect(sites[0]?.key).toBe("filesystem.watcher.resubscribe.stale")
    expect(sites[1]?.expression).toBe("current !== undefined")
  })

  test("a dynamic key is not scanned, and a non-object second argument is not either", () => {
    expect(scanAttributeSource("packages/example/src/example.ts", "Log.event(key, { a: b })")).toEqual([])
    expect(scanAttributeSource("packages/example/src/example.ts", 'Log.event("mcp.server.spawn", attrs)')).toEqual([])
  })
})

/** The key type is exercised here so a stale `EventKey` import cannot silently rot this file. */
const _pin: EventKey = "filesystem.watcher.resubscribe.stale"
void _pin
