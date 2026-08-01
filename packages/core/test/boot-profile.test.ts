import { describe, expect, test } from "bun:test"
import path from "node:path"
import { ConfigProvider, Effect, Layer } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { BootProfile } from "@novaclaw/core/observability/boot-profile"
import { PluginV2 } from "@novaclaw/core/plugin"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// ────────────────────────────────────────────────────────────────────────────────────────────────
// `todo/startup.md` Phase 1 — the boot timeline, and the mechanical check that keeps it honest.
//
// ⚠️ THE AWKWARD PART OF TESTING A MEASUREMENT, stated so nobody "improves" it into a wall-clock
// budget: a duration assertion on this box either flakes or is so slack that it passes while the
// instrument is broken. So this file asserts the STRUCTURE of the timeline — that every expected
// phase appears exactly once, that a phase nobody measured says so rather than reporting 0 ms, that
// a repeat is visible rather than collapsed, and that the arithmetic of the waterfall closes — and
// PRINTS the numbers. That is `todo/adoption.md` A10.2 (assert on work, not wall-clock) and the
// local precedent set by `config-domain-reload.test.ts`.
//
// Every assertion below is negative-controlled: each one is re-run against an input that violates
// exactly the property it claims, and must stop holding.
// ────────────────────────────────────────────────────────────────────────────────────────────────

const mark = (name: string, at: number, repeat = 1) => ({ name, at, repeat })

