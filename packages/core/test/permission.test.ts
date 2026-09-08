import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import nodePath from "node:path"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { PermissionTable } from "@novaclaw/core/permission/sql"
import { PermissionSaved } from "@novaclaw/core/permission/saved"
import { Project } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionAutoGrant } from "@novaclaw/core/session/auto-grant"
import { ASK_BEFORE_CHANGES_RULES, MODE_RULES } from "@novaclaw/core/session/config-resolve"
import { SessionTable } from "@novaclaw/core/session/sql"
import { Global } from "@novaclaw/core/global"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"
import { SessionEffectiveConfig } from "@novaclaw/core/session/effective-config"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionRecordEvent } from "@novaclaw/schema/session-record-event"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { stripComments } from "./lib/source-scan"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      // PermissionV2 reads the SESSION's `novaclaw.json` through the shared cache, and its config
      // through the one effective-config entry point; FSUtil is how the cache reaches the disk.
      FSUtil.node,
      ProjectFileCache.node,
      SessionStore.node,
      SessionEffectiveConfig.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

/**
 * The ruleset currently in force, remembered so `insertSession` can mirror it onto the agent it
 * creates. See that helper for why each fixture session now owns a different agent.
 */
let currentRules: PermissionV2.Ruleset = []

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    currentRules = [...rules]
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) => {
      // Every agent this fixture has minted, not just "test": a test that inserts its scenario
      // session BEFORE calling `setRules` must still see the rules applied to it.
      for (const id of fixtureAgents)
        editor.update(AgentV2.ID.make(id), (agent) => {
          agent.permissions = [...rules]
        })
    })
  })
}

/** Every agent id this fixture has created a session for, `"test"` included. */
const fixtureAgents = new Set<string>(["test"])

