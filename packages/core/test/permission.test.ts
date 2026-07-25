import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { TRUNCATION_RESOURCE } from "@novaclaw/core/tool/truncation-dir"
import { PermissionTable } from "@novaclaw/core/permission/sql"
import { PermissionSaved } from "@novaclaw/core/permission/saved"
import { Project } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionTable } from "@novaclaw/core/session/sql"
import { Global } from "@novaclaw/core/global"
import { SessionStore } from "@novaclaw/core/session/store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SessionRecordEvent } from "@novaclaw/schema/session-record-event"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

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

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

/** Insert an extra session row so a test can exercise the CHAIN (type + mode live on the row). */
function insertSession(input: {
  readonly id: string
  readonly type?: "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"
  readonly permissionMode?: "plan" | "ask" | "surgical" | "bypass" | "yolo"
  readonly parentID?: string
}) {
  return Effect.gen(function* () {
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

function waitForRequest() {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion()).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
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
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
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
      expect(yield* service.list()).toEqual([])
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

  it.effect("uses build permissions when the Session agent is omitted", () =>
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
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
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
      expect(yield* service.list()).toEqual([])
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
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
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
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  // A deleted session must take its pending asks with it: the V2 session-scoped reply route can
  // never settle them once the session row is gone, so without the sweep they orphan forever.
  it.effect("rejects a deleted session's pending asks and publishes Replied", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])

      const events = yield* EventV2.Service
      const replied = yield* Deferred.make<{ requestID: string; reply: string }>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Replied.type
          ? Deferred.succeed(replied, event.data as { requestID: string; reply: string }).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* events.publish(SessionRecordEvent.Deleted, {
        sessionID: request.sessionID,
        info: {
          id: request.sessionID,
          slug: "test",
          location: { directory: AbsolutePath.make("/project") },
          title: "test",
          version: "test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
        },
      } as never)

      expect(yield* Deferred.await(replied)).toMatchObject({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  // A SETTLED DRAIN takes its pending asks with it too (owner-hit 2026-07-22): once the drain
  // publishes idle/exited (Stop, exit, error) the tool awaiting the answer is gone, and a stale
  // ask wedged the chat — the ask dock replaces the composer, leaving no Stop and no way to
  // re-prompt.
  it.effect("rejects a settled drain's pending asks on the idle status", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])

      const events = yield* EventV2.Service
      const replied = yield* Deferred.make<{ requestID: string; reply: string }>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Replied.type
          ? Deferred.succeed(replied, event.data as { requestID: string; reply: string }).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: request.sessionID,
        status: { type: "idle" },
      })

      expect(yield* Deferred.await(replied)).toMatchObject({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.origin, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([
        { id, origin: Project.ID.global, action: "read", resource: "src/*", effect: "allow" },
      ])
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
      for (const action of ["write", "edit", "create", "bash"])
        expect(yield* service.ask(assertion({ sessionID, action, resources: ["src/a.ts"] }))).toMatchObject({
          effect: "allow",
        })
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
      // A distinct id per action: an `ask` verdict QUEUES a pending permission, so reusing one id collides.
      for (const action of ["edit", "write", "create", "trash", "bash"])
        expect(
          yield* service.ask(
            assertion({ id: PermissionV2.ID.create(`per_${action}`), sessionID, action, resources: ["src/a.ts"] }),
          ),
        ).toMatchObject({ effect: "ask" })
      // ...but a READ is not a change, so it still goes through untouched.
      expect(yield* service.ask(assertion({ sessionID, action: "read", resources: ["src/a.ts"] }))).toMatchObject({
        effect: "allow",
      })
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
})

describe("PermissionV2 — unattended confinement stance", () => {
  // The real build agent's baseline (plugin/agent.ts): allow-all in-project, external WRITE asks. There is
  // deliberately no blanket external_directory_read rule here — that default is decided live by the
  // evaluator from the `paranoid` setting, precisely so a rule like the write one below can still override
  // it per path.
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
      // `ask` reports the verdict without queueing anything...
      expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
      expect(yield* service.list()).toEqual([])

      // ...and `assert` — the path every mutating tool takes — fails immediately instead of parking.
      const error = yield* service.assert(input).pipe(Effect.flip)
      expect(error).toBeInstanceOf(PermissionV2.DeniedError)
      expect((error as PermissionV2.DeniedError).reason).toBe("unattended-confined")
      expect(yield* service.list()).toEqual([]) // nothing waiting for a human who will never come

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
      expect(yield* service.ask(outside({ sessionID: SessionV2.ID.make("ses_chat") }))).toMatchObject({
        effect: "ask",
      })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  // Owner call (2026-07-25): READING outside the folder is ordinary work — a toolchain, an SDK, a system
  // header (C:\soft\w64devkit to build an app). The fear these rules answer is a destructive WRITE, so an
  // out-of-folder read is ALLOWED by default even unattended, and confined only under Paranoid.
  it.effect("the out-of-folder READ class is ALLOWED by default, even unattended", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_cron", type: "auto-prompting", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      expect(
        yield* service.ask(outside({ sessionID: SessionV2.ID.make("ses_cron"), action: "external_directory_read" })),
      ).toMatchObject({ effect: "allow" })
      // ...while the WRITE class stays denied outright in the very same session.
      expect(yield* service.ask(outside({ sessionID: SessionV2.ID.make("ses_cron") }))).toMatchObject({
        effect: "deny",
      })
    }),
  )

  it.effect("PARANOID confines the read class: denied unattended, and it takes effect LIVE", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_cron", type: "auto-prompting", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      const read = () =>
        service.ask(outside({ sessionID: SessionV2.ID.make("ses_cron"), action: "external_directory_read" }))
      expect(yield* read()).toMatchObject({ effect: "allow" })
      // Flip the setting with the service ALREADY built — the evaluator reads the live store, so no restart.
      yield* (yield* SettingsConfigStore.Service).set("paranoid", true)
      expect(yield* read()).toMatchObject({ effect: "deny" })
    }),
  )

  // The subtle half of Paranoid: it must beat the agent's catch-all `* → allow`, but a rule written for a
  // SPECIFIC path is itself the explicit permission Paranoid demands, so it must still win. Otherwise a user
  // who whitelisted their toolchain would be re-asked forever.
  it.effect("PARANOID yields to a rule written for a specific path", () =>
    Effect.gen(function* () {
      yield* setup([
        ...buildAgentRules,
        { action: "external_directory_read", resource: "C:/soft/w64devkit/*", effect: "allow" },
      ])
      yield* insertSession({ id: "ses_chat", type: "interactive", permissionMode: "bypass" })
      yield* (yield* SettingsConfigStore.Service).set("paranoid", true)
      const service = yield* PermissionV2.Service
      const ask = (resource: string) =>
        service.ask(
          assertion({
            sessionID: SessionV2.ID.make("ses_chat"),
            action: "external_directory_read",
            resources: [resource],
            save: [resource],
          }),
        )
      // The whitelisted toolchain is read without a prompt...
      expect(yield* ask("C:/soft/w64devkit/*")).toMatchObject({ effect: "allow" })
      // ...while anything else outside the folder still asks.
      expect(yield* ask("C:/elsewhere/*")).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("PARANOID attended ASKS rather than denying — a human is there to answer", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_chat", type: "interactive", permissionMode: "bypass" })
      yield* (yield* SettingsConfigStore.Service).set("paranoid", true)
      const service = yield* PermissionV2.Service
      expect(
        yield* service.ask(outside({ sessionID: SessionV2.ID.make("ses_chat"), action: "external_directory_read" })),
      ).toMatchObject({ effect: "ask" })
    }),
  )

  // The managed tool-output store is the ONE exemption. A tool whose output is oversized spills to
  // `<data>/tool-output/` and the model is told to read it back; that store is outside every Location, so
  // without the exemption the blanket external-read deny cut an unattended agent off from its OWN output.
  it.effect("an unattended session may still read its own spilled tool output", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      // Assert under PARANOID — the only posture where this exemption is load-bearing.
      yield* (yield* SettingsConfigStore.Service).set("paranoid", true)
      const service = yield* PermissionV2.Service
      expect(
        yield* service.ask(
          assertion({
            sessionID: SessionV2.ID.make("ses_cron"),
            action: "external_directory_read",
            resources: [TRUNCATION_RESOURCE],
            save: [TRUNCATION_RESOURCE],
          }),
        ),
      ).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("the exemption is narrow — another external read, and writing the store, stay denied", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      const deny = (action: string, resource: string) =>
        service.ask(
          assertion({
            sessionID: SessionV2.ID.make("ses_cron"),
            action,
            resources: [resource],
            save: [resource],
          }),
        )
      // Under Paranoid the read class is confined — the exemption must not stretch to cover anything else.
      yield* (yield* SettingsConfigStore.Service).set("paranoid", true)
      expect(yield* deny("external_directory_read", "C:/elsewhere/*")).toMatchObject({ effect: "deny" })
      // The store is readable, never writable.
      expect(yield* deny("external_directory_write", TRUNCATION_RESOURCE)).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("IN-folder work is untouched: the session still creates/edits/reads inside its own folder", () =>
    Effect.gen(function* () {
      yield* setup(buildAgentRules)
      yield* insertSession({ id: "ses_cron", type: "goal-oriented", permissionMode: "bypass" })
      const service = yield* PermissionV2.Service
      const session = SessionV2.ID.make("ses_cron")
      for (const action of ["create", "write", "edit", "read", "trash"])
        expect(yield* service.ask(assertion({ sessionID: session, action, resources: ["out/report.md"] }))).toMatchObject(
          { effect: "allow" },
        )
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
      expect(yield* service.list()).toEqual([])
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
