import { describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { FSUtil } from "@novaclaw/core/fs-util"
import { AgentV2 } from "@novaclaw/core/agent"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { PermissionSaved } from "@novaclaw/core/permission/saved"
import { SessionEffectiveConfig } from "@novaclaw/core/session/effective-config"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionV2 } from "@novaclaw/core/session"
import { AbsolutePath } from "@novaclaw/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

/**
 * A Project's permissions, through the LIVE evaluator.
 *
 * 🔴 `permission-narrowing.test.ts` pins the algebra; this pins that anything CALLS it. Those are two
 * different failures, and only one of them is visible from inside the algebra — a narrowing that is
 * perfect and unreachable is indistinguishable, from the user's side, from no narrowing at all.
 *
 * The location points at a REAL temp directory, because the whole path under test is "read the file
 * beside this session's folder": a fixture path resolves to nothing and the test would pass against
 * a build that never looked.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-perm-project-")))
fs.writeFileSync(
  path.join(root, "novaclaw.json"),
  JSON.stringify({ version: 1, name: "Locked", permissions: [{ action: "bash", resource: "*", effect: "deny" }] }),
)

const current = Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(root) })))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      FSUtil.node,
      SessionStore.node,
      SessionEffectiveConfig.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

// The operator's rules live on the AGENT, exactly as `permission.test.ts` seeds them. Putting them
// on the session row instead silently seeds NOTHING, and the resulting verdict then comes from the
// baseline rather than from the thing under test.
const seed = (rules: PermissionV2.Ruleset) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        slug: "test",
        directory: root,
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })

const assertion = (action: string, resource: string) => ({
  sessionID: SessionV2.ID.make("ses_test"),
  action,
  resources: [resource],
  id: PermissionV2.ID.create("per_test"),
})

/**
 * 🔴 THE NEGATIVE CONTROL, and it is not optional here. The deny in the first test passed even while
 * the seed was silently writing nothing — the verdict happened to be `deny` for an unrelated reason.
 * A second location with NO project file, and everything else identical, is the only thing that shows
 * the deny came from the file rather than from the stack around it.
 */
const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-perm-bare-")))
const itBare = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      FSUtil.node,
      SessionStore.node,
      SessionEffectiveConfig.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(bare) }))),
      ],
    ],
  ),
)

describe("without a project file", () => {
  itBare.effect("the same operator allow is ALLOWED — so the deny above was the file", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionV2.ID.make("ses_test"),
          slug: "test",
          directory: bare,
          title: "test",
          version: "test",
          agent: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("test"), (agent) => {
          agent.permissions = [{ action: "bash", resource: "*", effect: "allow" }]
        }),
      )
      const service = yield* PermissionV2.Service
      expect((yield* service.ask(assertion("bash", "ls"))).effect).toBe("allow")
    }),
  )
})