/** Insert an extra session row so a test can exercise the CHAIN (type + mode live on the row). */
function insertSession(input: {
  readonly id: string
  readonly type?: "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"
  readonly permissionMode?: "plan" | "ask" | "surgical" | "bypass" | "yolo"
  readonly parentID?: string
  /** Override the session's agent; defaults to the session id (one live root per agent). */
  readonly agent?: string
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const agentID = input.agent ?? input.id
    fixtureAgents.add(agentID)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make(input.id),
        slug: input.id,
        directory: "/project",
        title: input.id,
        version: "test",
        // 🔴 ONE LIVE ROOT PER AGENT is now a DATABASE constraint
        // (`session_agent_live_root_idx`), and this fixture used to give every scenario session the
        // SAME agent `"test"` — several live roots for one colleague, a state the product cannot
        // reach because `createSessionRecord` returns the existing chat instead of minting a second.
        // With `.onConflictDoNothing()` the second insert silently did nothing and the test then
        // failed with `Session.NotFoundError`, which names neither the cause nor the row.
        //
        // The agent was only ever incidental here — these rows exist to vary `type` and
        // `permissionMode`, which live on the ROW — so each session now owns its own agent, and
        // `setRules` mirrors the ruleset onto all of them so agent-scoped resolution is unchanged.
        agent: input.agent ?? input.id,
        ...(input.type ? { type: input.type } : {}),
        ...(input.permissionMode ? { permission_mode: input.permissionMode } : {}),
        ...(input.parentID ? { parent_id: SessionV2.ID.make(input.parentID) } : {}),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    // Mirror the ruleset in force onto this session's own agent, so a scenario row resolves exactly
    // the permissions it did when every fixture session shared one agent.
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make(agentID), (agent) => {
        agent.permissions = [...currentRules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

/** An edit of `/project/task.md`, where that file is also one of the user's attachments. */
const editingAnAttachment = (input: Partial<PermissionV2.AssertInput> = {}) =>
  assertion({
    action: "edit",
    resources: ["task.md"],
    targets: [{ resource: "task.md", canonical: "/project/task.md" }],
    attachmentPaths: ["/project/task.md"],
    ...input,
  })

describe("PermissionV2", () => {
  it.effect("returns the evaluated effect", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
    }),
  )

  it.effect("honours a caller's minimum verdict without softening a denial", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "bash", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(
        yield* service.ask(assertion({ action: "bash", resources: ["echo $(whoami)"], minimumEffect: "ask" })),
      ).toMatchObject({ effect: "deny" })
      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(
        yield* service.ask(
          assertion({
            id: PermissionV2.ID.create("per_minimum_deny"),
            action: "bash",
            resources: ["echo $(whoami)"],
            minimumEffect: "ask",
          }),
        ),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("turns an unanswerable minimum ask into an unattended denial", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "bash", resource: "*", effect: "allow" }])
      const sessionID = SessionV2.ID.make("ses_unparseable_shell")
      yield* insertSession({ id: sessionID, type: "goal-oriented", permissionMode: "bypass" })
      expect(
        yield* (yield* PermissionV2.Service).ask(
          assertion({
            id: PermissionV2.ID.create("per_unparseable_shell"),
            sessionID,
            action: "bash",
            resources: ["echo $(whoami)"],
            minimumEffect: "ask",
          }),
        ),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("lets a whole-command alias deny a segment but never grant it", () =>
    Effect.gen(function* () {
      const service = yield* PermissionV2.Service
      yield* setup([
        { action: "chain-probe", resource: "git status && rm -rf build", effect: "deny" },
        { action: "chain-probe", resource: "git status", effect: "allow" },
      ])
      expect(
        yield* service.ask(
          assertion({
            action: "chain-probe",
            resources: ["git status"],
            denyAliases: ["git status && rm -rf build"],
          }),
        ),
      ).toMatchObject({ effect: "deny" })

      yield* setRules([
        { action: "chain-probe", resource: "git status && rm -rf build", effect: "allow" },
        { action: "chain-probe", resource: "git status", effect: "ask" },
      ])
      expect(
        yield* service.ask(
          assertion({
            id: PermissionV2.ID.create("per_alias_allow"),
            action: "chain-probe",
            resources: ["git status"],
            denyAliases: ["git status && rm -rf build"],
          }),
        ),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const denied = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(denied).toBeInstanceOf(PermissionV2.DeniedError)
    }),
  )

  // ── Attached-source protection ────────────────────────────────────────────────────────────────
  // Ported from outside contribution #9 by @DassaultFalconKing. These drive
  // the LIVE evaluator because the pure predicate is the easy half — what decides whether the
  // feature exists at all is where the rule sits relative to the mode overlay and to saved answers.

  it.effect("NEGATIVE CONTROL: the same edit, one path away from the attachment, is not asked about", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const sessionID = SessionV2.ID.make("ses_attached_miss")
      yield* insertSession({ id: sessionID, type: "interactive", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      // Same basename, different directory — the case a basename comparison would get wrong.
      expect(
        yield* service.ask(
          editingAnAttachment({ sessionID, targets: [{ resource: "out/task.md", canonical: "/project/out/task.md" }] }),
        ),
      ).toMatchObject({ effect: "allow" })
      // And a turn with no attachments at all is completely untouched.
      expect(yield* service.ask(editingAnAttachment({ sessionID, attachmentPaths: [] }))).toMatchObject({
        effect: "allow",
      })
    }),
  )

  it.effect("a saved answer releases the protection only when it NAMES the file", () =>
    Effect.gen(function* () {
      // The rule this pins: every one of these asserts offers `save: ["*"]`, so if a wildcard saved
      // answer could release the protection, the first ordinary "always allow edits" would switch it
      // off forever and the whole feature would be theatre.
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const saved = yield* PermissionSaved.Service
      const sessionID = SessionV2.ID.make("ses_attached_saved")
      yield* insertSession({ id: sessionID, type: "interactive", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service

      // The rule an ordinary "always allow edits" leaves behind — these asserts all offer `save: ["*"]`.
      yield* saved.add({ origin: Project.ID.global, action: "edit", resources: ["*"] })
      expect(yield* service.ask(editingAnAttachment({ sessionID }))).toMatchObject({ effect: "deny" })

      // Answering "always" to THIS file's own ask names it, and that does end the asking.
      yield* saved.add({ origin: Project.ID.global, action: "edit", resources: ["task.md"] })
      expect(yield* service.ask(editingAnAttachment({ sessionID }))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("an UNATTENDED root is DENIED with a named reason rather than parked on an ask nobody can answer", () =>
    Effect.gen(function* () {
      // Same stance as `unattendedStanceRules`: a pending ask is an in-memory, location-scoped Map,
      // so parking one in an unattended run is a hang that does not even survive a restart.
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const sessionID = SessionV2.ID.make("ses_attached_unattended")
      yield* insertSession({ id: sessionID, type: "goal-oriented", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      const exit = yield* service.assert(editingAnAttachment({ sessionID })).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const error = yield* service.assert(editingAnAttachment({ sessionID })).pipe(Effect.flip)
      expect(error).toBeInstanceOf(PermissionV2.DeniedError)
      expect((error as PermissionV2.DeniedError).reason).toBe("attachment-protected")
      expect(PermissionV2.denialMessage(error)).toContain("NEW file")
    }),
  )

  it.effect("yolo stays the one deliberate way out, exactly as it is for the unattended stance", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const sessionID = SessionV2.ID.make("ses_attached_yolo")
      yield* insertSession({ id: sessionID, type: "interactive", permissionMode: "yolo" })
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(editingAnAttachment({ sessionID }))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("🔴 an omitted agent uses the DEFAULT OFFICER's permissions, not a posture's", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      // Owner, 2026-08-24: a chat nobody attributed belongs to Nova, not to `build`. Before the
      // ruling this test configured `build` and expected build's answer — the posture WAS the
      // default, which is the haunting the owner named (an agent that answers you but has no
      // roster row and no chat of its own).
      yield* agents.transform((editor) =>
        editor.update(AgentV2.DEFAULT_COLLEAGUE_ID, (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )
      // The negative half, and the one that actually pins the change: `build` is given the OPPOSITE
      // rule, so a resolution that still fell through to the posture would deny and fail here rather
      // than pass by agreeing with Nova by accident.
      yield* agents.transform((editor) =>
        editor.update(AgentV2.BUILD_ID, (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "deny" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
    }),
  )

  it.effect("ask-mode consent wraps configured bash allows (a configured allow-all never runs bash silently)", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      // Pin the mode EXPLICITLY rather than leaning on the instance default — that default is now
      // `bypass` (write freely inside the folder), so a test about ask-mode has to ask for ask mode.
      // A separate id, because `setup` already created ses_test and insertSession does nothing on conflict.
      yield* insertSession({ id: "ses_ask_mode", permissionMode: "ask" })
      const service = yield* PermissionV2.Service
      const bash = assertion({
        sessionID: SessionV2.ID.make("ses_ask_mode"),
        action: "bash",
        resources: ["pwd"],
      })
      // Under ask mode the MODE_RULES overlay converts the configured allow into consent — the mode
      // labeled "Ask" must actually ask (issues.md P1). A saved allow-always later quiets this
      // (covered in permission-modes.test.ts).
      // ⚠️ The mode's PURPOSE survives and is now held more strictly: a configured allow-all still
      // never runs bash silently — it is refused rather than merely gated. What is gone is the queued
      // record, because nothing is asked (owner ruling 2026-08-20). Under the owner's three modes this
      // is what "project-bound" means: anything not explicitly granted is refused, in advance.
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ origin: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  // A deleted session must take its pending asks with it: the V2 session-scoped reply route can
  // never settle them once the session row is gone, so without the sweep they orphan forever.

  // A SETTLED DRAIN takes its pending asks with it too (owner-hit 2026-07-22): once the drain
  // publishes idle/exited (Stop, exit, error) the tool awaiting the answer is gone, and a stale
  // ask wedged the chat — the ask dock replaces the composer, leaving no Stop and no way to
  // re-prompt.

  // ⚠️ Rewritten 2026-08-20. This used to reach the saved store through the ask/reply lifecycle —
  // fork an assert, wait for `Asked`, reply "always" — and that lifecycle no longer exists. The
  // STORE is very much alive, and more central than before: pre-granted rules are how consent works
  // now that nothing is negotiated per path. So it is exercised directly.
  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const saved = yield* PermissionSaved.Service

      yield* saved.add({ origin: Project.ID.global, action: "read", resources: ["src/*"] })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.origin, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])

      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([
        { id, origin: Project.ID.global, action: "read", resource: "src/*", effect: "allow" },
      ])

      // ⭐ The point of a saved rule: a matching assert passes WITHOUT anyone being asked. That is the
      // owner's model — consent granted in advance, never negotiated mid-task.
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))

      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// The unattended confinement stance (deny-fast). An unattended run that hits an ask does not get
// gated, it HANGS — measured live as a queued recipe cook sitting on three pending `bash` asks with
// nobody at the keyboard. So an out-of-folder create/modify under an UNATTENDED chain root is
// refused OUTRIGHT, with an error the model can route around. The switch is the pair that already
// exists: the root's thread type (attendance) and the permission mode (`yolo` = the way out).
// ─────────────────────────────────────────────────────────────────────────────
// The two former MODES, now Tuning switches. Both must NARROW whatever mode is active and never widen it,
// and both are OFF unless the session row says otherwise — a switch that defaulted ON would silently change
// what "Build" means for every existing chat.
describe("PermissionV2 — the surgical / ask switches", () => {
  const buildAgent: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
  const on = (feature: "surgicalEdits" | "askBeforeChanges", id: string) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set(feature === "surgicalEdits" ? { surgical_edits: true } : { ask_before_changes: true })
        .where(eq(SessionTable.id, SessionV2.ID.make(id)))
        .run()
        .pipe(Effect.orDie)
    })

  it.effect("both default OFF under Build — a whole-file write and a shell command just run", () =>
    Effect.gen(function* () {
      yield* setup(buildAgent)
      yield* insertSession({ id: "ses_build", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      const sessionID = SessionV2.ID.make("ses_build")
      // The NEGATIVE CONTROL for the consent test below, and driven from the same constant so it
      // keeps tracking it: every action the switch turns into an ask must be a silent allow while
      // the switch is off, or that test would be green for a reason other than the switch.
      for (const rule of ASK_BEFORE_CHANGES_RULES)
        expect(
          yield* service.ask(assertion({ sessionID, action: rule.action, resources: ["src/a.ts"] })),
        ).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("surgicalEdits ON denies a whole-file write but leaves edit/create alone", () =>
    Effect.gen(function* () {
      yield* setup(buildAgent)
      yield* insertSession({ id: "ses_surgical", permissionMode: "bypass" })
      yield* on("surgicalEdits", "ses_surgical")
      const service = yield* PermissionV2.Service
      const sessionID = SessionV2.ID.make("ses_surgical")
      expect(yield* service.ask(assertion({ sessionID, action: "write", resources: ["src/a.ts"] }))).toMatchObject({
        effect: "deny",
      })
      for (const action of ["edit", "create"])
        expect(yield* service.ask(assertion({ sessionID, action, resources: ["src/a.ts"] }))).toMatchObject({
          effect: "allow",
        })
    }),
  )

  it.effect("askBeforeChanges ON turns Build's silent allows into consent, including bash", () =>
    Effect.gen(function* () {
      yield* setup(buildAgent)
      yield* insertSession({ id: "ses_ask_sw", permissionMode: "bypass" })
      yield* on("askBeforeChanges", "ses_ask_sw")
      const service = yield* PermissionV2.Service
      const sessionID = SessionV2.ID.make("ses_ask_sw")
      // Driven FROM the shared constant, never from a hand-copied list. This is what turns
      // ASK_BEFORE_CHANGES_RULES into a mechanical link instead of a naming convention: the
      // evaluator reads that array (permission.ts, `resolved.askBeforeChanges`) and so does this
      // loop, so a row added there has to be honoured HERE, by the live service, or this goes red.
      // A distinct id per action: an `ask` verdict QUEUES a pending permission, so reusing one id collides.
      expect(ASK_BEFORE_CHANGES_RULES.length).toBeGreaterThan(0)
      for (const rule of ASK_BEFORE_CHANGES_RULES)
        expect(
          yield* service.ask(
            assertion({
              id: PermissionV2.ID.create(`per_${rule.action}`),
              sessionID,
              action: rule.action,
              resources: ["src/a.ts"],
            }),
          ),
        ).toMatchObject({ effect: "deny" })
      // The row the shell half of the i18n promise rests on ("...and before it runs a shell command").
      expect(ASK_BEFORE_CHANGES_RULES.map((rule) => rule.action)).toContain("bash")
      // ...but a READ is not a change, so it still goes through untouched.
      expect(yield* service.ask(assertion({ sessionID, action: "read", resources: ["src/a.ts"] }))).toMatchObject({
        effect: "allow",
      })
    }),
  )

  it.effect("askBeforeChanges asks before quality_provision's verify command — why the tool asserts `bash`", () =>
    Effect.gen(function* () {
      // The switch's copy promises "…and before it runs a shell command". `quality_provision` rung 1
      // runs each candidate through the agent shell (and a candidate can come straight from the
      // model), so under this switch it has to ASK — which it does only because the tool now asserts
      // `bash` on the command string. The source guard at the bottom of this file pins that half;
      // this is the evaluator half.
      yield* setup(buildAgent)
      yield* insertSession({ id: "ses_ask_prov", permissionMode: "bypass" })
      yield* on("askBeforeChanges", "ses_ask_prov")
      const service = yield* PermissionV2.Service
      const sessionID = SessionV2.ID.make("ses_ask_prov")
      const command = "bun test"
      expect(
        yield* service.ask(
          assertion({
            id: PermissionV2.ID.create("per_prov_bash"),
            sessionID,
            action: "bash",
            resources: [command],
            save: [command],
          }),
        ),
      ).toMatchObject({ effect: "deny" })
      // NEGATIVE CONTROL — the assert as it shipped. Same tool, same command, same switch ON, and
      // SILENT: `provision` is not a row in the overlay and cannot be reached by one (a rule list
      // enumerates action names ahead of time; see the MODE_RULES note). That is precisely how the
      // shell slipped past a switch that promised to stop it, and why the fix is the action name.
      expect(
        yield* service.ask(
          assertion({
            id: PermissionV2.ID.create("per_prov_only"),
            sessionID,
            action: "provision",
            resources: [`test: ${command}`],
            save: ["*"],
          }),
        ),
      ).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("Analyze is read-only, EXCEPT it may still write its report into the temp dir", () =>
    Effect.gen(function* () {
      yield* setup(buildAgent)
      yield* insertSession({ id: "ses_analyze", permissionMode: "plan" })
      const service = yield* PermissionV2.Service
      const sessionID = SessionV2.ID.make("ses_analyze")
      // In-project writes are refused...
      for (const action of ["edit", "write", "create", "trash"])
        expect(yield* service.ask(assertion({ sessionID, action, resources: ["src/a.ts"] }))).toMatchObject({
          effect: "deny",
        })
      // ...while the report path is allowed, so a review can save its findings.
      const report = `${Global.Path.tmp.replaceAll("\\", "/")}/report.md`
      for (const action of ["create", "write"])
        expect(yield* service.ask(assertion({ sessionID, action, resources: [report] }))).toMatchObject({
          effect: "allow",
        })
    }),
  )

  it.effect("Analyze denies execution, and a saved allow-always cannot soften it", () =>
    Effect.gen(function* () {
      // The companion assertions in src/permission-modes.test.ts prove MODE_RULES.plan CONTAINS the
      // bash/js denies. They cannot prove the evaluator still CONSULTS them: deleting
      // `denied(input, modeRules)` from permission.ts's hard early-deny arm leaves that pure test
      // green while Analyze silently permits `rm -rf` again. This is the end-to-end half.
      yield* setup(buildAgent)
      yield* insertSession({ id: "ses_analyze_exec", permissionMode: "plan" })
      const service = yield* PermissionV2.Service
      const sessionID = SessionV2.ID.make("ses_analyze_exec")

      for (const action of ["bash", "js"]) {
        const input = assertion({ sessionID, action, resources: ["rm -rf /"], save: ["*"] })
        // `ask` reports the verdict...
        expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
        // ...and `assert` — the path every tool takes — fails immediately rather than parking a
        // question. That absence is the guarantee: a mode deny sits in the HARD arm above the
        // ruleset, so the user is never offered an "allow always" that could soften it. Asserting
        // the empty queue is how the sibling unattended-confinement test proves the same shape.
        const error = yield* service.assert(input).pipe(Effect.flip)
        expect(error).toBeInstanceOf(PermissionV2.DeniedError)
      }
    }),
  )

  it.effect("Analyze denies `provision` and `revert` — and the report carve-out does not exempt them", () =>
    Effect.gen(function* () {
      // Same promise as the bash/js test above, from the two directions that hid behind a non-file
      // action name, and it needs an end-to-end leg for the same reason: the pure test proves
      // MODE_RULES.plan CONTAINS the rules, never that the hard arm still consults them.
      // `quality_provision` asserts under `provision` and then runs MODEL-SUPPLIED command strings
      // through the agent shell (a second door onto the shell that `bash` had just been denied);
      // `revert` asserts under `revert` and overwrites working-tree files from a git snapshot.
      yield* setup(buildAgent)
      yield* insertSession({ id: "ses_analyze_mutate", permissionMode: "plan" })
      const service = yield* PermissionV2.Service
      const sessionID = SessionV2.ID.make("ses_analyze_mutate")
      const report = `${Global.Path.tmp.replaceAll("\\", "/")}/report.md`

      for (const [action, resource] of [
        ["provision", "test: rm -rf /"],
        ["revert", "src/a.ts"],
        // Analyze's report carve-out (permission.ts, REPORT_RESOURCE) re-allows create/write/edit/
        // external_directory_write for the temp dir, and it is folded into the SAME array the hard
        // arm reads — so pin that it does not leak to these two actions. It cannot: it is
        // action-scoped, and neither action can reach that path anyway (revert restores
        // project-relative snapshot files; provision's resources are `key: command` strings, not
        // paths). Asserting it means a future carve-out widened to `*` fails here instead of
        // quietly reopening the mode.
        ["provision", report],
        ["revert", report],
      ] as const) {
        const input = assertion({ sessionID, action, resources: [resource], save: ["*"] })
        expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
        // A deny queues nothing, so reusing the default id across the loop is safe — and the empty
        // queue IS the guarantee: the user is never offered an "allow always" that could soften it.
        const error = yield* service.assert(input).pipe(Effect.flip)
        expect(error).toBeInstanceOf(PermissionV2.DeniedError)
      }
    }),
  )
})

describe("PermissionV2 — unattended confinement stance", () => {
  // A deliberately permissive stand-in, so these tests measure the CONFINEMENT STANCE and not the
  // baseline: the stance is checked in its own hard arm before any allow is consulted, so an
  // allow-everything ruleset is the strongest possible thing for it to have to override. There is
  // deliberately no blanket external_directory_read rule here — the evaluator contributes that
  // mode-independent baseline, while the write row below remains independently consent-gated.
  // ⚠️ This is NO LONGER the real build agent's baseline. v0.2.0 B4c replaced `plugin/agent.ts`'s
  // opening catch-all with `PermissionV2.AMBIENT_SAFE_BASELINE`; what the shipped baseline resolves to
  // is pinned in `test/permission-baseline.test.ts` against the agents the plugin actually builds.
  const buildAgentRules: PermissionV2.Ruleset = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "external_directory_write", resource: "*", effect: "ask" },
  ]
  const outside = (input: Partial<PermissionV2.AssertInput> = {}) =>
    assertion({
      action: "external_directory_write",
      resources: ["C:/elsewhere/*"],
      save: ["C:/elsewhere/*"],
      ...input,
    })

  it.effect("an out-of-folder write is DENIED OUTRIGHT for an unattended session — no pending ask", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service

      const input = outside({ sessionID: SessionV2.ID.make("ses_cron") })
      // `ask` reports the verdict without blocking.
      expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
      // `assert` — the path every mutating tool takes — fails immediately.
      const error = yield* service.assert(input).pipe(Effect.flip)
      expect(error).toBeInstanceOf(PermissionV2.DeniedError)
      expect((error as PermissionV2.DeniedError).reason).toBe("unattended-confined")

      // This is exactly what the agent sees (every mutating tool lowers it through denialMessage
      // into a ToolFailure the model reads as an error-state tool result — never a silent no-op).
      const message = PermissionV2.denialMessage(error)!
      expect(message).toContain("UNATTENDED")
      expect(message).toContain("waiting or retrying will change nothing")
      expect(message).not.toContain("ask the user")
    }),
  )

  it.effect("the identical request on an INTERACTIVE session still asks (attended path untouched)", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_chat", type: "interactive", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      // ⚠️ Both roots DENY since asking was removed (owner 2026-08-20). `effect` can no longer tell
      // the attended path from the unattended one — the REASON does, and checking it is stricter:
      // this fails if the two are ever collapsed into a single verdict.
      expect(yield* service.ask(outside({ sessionID: SessionV2.ID.make("ses_chat") }))).toMatchObject({
        effect: "deny",
      })
      const attended = yield* service.assert(outside({ sessionID: SessionV2.ID.make("ses_chat") })).pipe(Effect.flip)
      expect((attended as PermissionV2.DeniedError).reason).toBe("ask-removed")
    }),
  )

  // ── the chain we could not read (2026-07-28) ───────────────────────────────────────────────
  // `session.parent_id` carries NO foreign key (session/sql.ts:22), so a row pointing at a parent
  // that is gone is representable in the schema — a session deleted mid-turn, a partial recursive
  // delete, a corrupt tree. Before this change the walk answered with the deepest KNOWN layer's
  // type, so this exact row ("sub-agent") reported ATTENDED, `unattendedStanceRules` returned []
  // and the out-of-folder write below was an ASK. The chain root — the thing that decides
  // attendance — is precisely the row that vanished, so that was a containment answer invented
  // from missing data.
  it.effect("a chain that dangles at a MISSING parent is confined, and the denial names the real fault", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_orphan", type: "sub-agent", permissionMode: "bypass", parentID: "ses_ghost" })
      const service = yield* PermissionV2.Service
      const input = outside({ sessionID: SessionV2.ID.make("ses_orphan") })

      expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
      const error = yield* service.assert(input).pipe(Effect.flip)
      expect(error).toBeInstanceOf(PermissionV2.DeniedError)
      expect((error as PermissionV2.DeniedError).reason).toBe("chain-unreadable")

      // Ruling 2's other half: refusing for a real reason while describing the fault falsely is
      // still describing it falsely. The model is told the session RECORDS are broken — the thing
      // it can actually act on — not that it is an unattended run, which we never established.
      const message = PermissionV2.denialMessage(error)!
      expect(message).toContain("parent chain could not be read")
      expect(message).toContain("no user reply can unblock it")
      expect(message).not.toContain("ask the user")
      expect(message).not.toContain("this is an UNATTENDED session")
    }),
  )

  // NEGATIVE CONTROL for the test above: same row, same request, same mode — the ONLY difference is
  // that the parent row exists. Without this, the deny above could come from a guard that refuses
  // anything with a `parentID`, or from the stance having been switched on for everyone.
  it.effect("NEGATIVE CONTROL: give the orphan its parent back and the identical request ASKS again", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_ghost", type: "interactive", permissionMode: "bypass" })
      yield* insertSession({ id: "ses_orphan", type: "sub-agent", permissionMode: "bypass", parentID: "ses_ghost" })
      const service = yield* PermissionV2.Service
      // Both deny since asking was removed; the REASON keeps the two paths apart. Restoring the
      // parent moves it from "nobody could answer" to "we do not ask" — which is the distinction this
      // control exists to protect, now checked directly.
      expect(yield* service.ask(outside({ sessionID: SessionV2.ID.make("ses_orphan") }))).toMatchObject({
        effect: "deny",
      })
      const restored = yield* service.assert(outside({ sessionID: SessionV2.ID.make("ses_orphan") })).pipe(Effect.flip)
      expect((restored as PermissionV2.DeniedError).reason).toBe("ask-removed")
    }),
  )

  // The worst of the three shapes, because every row in it already SAYS nobody is watching: a
  // cyclic tree used to discard everything it had read and answer "interactive".
  it.effect("a CYCLIC chain is confined too — it used to answer 'interactive' and run raw", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_a", type: "auto-prompting", permissionMode: "bypass", parentID: "ses_b" })
      yield* insertSession({ id: "ses_b", type: "auto-prompting", permissionMode: "bypass", parentID: "ses_a" })
      const service = yield* PermissionV2.Service
      const error = yield* service.assert(outside({ sessionID: SessionV2.ID.make("ses_a") })).pipe(Effect.flip)
      expect((error as PermissionV2.DeniedError).reason).toBe("chain-unreadable")
    }),
  )

  // Measured, not assumed — and it is why the fix bites on the ANCESTOR case rather than this one.
  // `evaluateInput` computes the stance and then calls `configured()`, which fails
  // `Session.NotFoundError` when the TARGET row is absent, so a permission decision for a session
  // that does not exist never reaches an allow either way. The item that opened this work assumed
  // the missing-target row was the live hole; the dangling ANCESTOR is.
  it.effect("a permission asserted for a session that does not exist fails NotFound, not allow", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      const service = yield* PermissionV2.Service
      const error = yield* service
        .assert(outside({ sessionID: SessionV2.ID.make("ses_nonexistent") }))
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionV2.NotFoundError)
    }),
  )

  // Reads are host-wide in every mode and for every thread type. This is intentionally a separate
  // contract from writes: YOLO only removes the external-WRITE consent boundary.
  it.effect("the out-of-folder READ class is allowed in every mode, attended or unattended", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "external_directory_write", resource: "*", effect: "ask" }])
      const service = yield* PermissionV2.Service
      const cases = [
        ["plan", "interactive"],
        ["ask", "sub-agent"],
        ["surgical", "auto-prompting"],
        ["bypass", "goal-oriented"],
        ["yolo", "goal-oriented"],
      ] as const
      for (const [permissionMode, type] of cases) {
        const id = `ses_read_${permissionMode}`
        yield* insertSession({ id, type, permissionMode })
        expect(
          yield* service.ask(outside({ sessionID: SessionV2.ID.make(id), action: "external_directory_read" })),
        ).toMatchObject({ effect: "allow" })
      }
    }),
  )

  it.effect("an explicit authored deny can still narrow a particular external read", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "external_directory_read", resource: "C:/private/*", effect: "deny" },
        { action: "external_directory_write", resource: "*", effect: "ask" },
      ])
      yield* insertSession({ id: "ses_chat", type: "interactive", permissionMode: "yolo" })
      const service = yield* PermissionV2.Service
      expect(
        yield* service.ask(
          assertion({
            sessionID: SessionV2.ID.make("ses_chat"),
            action: "external_directory_read",
            resources: ["C:/private/*"],
          }),
        ),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("IN-folder work is untouched: the session still creates/edits/reads inside its own folder", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      const session = SessionV2.ID.make("ses_cron")
      for (const action of ["create", "write", "edit", "read", "trash"])
        expect(
          yield* service.ask(assertion({ sessionID: session, action, resources: ["out/report.md"] })),
        ).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("a saved allow-always cannot buy its way out (the stance is a HARD deny)", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      const saved = yield* PermissionSaved.Service
      // A grant the operator saved earlier, from an attended session at the same origin.
      yield* saved.add({ origin: Project.ID.global, action: "external_directory_write", resources: ["C:/elsewhere/*"] })
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(outside({ sessionID: SessionV2.ID.make("ses_cron") }))).toMatchObject({
        effect: "deny",
      })
    }),
  )

  // The narrowing composition. Attendance is the ROOT's property and `yolo` is the only exit, so a
  // spawned child gets clamped on BOTH axes — it can neither re-declare itself attended nor bid up
  // to yolo past its parent.
  it.effect("a spawned child cannot escalate out of the stance (root type wins, yolo is clamped)", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_root", type: "goal-oriented", permissionMode: "bypass" })
      yield* insertSession({
        id: "ses_kid",
        parentID: "ses_root",
        type: "interactive", // claims attendance…
        permissionMode: "yolo", // …and bids for the exit
      })
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(outside({ sessionID: SessionV2.ID.make("ses_kid") }))).toMatchObject({
        effect: "deny",
      })
    }),
  )

  it.effect("a ROOT that deliberately chooses yolo opts its whole subtree out of the stance", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_root", type: "goal-oriented", permissionMode: "yolo" })
      yield* insertSession({ id: "ses_kid", parentID: "ses_root" })
      const service = yield* PermissionV2.Service
      // yolo's own overlay ALLOWS the external classes — the documented "outside the project too".
      expect(yield* service.ask(outside({ sessionID: SessionV2.ID.make("ses_root") }))).toMatchObject({
        effect: "allow",
      })
      expect(yield* service.ask(outside({ sessionID: SessionV2.ID.make("ses_kid") }))).toMatchObject({
        effect: "allow",
      })
    }),
  )

  it.effect("an agent-level deny still wins, and keeps the generic (untagged) wording", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "deny" }])
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      const error = yield* service
        .assert(assertion({ sessionID: SessionV2.ID.make("ses_cron"), action: "write", resources: ["src/x.ts"] }))
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(PermissionV2.DeniedError)
      expect((error as PermissionV2.DeniedError).reason).toBeUndefined()
    }),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// AN ASK NOBODY CAN ANSWER IS A HANG, NOT A GATE — the consequence v0.2.0 B4c opened, closed.