describe("the waterfall describes what it measured, and says so when it measured nothing", () => {
  test("an expected phase with no mark reads `not measured` — never 0.0 ms (ruling 2)", () => {
    const expected = ["boot:one", "boot:two", "boot:three"]
    const measured = [mark("boot:one", 10), mark("boot:three", 40)]

    const view = BootProfile.timeline({ label: "probe", marks: measured, expected, origin: 0 })
    expect(view.rows.filter((row) => row.kind === "missing").map((row) => row.name)).toEqual(["boot:two"])
    const text = BootProfile.format(view)
    expect(text).toMatch(/boot:two\s+not measured/)
    // …and it must not have been given a time by accident, which is the failure mode: a report
    // driven only by received marks renders the gap as `0.0 ms` and nobody ever notices.
    expect(text).not.toMatch(/boot:two\s+0\.0 ms/)

    // NEGATIVE CONTROL — supply the mark and the same claims must stop holding.
    const controlled = BootProfile.timeline({
      label: "probe",
      marks: [...measured, mark("boot:two", 25)],
      expected,
      origin: 0,
    })
    expect(controlled.rows.filter((row) => row.kind === "missing")).toEqual([])
    expect(BootProfile.format(controlled)).not.toContain("not measured")
  })

  test("every expected phase appears EXACTLY once, in measured order", () => {
    const expected = ["a", "b", "c"]
    const view = BootProfile.timeline({
      label: "probe",
      marks: [mark("c", 30), mark("a", 10), mark("b", 20)],
      expected,
      origin: 0,
    })
    const names = view.rows.map((row) => row.name)
    expect(names).toEqual(["a", "b", "c"])
    for (const phase of expected) expect(names.filter((name) => name === phase)).toHaveLength(1)

    // NEGATIVE CONTROL — a duplicated NAME must not silently become two rows or one lost row.
    const duplicated = BootProfile.timeline({
      label: "probe",
      marks: [mark("a", 10), mark("b", 20, 3)],
      expected,
      origin: 0,
    })
    expect(duplicated.rows.map((row) => row.name)).toEqual(["a", "b", "c"])
    expect(BootProfile.format(duplicated)).toContain("x3")
  })

  test("the arithmetic closes: deltas sum to the total and time never runs backwards", () => {
    const view = BootProfile.timeline({
      label: "probe",
      marks: [mark("a", 12.5), mark("b", 40), mark("c", 41.25)],
      expected: ["a", "b", "c"],
      origin: 5,
    })
    const measured = view.rows.filter((row) => row.kind === "measured")
    const sum = measured.reduce((total, row) => total + (row.kind === "measured" ? row.delta : 0), 0)
    expect(sum).toBeCloseTo(view.total, 6)
    expect(view.total).toBeCloseTo(41.25 - 5, 6)
    let previous = -Infinity
    for (const row of measured) {
      if (row.kind !== "measured") continue
      expect(row.at).toBeGreaterThanOrEqual(previous)
      previous = row.at
    }

    // NEGATIVE CONTROL — an origin AFTER the first mark makes the first delta negative, and the
    // sum-to-total identity is what would catch a formatter that clamped it to zero.
    const skewed = BootProfile.timeline({
      label: "probe",
      marks: [mark("a", 12.5), mark("b", 40)],
      expected: ["a", "b"],
      origin: 20,
    })
    const skewedSum = skewed.rows.reduce((total, row) => total + (row.kind === "measured" ? row.delta : 0), 0)
    expect(skewedSum).toBeCloseTo(skewed.total, 6)
    expect(skewed.rows[0]).toMatchObject({ kind: "measured", delta: -7.5 })
  })

  test("a segment is what arrived since the last report — segments do not bleed", () => {
    BootProfile.reset()
    BootProfile.mark("seg:one")
    const first = BootProfile.report("first", ["seg:one", "seg:absent"])
    BootProfile.mark("seg:two")
    const second = BootProfile.report("second", ["seg:two"])

    expect(first.rows.map((row) => row.name)).toEqual(["seg:one", "seg:absent"])
    expect(second.rows.map((row) => row.name)).toEqual(["seg:two"])
    // The second segment's origin is the first segment's last mark, so `at` stays absolute
    // (milliseconds since process start) while `delta` stays local. Both are needed: a phase list
    // that restarted its clock per segment could not be compared against a total.
    expect(second.origin).toBeCloseTo(first.rows[0]!.kind === "measured" ? first.rows[0]!.at : -1, 6)
    BootProfile.reset()
  })

  test("`origin: segment` charges a phase only its own span, not the idle wait before it", () => {
    const idle = (ms: number) => {
      const started = Date.now()
      while (Date.now() - started < ms) void 0
    }

    BootProfile.reset()
    BootProfile.mark("gap:before")
    BootProfile.report("first", ["gap:before"]) // closes the segment BEFORE the idle wait
    idle(12)
    BootProfile.mark("late:one")
    BootProfile.mark("late:two")
    const scoped = BootProfile.report("late", ["late:one", "late:two"], { origin: "segment" })
    expect(scoped.rows[0]).toMatchObject({ kind: "measured", name: "late:one", delta: 0 })
    expect(scoped.origin).toBeCloseTo(scoped.rows[0]!.kind === "measured" ? scoped.rows[0]!.at : -1, 6)
    expect(scoped.total).toBeLessThan(10)

    // NEGATIVE CONTROL — the default `process` origin charges the phase the idle wait, which is the
    // number this option exists to stop reporting as a boot cost.
    BootProfile.reset()
    BootProfile.mark("gap:before")
    BootProfile.report("first", ["gap:before"])
    idle(12)
    BootProfile.mark("late:one")
    const unscoped = BootProfile.report("late", ["late:one"])
    expect(unscoped.total).toBeGreaterThan(10)
    expect(unscoped.rows[0]).toMatchObject({ kind: "measured", name: "late:one" })
    expect(unscoped.rows[0]!.kind === "measured" ? unscoped.rows[0]!.delta : 0).toBeGreaterThan(10)
    BootProfile.reset()
  })

  test("marks are capped, and a drop is REPORTED rather than silently shortening the timeline", () => {
    BootProfile.reset()
    for (let index = 0; index < BootProfile.MAX_MARKS + 25; index++) BootProfile.mark(`overflow:${index}`)
    expect(BootProfile.droppedMarks()).toBe(25)
    expect(BootProfile.marks()).toHaveLength(BootProfile.MAX_MARKS)
    expect(BootProfile.format(BootProfile.report("overflowing", []))).toContain("25 mark(s) dropped")

    // NEGATIVE CONTROL — under the cap, nothing is dropped and nothing is warned about.
    BootProfile.reset()
    BootProfile.mark("under:cap")
    expect(BootProfile.droppedMarks()).toBe(0)
    expect(BootProfile.format(BootProfile.report("under", []))).not.toContain("dropped")
    BootProfile.reset()
  })

  test("a repeated mark keeps the FIRST timestamp — a memoized rebuild is not a build", () => {
    BootProfile.reset()
    BootProfile.mark("phase:x")
    const first = BootProfile.marks()[0]!.at
    for (let spin = 0; spin < 200_000; spin++) void spin
    BootProfile.mark("phase:x")
    expect(BootProfile.marks()).toHaveLength(1)
    expect(BootProfile.marks()[0]!.at).toBe(first)
    expect(BootProfile.marks()[0]!.repeat).toBe(2)
    BootProfile.reset()
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The ledger: the declared phase catalogue and the real call sites must agree, in BOTH directions.
//
// This is the "no phase is silently missing" guard, and it is the one that bites in practice —
// `PHASES` is what makes a gap say `not measured`, so a call site deleted without its catalogue
// entry silently shortens the timeline, and a catalogue entry with no call site permanently reports
// `not measured` for a phase somebody thinks is covered. Both are ruling 2 failures at one remove.
// ────────────────────────────────────────────────────────────────────────────────────────────────

const CALL_SITE_FILES = [
  "../src/location-services.ts",
  "../../novaclaw/src/index.ts",
  "../../novaclaw/src/cli/lazy-command.ts",
  "../../novaclaw/src/server/server.ts",
] as const

describe("the phase catalogue and the boot call sites agree", () => {
  test("every declared phase is marked somewhere, and every marked phase is declared", async () => {
    const sources = await Promise.all(
      CALL_SITE_FILES.map((file) => Bun.file(path.resolve(import.meta.dir, file)).text()),
    )
    const marked = new Set<string>()
    for (const source of sources)
      for (const match of source.matchAll(/BootProfile\.mark\("([^"]+)"\)/g)) marked.add(match[1]!)

    const declared = new Set(Object.values(BootProfile.PHASES).flatMap((phases) => [...phases]))

    expect([...declared].filter((phase) => !marked.has(phase)).sort()).toEqual([])
    // `.has` on the declared literal set takes the narrow type; `marked` is parsed from source and
    // is `string[]`. Widen the KNOWN side — asserting the parsed side into the union would claim the
    // very fact this test checks.
    expect([...marked].filter((phase) => !(declared as ReadonlySet<string>).has(phase)).sort()).toEqual([])
    // A bare sanity floor, so an empty regex match can never make both sets vacuously equal.
    expect(marked.size).toBeGreaterThanOrEqual(9)
  })

  test("both entry points are covered, and the CLI-only phases are exactly the CLI's", () => {
    const serve = new Set<string>(BootProfile.PHASES.serve)
    const sidecar = new Set<string>(BootProfile.PHASES.sidecar)
    // The Electron sidecar reaches `Server.listen` directly (sidecar.ts → virtual:novaclaw-server →
    // src/node.ts), so it pays every `server:*` phase and none of the `cli:*` ones. If that ever
    // stops being true the two lists stop differing by exactly the `cli:` prefix.
    expect([...serve].filter((phase) => !sidecar.has(phase))).toEqual([
      "cli:modules-loaded",
      "cli:command-loaded",
      "cli:args-parsed",
    ])
    expect([...sidecar].filter((phase) => !serve.has(phase))).toEqual([])
    expect([...sidecar].every((phase) => phase.startsWith("server:"))).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The real graph. Everything above is about the formatter; this boots an actual location and
// asserts the timeline it produces — the only assertion that fails when a call site is wired to the
// wrong place rather than merely deleted.
// ────────────────────────────────────────────────────────────────────────────────────────────────

// Nothing here wants a real OS watch — the same shape `config-domain-reload.test.ts` uses.
const flagsLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ NOVACLAW_EXPERIMENTAL_DISABLE_FILEWATCHER: "true" }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SettingsConfigStore.node,
      CatalogStore.node,
      AgentConfigStore.node,
      CommandConfigStore.node,
      ReferenceConfigStore.node,
      SkillConfigStore.node,
      PluginConfigStore.node,
      LocationServiceMap.node,
    ]),
  ).pipe(Layer.provide(flagsLayer)),
)

const withLocation = <A, E, R>(body: (location: Location.Ref) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((dir) => body(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))))

describe("a real location boot produces a real timeline", () => {
  it.live(
    "the location segment carries every phase exactly once, plus a per-node breakdown",
    () =>
      Effect.gen(function* () {
        // The flag has to be set BEFORE the location layer is built — `servicesForBoot()` reads it
        // at graph-assembly time, which is the point of reading it lazily rather than at import.
        const previous = process.env["NOVACLAW_BOOT_PROFILE"]
        process.env["NOVACLAW_BOOT_PROFILE"] = "1"
        const before = BootProfile.marks().length
        try {
          yield* Effect.scoped(
            withLocation((location) =>
              Effect.gen(function* () {
                // `ready` is the boot latch: `PluginInternal` FORKS its registration batch, so it
                // is deliberately outside the measured window — a fact the timeline should be read
                // with, not a gap in it.
                const plugins = yield* PluginV2.Service
                yield* plugins.ready
              }).pipe(Effect.provide(LocationServiceMap.Service.get(location))),
            ),
          )
        } finally {
          if (previous === undefined) delete process.env["NOVACLAW_BOOT_PROFILE"]
          else process.env["NOVACLAW_BOOT_PROFILE"] = previous
        }

        const produced = BootProfile.marks().slice(before)
        const names = produced.map((entry) => entry.name)
        for (const phase of BootProfile.PHASES.location) expect(names.filter((name) => name === phase)).toHaveLength(1)

        // The per-node breakdown is the thing `todo/startup.md` Phase 1 asks for by name and that
        // no total could supply. It exists only under the flag — which is also the gate's negative
        // control: with the flag off this set is EMPTY and the graph is the original node objects,
        // so a normal boot pays nothing for an instrument nobody asked for.
        const nodes = produced.filter((entry) => entry.name.startsWith("node:"))
        expect(nodes.length).toBeGreaterThan(20)

        const view = BootProfile.timeline({
          label: "location boot (measured in-test)",
          marks: produced,
          expected: [...BootProfile.PHASES.location],
          origin: produced[0]!.at,
        })
        expect(view.rows.filter((row) => row.kind === "missing")).toEqual([])
        // Printed, deliberately not asserted on — see the note at the top of this file.
        console.log(BootProfile.format(view))

        // ── NEGATIVE CONTROL for the gate itself ────────────────────────────────────────────────
        // A SECOND location, flag OFF. The phase marks must still be there (they are always-on and
        // cost ~0.35 µs each) and the per-node marks must be GONE — which is the claim the gate
        // rests on: with the flag off the graph is the original node objects and a normal boot pays
        // nothing for an instrument nobody asked for.
        const beforeControl = BootProfile.marks().length
        yield* Effect.scoped(
          withLocation((location) =>
            Effect.gen(function* () {
              const plugins = yield* PluginV2.Service
              yield* plugins.ready
            }).pipe(Effect.provide(LocationServiceMap.Service.get(location))),
          ),
        )
        const control = BootProfile.marks().slice(beforeControl)
        expect(control.filter((entry) => entry.name.startsWith("node:"))).toEqual([])
        for (const phase of BootProfile.PHASES.location)
          expect(control.filter((entry) => entry.name === phase)).toHaveLength(1)
      }),
    180_000,
  )
})
