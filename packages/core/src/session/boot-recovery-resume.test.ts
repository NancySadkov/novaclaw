import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { AgentConfigStore } from "../agent-config-store"
import { AgentConfigTable } from "../agent-config/sql"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionBootRecovery } from "./boot-recovery"
import { SessionRecoveryDecision } from "./recovery-decision"
import type { SessionExecutionAttempt } from "./execution-attempt"
import { SessionMessage } from "./message"
import { SessionRead } from "./read"
import { SessionSchema } from "./schema"
import { SessionExecutionTable, SessionTable } from "./sql"
import type { SessionStore } from "./store"
import { Steering } from "./steering"
import { testEffect } from "../../test/lib/effect"

// Owner, 2026-08-29: *"why are crashed runs lost forever and can't be recovered / restored?"*
//
// 🔴 The answer was that `recoverStale` computed a recovery decision for every abandoned execution
// and nothing acted on it. These tests pin the acting — and above all pin WHICH runs are resumed,
// including delegated workers. An unknown tool outcome is resumed through an inspection steer rather
// than replayed.
//
// 🔴 2026-09-29, the owner's own instance: `ses_xenia` reached `generation: 65` with two
// `session_input` rows in her entire life and spoke four minutes after a launch that asked for
// nothing. She is a pure Chat entity, and boot recovery was resuming her exactly as it resumes an
// officer's unfinished work. The fix routes both boot arms through `Steering.resume` — the same seam
// that refuses to STEER a chat session, because a session that may not be steered may not be resumed
// either.
//
// ⚠️ `session.short_chat` is NULL on the live `ses_xenia` row, so a gate written against that column
// would have passed straight through this bug. `kind` and `operationMode` are the authority, and these
// tests use a real database precisely so the column that lies cannot be the one under test.

const id = (name: string) => name as SessionSchema.ID

const dbIt = testEffect(Database.layerFromPath(":memory:"))

const entry = (name: string, decision: SessionRecoveryDecision.Decision): SessionExecutionAttempt.Recovered => ({
  sessionID: id(name),
  decision,
})

const SAFE = SessionRecoveryDecision.decide({ phase: "provider", checkpointed: false, failureCount: 1 })

/**
 * A session row for `agent`, with the parent that makes a worker a worker.
 *
 * ⚠️ `session.agent` carries a UNIQUE index, so two ROOT sessions cannot share one officer. A worker
 * carries no agent of its own — its owner is its parent — which is also how the product models it, and
 * is what makes the config walk reach the officer's `operationMode` at all.
 */
const root = (name: string, agent: string) => ({
  id: id(name),
  slug: name,
  directory: process.cwd(),
  title: name,
  version: "test",
  agent,
  time_created: 1,
  time_updated: 1,
})

const worker = (name: string, parentID: string) => ({
  id: id(name),
  parent_id: id(parentID),
  slug: name,
  directory: process.cwd(),
  title: name,
  version: "test",
  time_created: 1,
  time_updated: 1,
})

/** Write the agent config the mode is read from: `kind` and `operationMode`, as the product stores them. */
const putAgent = (db: Database.Interface["db"], name: string, fields: Record<string, unknown>) =>
  db
    .insert(AgentConfigTable)
    .values({ name, layers: [fields] as never })
    .onConflictDoUpdate({ target: AgentConfigTable.name, set: { layers: [fields] as never } })
    .pipe(Effect.orDie)

describe("Steering.resume — who may be started with nobody asking", () => {
  // 🔴 THE MEASURED CASE. A pure Chat entity with an abandoned attempt must stay down.
  dbIt.effect("refuses a chat conversation", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values(root("ses_chat", "xenia"))
      yield* putAgent(db, "xenia", { kind: "chat" })
      const authority = yield* Steering.resume(db, id("ses_chat"), { reason: "boot-recovery" })
      expect(authority).toEqual({ allowed: false, reason: "chat" })
    }))

  dbIt.effect("refuses the owner", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values(root("ses_owner", AgentV2.OWNER_ID))
      const authority = yield* Steering.resume(db, id("ses_owner"), { reason: "boot-recovery" })
      expect(authority.allowed).toBe(false)
    }))

  dbIt.effect("🔴 an UNATTENDED officer IS resumed — the gate must not strand real work", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values(root("ses_officer", "nova"))
      yield* putAgent(db, "nova", { kind: "agent", operationMode: "unattended" })
      const authority = yield* Steering.resume(db, id("ses_officer"), { reason: "boot-recovery" })
      expect(authority).toEqual({ allowed: true })
    }))

  dbIt.effect("an officer with no explicit mode keeps the autonomous default", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values(root("ses_default", "myron"))
      yield* putAgent(db, "myron", { kind: "agent" })
      expect((yield* Steering.resume(db, id("ses_default"))).allowed).toBe(true)
    }))

  dbIt.effect("refuses an INTERACTIVE officer", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values(root("ses_interactive", "ariadne"))
      yield* putAgent(db, "ariadne", { kind: "agent", operationMode: "interactive" })
      expect((yield* Steering.resume(db, id("ses_interactive"))).reason).toBe("interactive")
    }))

  dbIt.effect("🔴 a WORKER inherits its officer's answer, both ways", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values([
        root("ses_root_u", "nova"),
        worker("ses_worker_u", "ses_root_u"),
        root("ses_root_i", "ariadne"),
        worker("ses_worker_i", "ses_root_i"),
      ])
      yield* putAgent(db, "nova", { kind: "agent", operationMode: "unattended" })
      yield* putAgent(db, "ariadne", { kind: "agent", operationMode: "interactive" })
      // An unattended officer's worker comes back with it.
      expect((yield* Steering.resume(db, id("ses_worker_u"))).allowed).toBe(true)
      // An interactive officer's worker stays down when no turn was already admitted.
      expect((yield* Steering.resume(db, id("ses_worker_i"))).reason).toBe("interactive")
      expect((yield* Steering.resume(db, id("ses_worker_i"), { hasWork: true })).allowed).toBe(true)
    }))
})