//
// B4c replaced the agent baseline's catch-all `{*,*,allow}` with `AMBIENT_SAFE_BASELINE`, so every
// action nobody named — `spawn`, `skill`, `kb`, `revert`,
// `provision`, `define_tool`, `register-app`, `messenger.*`, every MCP tool and every ad-hoc tool a
// model invents at runtime — now reaches `evaluate`'s `ask` default. Attended, that is the point.
// UNATTENDED, an ask parks on a card nobody will ever answer, and `pending` is an in-memory
// location-scoped Map, so it does not even survive a restart: the run looks alive and does nothing.
//
// The stance's own doctrine rules on it, so `evaluateInput`'s LAST arm refuses immediately instead,
// with its own reason. These tests measure it against the REAL post-B4c baseline — read from the
// shipped constant, never copied — because the whole behaviour only exists as a consequence of that
// list being short.
// ─────────────────────────────────────────────────────────────────────────────
describe("PermissionV2 — an unattended ask denies FAST", () => {
  // The shipped floor plus the one external ask `plugin/agent.ts` adds. Driven from the constant so
  // that promoting an action INTO the baseline moves these tests with it instead of stranding them.
  const b4cBaseline: PermissionV2.Ruleset = [
    ...PermissionV2.AMBIENT_SAFE_BASELINE,
    { action: "external_directory_write", resource: "*", effect: "ask" },
  ]

  /**
   * The subject: an action named by NO compiled rule, so the honest verdict is `ask`.
   *
   * ⚠️ **Chosen by evidence, not from memory — and that is the repair for how this block went red.**
   * It hardcoded `webfetch`, which stopped being a fall-through the moment `AMBIENT_SAFE_BASELINE`
   * gained it (app `26eadde21`, owner directive 2026-08-04: "models may read public URLs without
   * stopping for a consent card"). Five tests then failed against a premise nobody had re-checked —
   * *while the header above claimed the block was "driven from the constant so that promoting an
   * action INTO the baseline moves these tests with it"*. It was, for the RULESET; the SUBJECT was
   * still a literal. Both come from the shipped constants now, so the next promotion moves this
   * block instead of stranding it.
   */
  const namedByBaseline = new Set(PermissionV2.AMBIENT_SAFE_BASELINE.map((rule) => rule.action))
  // ANY mode rule disqualifies a candidate, allow or deny alike: a mode that DENIES it would resolve
  // before the fall-through arm just as surely as one that grants it.
  const namedByMode = new Set(Object.values(MODE_RULES).flatMap((rules) => rules.map((rule) => rule.action)))
  const FALL_THROUGH =
    ["spawn", "skill", "kb", "define_tool", "websearch"].find(
      (action) => !namedByBaseline.has(action) && !namedByMode.has(action),
    ) ?? "spawn"
  const FALL_THROUGH_RESOURCE = "research-subagent"

  const gated = (input: Partial<PermissionV2.AssertInput> = {}) =>
    assertion({ action: FALL_THROUGH, resources: [FALL_THROUGH_RESOURCE], save: ["*"], ...input })

  test("the subject of this block really does fall through — otherwise every test below is vacuous", () => {
    // The guard that would have turned five confusing assertion failures into one sentence naming
    // the cause. If every candidate is granted, this block is measuring a granted action and each
    // `expect ask` below becomes a statement about the fixture rather than about the arm.
    expect(
      { action: FALL_THROUGH, byBaseline: namedByBaseline.has(FALL_THROUGH), byMode: namedByMode.has(FALL_THROUGH) },
      "no candidate action falls through any more — pick one that does, or this whole describe is vacuous",
    ).toEqual({ action: FALL_THROUGH, byBaseline: false, byMode: false })
  })

  /**
   * The verdict, then the reason — and the ORDER is load-bearing, not style.
   *
   * `ask` exposes the resolved verdict while `assert` lowers a denial into the error tools display.
   * Check both so this block covers the inspection and enforcement surfaces together.
   */
  const denialFor = (service: PermissionV2.Interface, input: PermissionV2.AssertInput) =>
    Effect.gen(function* () {
      expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
      const error = yield* service.assert(input).pipe(Effect.flip)
      expect(error).toBeInstanceOf(PermissionV2.DeniedError)
      return error as PermissionV2.DeniedError
    })

  // ⚠️ THE OTHER SIDE OF THE SAME ARM, and it is the half a reader assumes rather than checks.
  // `bash` is NOT a fall-through action: `MODE_RULES.bypass` — the SHIPPED default posture
  // (`EFFECTIVE_CONFIG_DEFAULTS.permissionMode`) — names it with an explicit `allow`, so it resolves
  // before the deny-fast arm above ever sees it. That is what makes the owner's 2026-07-30 directive
  // ("unattended bash should be allowed by default") true at the PERMISSION layer, and it means the
  // refusal a user actually hit before that directive came from the JAIL, not from here.
  //
  // Without this test the directive's permission half is an argument about rule ordering. With it, a
  // future change that promotes `bash` out of `MODE_RULES.bypass`, or that widens the deny-fast arm
  // to cover explicit allows, fails HERE instead of silently re-refusing every scheduled run.
  it.effect("`bash` is ALLOWED for an unattended root under the DEFAULT mode (owner 2026-07-30)", () =>
    Effect.gen(function* () {
      yield* setup(b4cBaseline)
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      const input = assertion({
        sessionID: SessionV2.ID.make("ses_cron"),
        action: "bash",
        resources: ["pwd"],
        save: ["pwd"],
      })
      expect(yield* service.ask(input)).toMatchObject({ effect: "allow" })
      // `assert` is the path every tool takes: it must return, not park and not fail.
      yield* service.assert(input)
    }),
  )

  it.effect("a fall-through action is DENIED with a named reason for an unattended root — nothing parked", () =>
    Effect.gen(function* () {
      yield* setup(b4cBaseline)
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      const error = yield* denialFor(service, gated({ sessionID: SessionV2.ID.make("ses_cron") }))
      expect(error.reason).toBe("unattended-unanswerable")

      // What the model actually reads. It must NAME the action (an empty ruleset would make this
      // "unknown" — the false description ruling 2 forbids), say the waiting is pointless, and say
      // what a grant would take. It must NOT tell an unattended run to ask a user.
      const message = PermissionV2.denialMessage(error)!
      expect(message).toContain(FALL_THROUGH)
      expect(message).toContain(FALL_THROUGH_RESOURCE) // WHICH resource, not just which verb
      expect(message).toContain("UNATTENDED")
      expect(message).toContain("will change nothing")
      expect(message).toContain(PermissionV2.GRANT_IN_ADVANCE.sentence)
      expect(message).not.toContain("ask the user")
      // The failure mode the synthetic rules exist to prevent: with an EMPTY ruleset —
      // and a fall-through action has no compiled rule by definition — `denialMessage`
      // reports both the action and the resource as "unknown".
      expect(message).not.toContain("unknown")
    }),
  )

  it.effect("NEGATIVE CONTROL: the identical request on an INTERACTIVE root still ASKS", () =>
    Effect.gen(function* () {
      // Without this the deny above could be coming from the baseline, from the mode, or from a
      // guard that refuses the action outright. The ONLY difference here is the root's type.
      yield* setup(b4cBaseline)
      yield* insertSession({ id: "ses_chat", type: "interactive", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      // ⚠️ Both roots DENY since asking was removed (owner 2026-08-20), so `effect` can no longer
      // separate them — the REASON does, and that is the stricter check: it fails if the attended and
      // unattended paths are ever collapsed into one verdict.
      expect(yield* service.ask(gated({ sessionID: SessionV2.ID.make("ses_chat") }))).toMatchObject({
        effect: "deny",
      })
      const attended = yield* service.assert(gated({ sessionID: SessionV2.ID.make("ses_chat") })).pipe(Effect.flip)
      expect((attended as PermissionV2.DeniedError).reason).toBe("ask-removed")
    }),
  )

  it.effect("the ad-hoc tool name no overlay can mention is refused the same way", () =>
    Effect.gen(function* () {
      // The shape that made growing `MODE_RULES` impossible: `tool/define-tool.ts` asserts under a
      // name the MODEL chose at runtime. It is exactly the case this arm has to cover, because no
      // rule written in advance can ever name it.
      yield* setup(b4cBaseline)
      yield* insertSession({ id: "ses_cron", type: "auto-prompting", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      const error = yield* denialFor(
        service,
        gated({ sessionID: SessionV2.ID.make("ses_cron"), action: "my_deploy_tool", resources: ["anything"] }),
      )
      expect(error.reason).toBe("unattended-unanswerable")
      expect(PermissionV2.denialMessage(error)!).toContain("my_deploy_tool")
    }),
  )

  it.effect("an UNREADABLE chain gets the honestly-attributed twin, not the unattended claim", () =>
    Effect.gen(function* () {
      // Ruling 2 in both directions: we did not establish that this run is unattended, we failed to
      // read the chain that would have said. Telling the model "this is an UNATTENDED session" would
      // be a claim about something we never checked, and it points the operator at the schedule
      // instead of at the broken session records.
      yield* setup(b4cBaseline)
      yield* insertSession({ id: "ses_orphan", type: "sub-agent", permissionMode: "bypass", parentID: "ses_ghost" })
      const service = yield* PermissionV2.Service
      const error = yield* denialFor(service, gated({ sessionID: SessionV2.ID.make("ses_orphan") }))
      expect(error.reason).toBe("unanswerable-chain-unreadable")

      const message = PermissionV2.denialMessage(error)!
      expect(message).toContain(FALL_THROUGH)
      expect(message).toContain("parent chain could not be read")
      expect(message).toContain("no user reply can unblock it")
      expect(message).not.toContain("this is an UNATTENDED session")
      expect(message).not.toContain("ask the user")
      // ...and it does NOT borrow the confinement pair's advice, which is about a path this action
      // does not have. That wording is why these are separate reasons rather than a reuse.
      expect(message).not.toContain("inside this session's folder")
    }),
  )

  it.effect("NEGATIVE CONTROL: give the orphan its parent back and the reason becomes the unattended one", () =>
    Effect.gen(function* () {
      // Same row, same request — the only difference is that the root now exists and says
      // `goal-oriented`. Without this the twin above could be any deny with a different label.
      yield* setup(b4cBaseline)
      yield* insertSession({ id: "ses_ghost", type: "goal-oriented", permissionMode: "bypass" })
      yield* insertSession({ id: "ses_orphan", type: "sub-agent", permissionMode: "bypass", parentID: "ses_ghost" })
      const service = yield* PermissionV2.Service
      const error = yield* denialFor(service, gated({ sessionID: SessionV2.ID.make("ses_orphan") }))
      expect(error.reason).toBe("unattended-unanswerable")
    }),
  )

  it.effect("a saved allow-always DOES unblock it — the Developer-mode repair path, not a chat answer", () =>
    Effect.gen(function* () {
      // The denial tells the model a grant written into the agent/instance rules in advance is what
      // would change things — never an answer given in the chat, since `PermissionSaved.add` has no
      // production caller. That has to be TRUE, or the refusal is a dead end wearing advice. This
      // arm sits AFTER saved answers
      // deliberately — unlike the confinement stance, which is a hard arm a saved grant cannot buy
      // out of, because this one converts a fall-through rather than a classified boundary.
      yield* setup(b4cBaseline)
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ origin: Project.ID.global, action: FALL_THROUGH, resources: ["*"] })
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(gated({ sessionID: SessionV2.ID.make("ses_cron") }))).toMatchObject({
        effect: "allow",
      })
    }),
  )

  it.effect("an agent-level allow DOES unblock it — the second path the denial text names", () =>
    Effect.gen(function* () {
      yield* setup([...b4cBaseline, { action: FALL_THROUGH, resource: "*", effect: "allow" }])
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(gated({ sessionID: SessionV2.ID.make("ses_cron") }))).toMatchObject({
        effect: "allow",
      })
    }),
  )

  it.effect("it converts a VERDICT, never a grant: an unattended run's permitted work is untouched", () =>
    Effect.gen(function* () {
      // The blast-radius assertion. Everything an unattended `bypass` root could already do it can
      // still do — the ambient-safe floor, and the mutation/exec cluster the mode grants. If this
      // goes red the arm has become a blanket deny, which is a different (and much worse) change.
      yield* setup(b4cBaseline)
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      const sessionID = SessionV2.ID.make("ses_cron")
      for (const rule of PermissionV2.AMBIENT_SAFE_BASELINE)
        expect({
          action: rule.action,
          ...(yield* service.ask(assertion({ sessionID, action: rule.action, resources: ["src/a.ts"] }))),
        }).toMatchObject({ action: rule.action, effect: "allow" })
      for (const action of ["edit", "write", "create", "trash", "bash"])
        expect({
          action,
          ...(yield* service.ask(assertion({ sessionID, action, resources: ["src/a.ts"] }))),
        }).toMatchObject({ action, effect: "allow" })
      // Reading outside the folder stays ordinary work unattended (the owner's 2026-07-25 call), so
      // the read baseline's allow must not be reachable by this arm either.
      expect(
        yield* service.ask(
          assertion({ sessionID, action: "external_directory_read", resources: ["C:/soft/w64devkit/*"] }),
        ),
      ).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("`yolo` is NOT an exit from this arm — a mode cannot conjure an operator", () =>
    Effect.gen(function* () {
      // Recorded as a decision, not discovered later. `unattendedStanceRules` and the attachment arm
      // both let `yolo` out, because both convert a GRANT into a refusal. This arm converts nothing:
      // reaching it means the action was never granted in ANY mode — `MODE_RULES.yolo` names only the
      // mutation cluster and external writes — so an unattended `yolo` root calling a
      // fall-through action was hanging exactly like a `bypass` one. Exempting yolo preserves it.
      yield* setup(b4cBaseline)
      yield* insertSession({ id: "ses_yolo", type: "goal-oriented", permissionMode: "yolo" })
      const service = yield* PermissionV2.Service
      const sessionID = SessionV2.ID.make("ses_yolo")
      const error = yield* denialFor(service, gated({ sessionID }))
      expect(error.reason).toBe("unattended-unanswerable")
      // ...while everything yolo DOES grant is still granted — this is not yolo being narrowed.
      for (const action of ["external_directory_read", "external_directory_write"])
        expect(
          yield* service.ask(assertion({ sessionID, action, resources: ["C:/elsewhere/*"], save: ["*"] })),
        ).toMatchObject({ effect: "allow" })
    }),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// U1 — the other half of the askBeforeChanges shell promise, and it has to be read off the SOURCE.
//
// The switch's overlay delivers "…and before it runs a shell command" with ONE row: `bash → ask`.
// That row is a promise about EXECUTION, so it is only as true as the set of tools that spell their
// execution `bash`. `tool/quality-provision.ts` did not: it asserted `provision` on `key: command`
// strings and then ran every candidate — including ones the MODEL supplied via `input.commands`,
// which WIN over the manifest scan — through the agent shell with a 90 s timeout. So provisioning
// executed shell without ever asking, while the UI said it would not.
//
// Reaching that assert through the service would mean building the tool's whole location graph and
// then actually spawning the candidate commands on this host — the exact thing the assert exists to
// gate. A source guard is the honest instrument here, and it is the one that goes red if the assert
// is deleted.
// ─────────────────────────────────────────────────────────────────────────────
describe("quality_provision asserts the action it actually performs", () => {
  const TOOL = nodePath.join(import.meta.dir, "..", "src", "tool", "quality-provision.ts")
  // CODE ONLY. That file now explains this rule at length, and a guard that read prose would be
  // satisfied by the very explanation of the bug it exists to catch.
  const source = stripComments(fs.readFileSync(TOOL, "utf8"))

  /** It starts a host process with a candidate command… */
  const SPAWNS = /ChildProcess\.make\(command\b/
  /** …so it must assert `bash` on the command string it is about to run… */
  const ASSERTS_BASH = /action:\s*"bash",\s*resources:\s*\[command\]/
  /** …and keep asserting `provision`, which gates the durable settings write it also performs. */
  const ASSERTS_PROVISION = /action:\s*"provision"/

  test("it still runs candidate commands on the host — the guard has something to guard", () => {
    expect(source).toMatch(SPAWNS)
  })

  test("the command it runs is gated by a `bash` assert on that same command", () => {
    expect(source).toMatch(ASSERTS_BASH)
    // Same resource/save shape as tool/bash.ts, so one saved "always allow" answer means the same
    // thing whichever tool runs the command.
    expect(source).toMatch(/save:\s*\[command\]/)
  })

  test("the `provision` assert STAYS — it gates the settings write, not the execution", () => {
    expect(source).toMatch(ASSERTS_PROVISION)
    expect(source).toMatch(/settings\.set\("quality"/)
  })

  test("NEGATIVE CONTROL: the file as it shipped passes the old checks and fails the new one", () => {
    const preFix = `
      yield* permission.assert({ action: "provision", resources: candidates.map(f), save: ["*"] })
      const run = yield* appProcess.run(ChildProcess.make(command, [], { cwd: directory, shell }))
    `
    expect(preFix).toMatch(SPAWNS)
    expect(preFix).toMatch(ASSERTS_PROVISION)
    expect(preFix).not.toMatch(ASSERTS_BASH) // ← the hole, exactly as it shipped
    // …and stripping comments is what makes the guard bite: talking about the assert is not one.
    expect(stripComments(`// one day: action: "bash", resources: [command]\n`)).not.toMatch(ASSERTS_BASH)
  })
})
