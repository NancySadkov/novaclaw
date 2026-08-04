// SAFE MODE becomes USER-SETTABLE (owner 2026-07-30 → landed 2026-07-31).
//
// The directive was *"unattended bash should be allowed by default, unless the user have enabled
// safe mode in tuning."* The enforcement half shipped with the directive (`agent-jail.ts`,
// `host-exec.ts`, `tool/bash.ts`); the SETTABLE half did not, and the gap was not cosmetic — it was
// a live **ruling 2** violation. `AgentJail.denyMessage` told the user to *"Turn Safe mode off in
// this chat's Tuning controls"* while `safeMode` had ZERO matches anywhere in `packages/app`. The
// product named a control that did not exist, which is *a fault described falsely*.
//
// So this file pins BOTH halves, because either one alone re-opens the defect:
//  A. the column exists and round-trips (create · switch · resolve · inherit · fork);
//  B. the switch is reachable from the Tuning panel and has words a person can read — the thing
//     that makes the deny message a true sentence.
//
// ⚠️ Everything here reads its field/feature lists off the SOURCE OF TRUTH (`SESSION_CONFIG_FIELDS`,
// `SessionFeature.Name`, the composer's own array) rather than repeating them, so it is a ratchet:
// a seventh switch added to the kernel without a surface fails §B by name.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { ProjectV2 } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import {
  EFFECTIVE_CONFIG_DEFAULTS,
  resolveSessionConfig,
  SESSION_CONFIG_FIELDS,
  SESSION_CONFIG_FORK_FIELDS,
  sessionToConfig,
  type SessionLike,
} from "@novaclaw/core/session/config-resolve"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { fromRow } from "@novaclaw/core/session/info"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import type { SessionTable } from "@novaclaw/core/session/sql"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionFeature } from "@novaclaw/schema/session-feature"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({ resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }) }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const resolveFor = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    return yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, sessionID, (id) =>
      store.get(SessionSchema.ID.make(id)),
    )
  })

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A. The column: persistence, resolution, inheritance.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("safe mode — the session column", () => {
  // The CREATE path is called out separately because it is exactly where the sibling restrictions
  // were silently dropped before 2026-07-29 (`sessionRow` omitted them), and a restriction that
  // does not survive create is a restriction the user asked for and did not get.
  it.effect("survives create → row → Info", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location, safeMode: true })
      const stored = yield* session.get(created.id)
      expect(stored.safeMode, "safeMode did not survive create — a RESTRICTION was lost").toBe(true)
      expect((yield* resolveFor(created.id)).safeMode).toBe(true)
    }),
  )

  it.effect("the Tuning switch writes it, and clearing returns it to inherit", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      expect((yield* session.get(created.id)).safeMode, "a fresh session must not be born opted-in").toBeUndefined()

      yield* session.switchFeature({ sessionID: created.id, feature: "safeMode", enabled: true })
      expect((yield* session.get(created.id)).safeMode).toBe(true)
      expect((yield* resolveFor(created.id)).safeMode).toBe(true)

      // The ECS sparse-override discipline: `null` clears the row value back to absent (inherit),
      // it does not stamp a `false`.
      yield* session.switchFeature({ sessionID: created.id, feature: "safeMode", enabled: null })
      expect((yield* session.get(created.id)).safeMode).toBeUndefined()
      expect((yield* resolveFor(created.id)).safeMode).toBeUndefined()
    }),
  )

  // `undefined` = inherit, so a child that says nothing is bound by its parent's stance. The only
  // way to diverge is an explicit `false`, which is a thing the user had to go and do.
  it.effect("a child inherits a parent's ON and cannot shed it by saying nothing", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const parent = yield* session.create({ location })
      yield* session.switchFeature({ sessionID: parent.id, feature: "safeMode", enabled: true })
      const child = yield* session.create({ location, parentID: parent.id })

      expect((yield* session.get(child.id)).safeMode, "the child's own row declares nothing").toBeUndefined()
      expect((yield* resolveFor(child.id)).safeMode, "…but it resolves to the parent's ON").toBe(true)
    }),
  )

  // Ruling 8, the case it exists for: safe mode is a restriction, so a fork of a safe-mode chain is
  // in safe mode. `session-fork-config.test.ts` proves the generic carry off the descriptor; this
  // names the field, so a regression says WHICH restriction was lost.
  it.effect("a fork of a safe-mode chain comes back in safe mode", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const parent = yield* session.create({ location })
      yield* session.switchFeature({ sessionID: parent.id, feature: "safeMode", enabled: true })
      const child = yield* session.create({ location, parentID: parent.id })

      const forked = yield* session.fork({ sessionID: child.id })
      const stored = yield* session.get(forked.id)
      expect(stored.parentID, "a fork is a ROOT — nothing left to inherit from").toBeUndefined()
      expect(stored.safeMode, "the fork returned LESS restricted than its source (ruling 8)").toBe(true)
      expect((yield* resolveFor(forked.id)).safeMode).toBe(true)
    }),
  )
})

