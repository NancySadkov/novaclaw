import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { PermissionSaved } from "@novaclaw/core/permission/saved"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionStore } from "@novaclaw/core/session/store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

// Auto mode at the LIVE seam: a self-grant reaching `PermissionV2.evaluateInput`. The pure algebra
// is pinned by `auto-mode-algebra.test.ts`; this file proves the evaluator actually consults it, and
// every case here carries the same negative control — clear the grant and watch the verdict invert.
//
// ⚠️ Every probe uses `ask()`, never `assert()`, except where the verdict has ALREADY been measured
// as `deny`. `assert` parks on `Deferred.await` for an `ask` verdict and nothing reaps it, so a
// probe that guessed wrong would hang the suite rather than fail it.

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
      SettingsConfigStore.node,
    ]),
    [[Location.node, current]],
  ),
)

const insert = (input: {
  readonly id: string
  readonly type?: "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"
  readonly permissionMode?: "plan" | "ask" | "surgical" | "bypass" | "yolo"
  readonly parentID?: string
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make(input.id),
        slug: input.id,
        directory: "/project",
        title: input.id,
        version: "test",
        agent: "test",
        ...(input.type ? { type: input.type } : {}),
        ...(input.permissionMode ? { permission_mode: input.permissionMode } : {}),
        ...(input.parentID ? { parent_id: SessionV2.ID.make(input.parentID) } : {}),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

/** The `test` agent's own ruleset — empty, so the mode overlay is the only thing ruling on writes. */
const setRules = Effect.gen(function* () {
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) =>
    editor.update(AgentV2.ID.make("test"), (agent) => {
      agent.permissions = []
    }),
  )
})

/** ⚠️ The grant map is process-global by design (`permission.ts` §AUTO MODE), so a test that does
 *  not clear it inherits the previous one. */
const setup = Effect.gen(function* () {
  PermissionV2.clearAutoGrants()
  yield* setRules
})

const verdict = (sessionID: string, action: string, resource: string) =>
  Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    return (yield* service.ask({ sessionID: SessionV2.ID.make(sessionID), action, resources: [resource] })).effect
  })