describe("adoptRecovered asks the seam before it adopts anyone", () => {
  const run = (db: Database.Interface["db"], recovered: readonly SessionExecutionAttempt.Recovered[]) => {
    const woken: string[] = []
    return SessionBootRecovery.adoptRecovered({
      db,
      recovered,
      adopt: (sessionID) => Effect.sync(() => void woken.push(sessionID)),
    }).pipe(Effect.map((count) => ({ woken, count })))
  }

  // ⭐ THE MEASURED CASE: three unattended sessions interrupted by a server hang.
  dbIt.effect("wakes every run the policy judged recoverable, when the seam allows it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values([
        root("ses_a", "nova"),
        root("ses_b", "sopitis"),
        root("ses_c", "myron"),
      ])
      yield* putAgent(db, "nova", { kind: "agent", operationMode: "unattended" })
      yield* putAgent(db, "sopitis", { kind: "agent", operationMode: "unattended" })
      yield* putAgent(db, "myron", { kind: "agent", operationMode: "unattended" })
      const { woken, count } = yield* run(db, [entry("ses_a", SAFE), entry("ses_b", SAFE), entry("ses_c", SAFE)])
      expect(woken).toEqual(["ses_a", "ses_b", "ses_c"])
      expect(count).toBe(3)
    }))

  // 🔴 The regression, end to end: a chat conversation in the recovered set is NOT adopted.
  dbIt.effect("🔴 does NOT wake a chat conversation that was in the recovered set", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values([
        root("ses_xenia", "xenia"),
        root("ses_officer", "nova"),
      ])
      yield* putAgent(db, "xenia", { kind: "chat" })
      yield* putAgent(db, "nova", { kind: "agent", operationMode: "unattended" })
      const { woken, count } = yield* run(db, [entry("ses_xenia", SAFE), entry("ses_officer", SAFE)])
      // The officer comes back; Xenia does not. This is the whole fix.
      expect(woken).toEqual(["ses_officer"])
      expect(count).toBe(1)
    }))

  dbIt.effect("does not adopt anything when every candidate is ineligible", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values(root("ses_xenia", "xenia"))
      yield* putAgent(db, "xenia", { kind: "chat" })
      const { woken, count } = yield* run(db, [entry("ses_xenia", SAFE)])
      expect(woken).toEqual([])
      expect(count).toBe(0)
    }))

  dbIt.effect("resumes an interactive officer and its worker after a process dies mid-turn", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values([
        root("ses_interactive", "sopitis"),
        worker("ses_interactive_worker", "ses_interactive"),
      ])
      yield* putAgent(db, "sopitis", { kind: "agent", operationMode: "interactive" })
      const { woken, count } = yield* run(db, [entry("ses_interactive", SAFE), entry("ses_interactive_worker", SAFE)])
      expect(woken).toEqual(["ses_interactive", "ses_interactive_worker"])
      expect(count).toBe(2)
    }))

  dbIt.effect("one failed recovery does not strand the remaining runs", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values([root("ses_bad", "nova"), root("ses_ok", "sopitis")])
      yield* putAgent(db, "nova", { kind: "agent", operationMode: "unattended" })
      yield* putAgent(db, "sopitis", { kind: "agent", operationMode: "unattended" })
      const resumed: string[] = []
      const count = yield* SessionBootRecovery.adoptRecovered({
        db,
        recovered: [entry("ses_bad", SAFE), entry("ses_ok", SAFE)],
        adopt: (sessionID) =>
          sessionID === id("ses_bad") ? Effect.fail("worker failed") : Effect.sync(() => void resumed.push(sessionID)),
      })
      expect(resumed).toEqual(["ses_ok"])
      // The return is how many the SEAM allowed, not how many adopted successfully: a refused
      // session must be visible in the count, and a failed adoption must not shrink it, or the
      // caller cannot tell "the gate said no" from "adoption broke".
      expect(count).toBe(2)
    }))

  dbIt.effect("hands every recovered run to detached adoption without imposing a completion order", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values([root("ses_a", "nova"), root("ses_b", "sopitis")])
      yield* putAgent(db, "sopitis", { kind: "agent", operationMode: "unattended" })
      const order: string[] = []
      yield* SessionBootRecovery.adoptRecovered({
        db,
        recovered: [entry("ses_a", SAFE), entry("ses_b", SAFE)],
        adopt: (sessionID) => Effect.sync(() => void order.push(`adopt:${sessionID}`)),
      })
      expect(order).toEqual(["adopt:ses_a", "adopt:ses_b"])
    }))
})