describe("safe mode — the descriptor and the row inverse", () => {
  test("`SESSION_CONFIG_FIELDS` classifies it `resolved`, so `fork` carries it", () => {
    expect(SESSION_CONFIG_FIELDS.safeMode).toBe("resolved")
    expect(SESSION_CONFIG_FORK_FIELDS).toContain("safeMode")
    // The classification is only legitimate while the fold genuinely maps it. (The fork suite
    // asserts the biconditional over every field; this is the same claim, named.)
    expect(sessionToConfig({ id: "ses_probe", safeMode: true } as unknown as SessionLike).safeMode).toBe(true)
  })

  test("`sessionRow` → `fromRow` round-trips it, and absence stays absence", () => {
    const now = DateTime.makeUnsafe(1_700_000_000_000)
    const base = {
      slug: "safe-mode",
      version: "0.0.0-test",
      title: "Safe mode fixture",
      location: { directory: "C:/tmp/safe-mode" } as SessionSchema.Info["location"],
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
    }
    // `sessionRow` emits an INSERT shape and `fromRow` consumes a SELECT shape; they differ only in
    // nullability, and an omitted key reads as absent through `fromRow`'s `?? undefined` exactly as
    // SQLite's NULL would — which is the failure being looked for.
    const roundTrip = (info: SessionSchema.Info) =>
      fromRow(SessionProjector.sessionRow(info) as unknown as typeof SessionTable.$inferSelect)

    const on = roundTrip(
      SessionSchema.Info.make({ ...base, id: SessionSchema.ID.make("ses_safemodeon000000000000"), safeMode: true }),
    )
    expect(on.safeMode, "safeMode did not survive sessionRow → fromRow — a RESTRICTION was lost").toBe(true)

    const bare = roundTrip(
      SessionSchema.Info.make({ ...base, id: SessionSchema.ID.make("ses_safemodebare0000000000") }),
    )
    expect(bare.safeMode, "the round trip INVENTED a restriction nobody asked for").toBeUndefined()
  })
})

// ⚠️ THE GATE ITSELF IS DELIBERATELY NOT RE-TESTED HERE. `test/unattended-bash-safe-mode.test.ts`
// already pins the whole decision matrix end to end — the default-allow arm, the restored refusal
// with its ruling-2 message, the inertness in every position the switch is not about, and the two
// arms that stay refused (hostile input incl. `"unknown"`); `permission-modes.test.ts` pins `plan`'s
// hard bash deny. A second copy of that matrix would be one more thing to edit and one more place to
// drift. This file covers what landing the COLUMN added, and nothing it did not.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// B. The surface. This is the ruling-2 half, and it is a repo-shaped invariant, so it lives here for
// the same reason `version-single-source.test.ts` and `e2e-selector-rot.test.ts` do: `packages/core/
// test` is where a cross-package check gets to run in the default tier.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const ROOT = path.join(import.meta.dir, "..", "..", "..")
const COMPOSER = path.join(ROOT, "packages", "app", "src", "components", "composer", "features-control.tsx")
const EN = path.join(ROOT, "packages", "app", "src", "i18n", "en.ts")
const JAIL = path.join(ROOT, "packages", "core", "src", "agent-jail.ts")

const read = (file: string) => {
  const text = fs.readFileSync(file, "utf8")
  // Guards the failure mode this whole section is exposed to: a moved file would make every
  // set-difference below empty and every assertion pass while proving nothing.
  expect(text.length, `${file} is empty or missing — has it moved?`).toBeGreaterThan(200)
  return text
}

/** The feature names the Tuning panel actually renders, read out of its own array literal. */
const renderedFeatures = (): string[] => {
  const source = read(COMPOSER)
  const block = /const COMPOSER_FEATURES: readonly ComposerFeature\[\] = \[([\s\S]*?)\]/.exec(source)
  expect(block, "COMPOSER_FEATURES is not where this test expects it in features-control.tsx").not.toBeNull()
  return [...block![1]!.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]!)
}

const featureCopyKeys = (): Set<string> => {
  const source = read(EN)
  return new Set(
    [...source.matchAll(/"prompt\.features\.([A-Za-z]+)\.(title|description)"/g)].map((m) => `${m[1]}.${m[2]}`),
  )
}

describe("safe mode — the control the deny message promises actually exists", () => {
  test("the deny message still points at the Tuning controls (the premise of the checks below)", () => {
    const jail = read(JAIL)
    expect(jail, "denyMessage no longer names Safe mode — re-aim these checks at whatever replaced it").toContain(
      "Turn Safe mode off in this chat's Tuning controls",
    )
  })

  test("`safeMode` is on the Tuning panel", () => {
    // Anti-obscurantist UI (standing decision): a per-session toggle is a VISIBLE composer control.
    expect(renderedFeatures(), "the product tells the user to turn off a switch that is not there").toContain(
      "safeMode",
    )
  })

  test("every feature the panel renders is a kernel feature name", () => {
    const names = new Set<string>(SessionFeature.Name.literals)
    const unknown = renderedFeatures().filter((feature) => !names.has(feature))
    expect(unknown.join(", "), "the panel renders a switch the kernel would reject").toBe("")
  })

  // The reverse does NOT hold and is deliberately not asserted: the panel omits `thinkingBudget`
  // (owner 2026-07-26 — a reasoning budget belongs to the model, and it moved to Settings → Models).
  test("every kernel feature name has readable words in `en`", () => {
    const copy = featureCopyKeys()
    const missing = SessionFeature.Name.literals.flatMap((name) =>
      ["title", "description"]
        .filter((part) => !copy.has(`${name}.${part}`))
        .map((part) => `prompt.features.${name}.${part}`),
    )
    expect(missing.join("\n"), "add these to packages/app/src/i18n/en.ts").toBe("")
  })
})