describe("a project file constrains the live evaluator", () => {
  it.effect("🔴 the project's DENY beats the operator's allow", () =>
    Effect.gen(function* () {
      // The operator allows every bash; the folder's `novaclaw.json` denies it. Under the ordinary
      // append-and-findLast composition the project would have had to LOSE this — appending is how
      // you override, so a narrowing constraint had to be a different operation entirely.
      yield* seed([{ action: "bash", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const verdict = yield* service.ask(assertion("bash", "ls"))
      expect(verdict.effect).toBe("deny")
    }),
  )

  it.live("🔴 TIGHTENING the file reaches a RUNNING location", () =>
    Effect.gen(function* () {
      // The staleness this closes ran the UNSAFE way: read once at layer build, a user who tightened
      // their project kept the LOOSER rules until the layer rebuilt. `it.live` because the freshness
      // bound is wall-clock — a TestClock would never expire it, and the test would pass by never
      // exercising the revalidation at all.
      yield* seed([{ action: "webfetch", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect((yield* service.ask(assertion("webfetch", "https://example.com"))).effect).toBe("allow")

      fs.writeFileSync(
        path.join(root, "novaclaw.json"),
        JSON.stringify({
          version: 1,
          permissions: [
            { action: "bash", resource: "*", effect: "deny" },
            { action: "webfetch", resource: "*", effect: "deny" },
          ],
        }),
      )
      yield* Effect.sleep("1200 millis")
      expect((yield* service.ask(assertion("webfetch", "https://example.com"))).effect).toBe("deny")
    }),
  )

  it.effect("🔴 a project denial says SO — the reason points at the file", () =>
    Effect.gen(function* () {
      // Without this a refused user is told only "denied" and goes looking through their own
      // settings, which are innocent. The advice this reason carries is different from every other
      // one: read the file in the folder, which may have come from whoever they cloned it from.
      yield* seed([{ action: "bash", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const result = yield* service.assert(assertion("bash", "ls")).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (!Exit.isFailure(result)) return
      const error = Cause.squash(result.cause)
      expect(error).toBeInstanceOf(PermissionV2.DeniedError)
      expect((error as PermissionV2.DeniedError).reason).toBe("project-denied")
    }),
  )

  it.effect("🔴 a denial the OPERATOR would have made anyway is NOT blamed on the project", () =>
    Effect.gen(function* () {
      // The wrong-pointer case, and the reason `projectDenied` re-evaluates without the constraint.
      // Here the operator denies bash outright; the project also denies it. Reporting
      // `project-denied` would send the user to read a file that changed nothing.
      yield* seed([{ action: "bash", resource: "*", effect: "deny" }])
      const service = yield* PermissionV2.Service
      const result = yield* service.assert(assertion("bash", "ls")).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (!Exit.isFailure(result)) return
      const error = Cause.squash(result.cause)
      expect((error as PermissionV2.DeniedError).reason).toBeUndefined()
    }),
  )

  it.effect("an action the project says nothing about is untouched", () =>
    Effect.gen(function* () {
      // The opposite failure, and the one that would make the feature unusable: silence read as
      // `ask` would mean this file tightens every action it never mentions.
      yield* seed([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      // INSIDE the root: a path outside it is refused by the external-directory baseline, which
      // would make this test pass or fail for a reason that has nothing to do with the project file.
      const verdict = yield* service.ask(assertion("read", path.join(root, "file.txt")))
      expect(verdict.effect).toBe("allow")
    }),
  )
})

describe("an unusable project file fails closed", () => {
  for (const scenario of [
    {
      name: "malformed",
      content: "{ not json",
      reason: "project-file-invalid" as const,
      remedy: "Fix the project file",
    },
    {
      name: "future-version",
      content: JSON.stringify({ version: 9999 }),
      reason: "project-file-future-version" as const,
      remedy: "Upgrade NovaClaw",
    },
  ])
    it.effect(`${scenario.name} refuses an otherwise allowed action and names the repair`, () =>
      Effect.gen(function* () {
        fs.writeFileSync(path.join(root, "novaclaw.json"), scenario.content)
        yield* seed([{ action: "read", resource: "*", effect: "allow" }])
        const service = yield* PermissionV2.Service
        expect((yield* service.ask(assertion("read", "README.md"))).effect).toBe("deny")

        const result = yield* service.assert(assertion("read", "README.md")).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (!Exit.isFailure(result)) return
        const error = Cause.squash(result.cause)
        expect(error).toBeInstanceOf(PermissionV2.DeniedError)
        expect((error as PermissionV2.DeniedError).reason).toBe(scenario.reason)
        expect(PermissionV2.denialMessage(error)).toContain(path.join(root, "novaclaw.json"))
        expect(PermissionV2.denialMessage(error)).toContain(scenario.remedy)
      }),
    )

  it.effect("a fault raises both supervision rails even over explicit per-chat false values", () =>
    Effect.gen(function* () {
      fs.writeFileSync(path.join(root, "novaclaw.json"), "{ not json")
      yield* seed([{ action: "*", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ safe_mode: false, ask_before_changes: false })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const config = yield* (yield* SessionEffectiveConfig.Service).resolve(SessionV2.ID.make("ses_test"))
      expect(config.safeMode).toBe(true)
      expect(config.askBeforeChanges).toBe(true)
    }),
  )
})

describe("a project file's TUNE reaches the live evaluator", () => {
  it.effect("🔴 `askBeforeChanges` in the folder narrows an allowed write to a refusal", () =>
    Effect.gen(function* () {
      // The payoff claim for the whole layer: a component NO session declared, supplied by the
      // folder, changing a real verdict. Unit tests pin the fold; only this pins that anything
      // calls it — the same distinction this file's header draws for the permissions half.
      fs.writeFileSync(
        path.join(root, "novaclaw.json"),
        JSON.stringify({ version: 1, tune: { features: { askBeforeChanges: true } } }),
      )
      yield* seed([{ action: "write", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      // The operator allows every write; the folder asks to be consulted first, which NARROWS it.
      // ⚠️ Narrowing now lands on `deny` rather than `ask` (owner ruling 2026-08-20 removed asking as
      // an outcome). The CLAIM this test exists for is untouched and is about the fold, not the
      // verdict name: a component NO session declared, supplied by the folder, changed a real answer
      // from allow to not-allow. It would still fail if the project file were ignored.
      expect((yield* service.ask(assertion("write", "notes.md"))).effect).toBe("deny")
    }),
  )

  it.effect("⚠️ NEGATIVE CONTROL — the same write with no tune is allowed", () =>
    Effect.gen(function* () {
      // Without this the test above passes against a build that never read the tune: `ask` is also
      // what an unmatched write returns, so "ask" alone proves nothing about the folder.
      fs.writeFileSync(path.join(root, "novaclaw.json"), JSON.stringify({ version: 1 }))
      yield* seed([{ action: "write", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect((yield* service.ask(assertion("write", "notes.md"))).effect).toBe("allow")
    }),
  )

  it.effect("a switch whose readers do not fold yet is NOT applied", () =>
    Effect.gen(function* () {
      // `safeMode` is deferred (`ProjectDefaults.WIRED`): `tool/bash.ts` reads it without folding,
      // so applying it here would confine one decision in a chat and not the next. The negative
      // control is the point — this must not quietly start passing when someone widens the set
      // without wiring the readers.
      fs.writeFileSync(
        path.join(root, "novaclaw.json"),
        JSON.stringify({ version: 1, tune: { features: { safeMode: true } } }),
      )
      yield* seed([{ action: "bash", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect((yield* service.ask(assertion("bash", "ls"))).effect).toBe("allow")
    }),
  )
})