describe("abandoned work keeps its admission reason", () => {
  dbIt.effect("resumes interrupted interactive turns and provider recovery while leaving idle peers asleep", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(SessionTable).values([
        { ...root("ses_interrupted", "sopitis"), type: "interactive" },
        { ...root("ses_provider", "zelos"), type: "interactive" },
        { ...root("ses_idle", "ariadne"), type: "interactive" },
        { ...root("ses_stopped", "geryon"), type: "interactive" },
      ])
      for (const name of ["sopitis", "zelos", "ariadne", "geryon"])
        yield* putAgent(db, name, { kind: "agent", operationMode: "interactive" })
      yield* db.insert(SessionExecutionTable).values([
        {
          session_id: id("ses_interrupted"), attempt_id: "old-interrupted", generation: 1,
          owner_id: "old-host", state: "interrupted", phase: "tool", failure_class: "before-side-effect",
          failure_count: 1, heartbeat_at: 1, started_at: 1, time_updated: 1,
        },
        {
          session_id: id("ses_provider"), attempt_id: "old-provider", generation: 1,
          owner_id: "old-host", state: "settled", phase: "provider", failure_count: 0,
          heartbeat_at: 1, started_at: 1, time_updated: 1,
          provider_recovery: {
            attemptID: EventV2.ID.create(), assistantMessageID: SessionMessage.ID.create(),
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
            startedAt: 1, toolProtocol: true,
          },
        },
        {
          session_id: id("ses_idle"), attempt_id: "old-idle", generation: 1,
          owner_id: "old-host", state: "settled", phase: "drain", failure_count: 0,
          heartbeat_at: 1, started_at: 1, time_updated: 1,
        },
        {
          session_id: id("ses_stopped"), attempt_id: "old-stopped", generation: 1,
          owner_id: "old-host", state: "interrupted", phase: "tool", failure_class: "interrupt",
          failure_count: 0, heartbeat_at: 1, started_at: 1, time_updated: 1,
        },
      ])
      const candidates = yield* SessionBootRecovery.abandonedSessions({ db })
      expect(Object.fromEntries(candidates.map(({ sessionID, hasWork }) => [sessionID, hasWork]))).toEqual({
        ses_interrupted: true, ses_provider: true, ses_idle: undefined,
      })
      const resumed: SessionSchema.ID[] = []
      const store = { get: (sessionID: SessionSchema.ID) => SessionRead.get(db, sessionID) } as SessionStore.Interface
      yield* SessionBootRecovery.wakeAbandonedInput({
        db, store, candidates, adopt: (sessionID) => Effect.sync(() => void resumed.push(sessionID)),
      })
      expect(new Set(resumed)).toEqual(new Set([id("ses_interrupted"), id("ses_provider")]))
    }))
})

describe("the pure rule holds without a database", () => {
  // Pinned separately so the policy cannot be quietly weakened by a change in how the mode resolves.
  test("a chat conversation is never resumable", () => {
    expect(Steering.mayResume({ mode: "chat", operationMode: undefined, hasWork: true })).toEqual({
      allowed: false,
      reason: "chat",
    })
  })

  test("an interactive officer finishes admitted work but cannot start an idle turn", () => {
    expect(Steering.mayResume({ mode: "agent", operationMode: "interactive", hasWork: true }).allowed).toBe(true)
    expect(Steering.mayResume({ mode: "agent", operationMode: "interactive" }).reason).toBe("interactive")
    expect(Steering.mayResume({ mode: "agent", operationMode: "unattended", hasWork: true }).allowed).toBe(true)
  })

  test("⚠️ `idle` outranks every policy reason, so the log cannot claim a decision never made", () => {
    expect(Steering.mayResume({ mode: "chat", operationMode: undefined, hasWork: false }).reason).toBe("idle")
  })

  test("an absent operationMode is the autonomous default, not a refusal", () => {
    // Absent means unattended by design; refusing here would strand every officer that never set it.
    expect(Steering.mayResume({ mode: "agent", operationMode: undefined, hasWork: true }).allowed).toBe(true)
  })
})