describe("auto mode reaches the live evaluator", () => {
  it.effect("a self-grant NARROWS a real verdict, and clearing it restores the user's mode", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insert({ id: "ses_auto_one", permissionMode: "bypass" })

      // The user picked Build, so a write inside the folder is allowed outright.
      expect(yield* verdict("ses_auto_one", "write", "src/x.ts")).toBe("allow")

      // The agent drops itself to Analyze, in writing. The mode overlay's HARD deny arm now bites.
      PermissionV2.setAutoGrant("ses_auto_one", {
        mode: "plan",
        justification: "reading the codebase first; I will not change anything yet",
        at: Date.now(),
      })
      expect(yield* verdict("ses_auto_one", "write", "src/x.ts")).toBe("deny")

      // NEGATIVE CONTROL: nothing about the session, the agent or the mode overlay changed — only
      // the grant. Remove it and the same call is allowed again.
      PermissionV2.clearAutoGrants()
      expect(yield* verdict("ses_auto_one", "write", "src/x.ts")).toBe("allow")
    }),
  )

  it.effect("a grant MORE capable than the user's pick changes nothing — it cannot widen", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insert({ id: "ses_auto_widen", permissionMode: "ask" })

      expect(yield* verdict("ses_auto_widen", "write", "src/x.ts")).toBe("ask")
      // The strongest thing a forged or injected grant could ask for, at the live seam.
      PermissionV2.setAutoGrant("ses_auto_widen", { mode: "yolo", justification: "trust me", at: Date.now() })
      expect(yield* verdict("ses_auto_widen", "write", "src/x.ts")).toBe("ask")
    }),
  )

  it.effect("a PARENT's self-revocation follows into a child that never called the tool", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insert({ id: "ses_auto_root", permissionMode: "bypass" })
      yield* insert({ id: "ses_auto_kid", parentID: "ses_auto_root" })

      expect(yield* verdict("ses_auto_kid", "write", "src/x.ts")).toBe("allow")

      // The parent drops itself. The child's own row is untouched — and that is exactly the escape
      // this fold closes: a child resolves its mode from stored rows, which a grant never writes.
      PermissionV2.setAutoGrant("ses_auto_root", {
        mode: "plan",
        justification: "handing off; the helper only needs to read",
        at: Date.now(),
      })
      expect(yield* verdict("ses_auto_kid", "write", "src/x.ts")).toBe("deny")

      // NEGATIVE CONTROL.
      PermissionV2.clearAutoGrants()
      expect(yield* verdict("ses_auto_kid", "write", "src/x.ts")).toBe("allow")
    }),
  )

  it.effect("an UNATTENDED chain cannot hold `yolo` once it self-manages", () =>
    Effect.gen(function* () {
      yield* setup
      // The documented escape from the deny-fast stance: an unattended root the USER set to yolo.
      yield* insert({ id: "ses_auto_unattended", type: "goal-oriented", permissionMode: "yolo" })

      // Untouched while it holds no grant — this feature must not rewrite a posture the user chose.
      expect(yield* verdict("ses_auto_unattended", "external_directory_write", "/outside/x.ts")).toBe("allow")

      // It self-manages, asking for exactly what it already had. `AUTO_UNATTENDED_CEILING` caps it
      // at `bypass`, so the unattended confinement stance re-engages.
      PermissionV2.setAutoGrant("ses_auto_unattended", {
        mode: "yolo",
        justification: "I would like to keep full access for this run",
        at: Date.now(),
      })
      expect(yield* verdict("ses_auto_unattended", "external_directory_write", "/outside/x.ts")).toBe("deny")

      // ...and it is refused as the confinement stance, with the wording an unattended run needs —
      // measured through `assert`, which is safe here because the verdict above is already `deny`.
      const service = yield* PermissionV2.Service
      const exit = yield* service
        .assert({
          sessionID: SessionV2.ID.make("ses_auto_unattended"),
          action: "external_directory_write",
          resources: ["/outside/x.ts"],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(PermissionV2.DeniedError)
      expect((error as PermissionV2.DeniedError).reason).toBe("unattended-confined")

      // NEGATIVE CONTROL: the user's own `yolo` is still the way out — only the SELF-grant is capped.
      PermissionV2.clearAutoGrants()
      expect(yield* verdict("ses_auto_unattended", "external_directory_write", "/outside/x.ts")).toBe("allow")
    }),
  )

  it.effect("an UNREADABLE chain takes the same restrictive arm as an unattended one", () =>
    Effect.gen(function* () {
      yield* setup
      // A dangling `parent_id`: `rootAttendance` answers `"unknown"`, which `attendedRoot` treats as
      // not attended. The tri-state exists for exactly this.
      yield* insert({ id: "ses_auto_broken", permissionMode: "yolo", parentID: "ses_auto_missing" })

      PermissionV2.setAutoGrant("ses_auto_broken", {
        mode: "yolo",
        justification: "keeping full access across the broken chain",
        at: Date.now(),
      })
      expect(yield* verdict("ses_auto_broken", "external_directory_write", "/outside/x.ts")).toBe("deny")

      // NEGATIVE CONTROL — and it also pins the boundary between this feature and B4c's. WITHOUT a
      // grant, `unattendedStanceRules` bows out because the mode is `yolo` (the deliberate way out
      // of the stance), so the call is allowed. The refusal above is therefore the auto-mode cap
      // and nothing else, which is the claim this test is entitled to make.
      PermissionV2.clearAutoGrants()
      expect(yield* verdict("ses_auto_broken", "external_directory_write", "/outside/x.ts")).toBe("allow")
    }),
  )
})
