import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Log } from "@novaclaw/schema/log"
import { AgentV2 } from "../agent"
import { AgentConfigStore } from "../agent-config-store"
import { AgentConfigTable } from "../agent-config/sql"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { agentOf, sessionConfigChain } from "./config-resolve"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { resolveSessionMode } from "./mode"
import { SessionRead } from "./read"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { applySteerProvenance } from "./steer-provenance"

/**
 * 🔴 ONE SEAM FOR EVERY HARNESS INTERJECTION. A CHAT LLM IS NEVER STEERED.
 *
 * **What was wrong, measured 2026-09-29.** Xenia — the shipped Companion, a *chat* LLM whose whole
 * purpose is to be a bare model to test, with every tool withdrawn and therefore no `exit` — was
 * activated 61 times with no user message before any of them. Her session's second and last input row
 * was a harness interjection, admitted and promoted:
 *
 *     delivery=steer   "[Automated NovaClaw check — not a message from your user.]
 *                       Recover and proceed."
 *     admitted_seq=99  promoted_seq=100
 *
 * Once started she cannot stop, and that is not bad luck. Chat mode withdraws every tool, so nothing
 * in her turn can end it: a steer aimed at a chat LLM is a loop with no exit.
 *
 * **The class, and why a module.** The primitive had 20 production call sites across the runner, and
 * the rule lived one delegation away in a function most callers reached only by accident. Policy that
 * sits BESIDE the primitive rather than INSIDE it is policy every future caller must remember, and
 * twenty call sites is twenty chances to forget. So the gate moves here, into the one function all of
 * them now go through, and it cannot be skipped by a caller that does not know the rule exists.
 *
 * **Why the reason is a closed union rather than a free string.** A reason nobody can enumerate
 * cannot be audited, and "what is allowed to wake this session?" is exactly an enumeration question.
 * Adding an interjection becomes a visible act, and `test/steering-seam.test.ts` holds the set.
 *
 * **Why it logs.** The only witness to Xenia's sixty-one activations was a `session_input` row nobody
 * was reading. The reason is now recorded at the seam, so the next one names itself in the log.
 */
export type Interjection =
  | "announced-tool-recovery"
  | "colleague"
  | "doom-loop"
  | "empty-turn"
  | "failure-streak"
  | "finish-audit"
  | "goal-drive"
  | "interjection"
  | "jail"
  | "nudge"
  | "provider-recovery"
  | "queued-work"
  | "quality"
  | "restart"
  | "stalled-peer"
  | "textual-call"
  | "truncation"
  | "unfinished-shell"
  | "unjoined-children"

export interface Injection {
  readonly sessionID: SessionSchema.ID
  readonly reason: Interjection
  readonly text: string
  /**
   * A caller-supplied id, for the interjections that must be idempotent — a project work item
   * re-queued on every poll, or a stall notice already asked about. Omitted, a fresh id is minted,
   * which is right for a one-shot recovery: "nudge once" is then the caller's concern, as it always
   * was.
   */
  readonly id?: SessionMessage.ID
}

type DatabaseService = Database.Interface["db"]

/**
 * 🔴 **THE SAME SEAM ALSO OWNS WHO MAY RESUME ON THEIR OWN.**
 *
 * `inject` above governs an interjection: text pushed into a session. It does not govern the other
 * half of the same question — *may this model be started at all, with nobody asking?* That half was
 * ungated, and it is how Xenia kept speaking.
 *
 * **Measured 2026-09-29, on the owner's own instance.** `ses_xenia` reached `generation: 65` with two
 * `session_input` rows in its entire life, both days old — and her last message landed four minutes
 * after an instance launch that requested nothing. Every launch, she spoke on her own. Her row's
 * `short_chat` is **NULL**, so a gate written against that column would have passed straight through
 * the bug; `resolveSessionMode` is the authority, exactly as it is for `inject`.
 *
 * The route in was boot recovery: `recoverStale` classifies an abandoned attempt and
 * `SessionRecoveryDecision.decide` returns `automatic: true` on every branch. `decide` is not wrong —
 * it answers *"is this turn safe to continue?"* and answers correctly. It was never asked whether
 * there **was** a turn to continue, so a Chat conversation with no goal was resumed exactly like an
 * officer's unfinished work, and the model invented an opening.
 *
 * ⚠️ **This is the same rule as `inject`, not a second rule.** A session that may not be steered must
 * not be resumed either: both mean "this model does not run unless a person starts it."
 */
export interface ResumeAuthority {
  readonly allowed: boolean
  /** Why it was withheld, for the log. Never absent when `allowed` is false. */
  readonly reason?: "chat" | "human" | "interactive" | "idle"
}

/**
 * The pure half of the rule, so it is assertable without a database and so the two gates cannot drift.
 *
 * ⚠️ `idle` is tested first on purpose: a session with nothing in flight is ineligible for the
 * uninteresting reason whatever its owner is, and reporting `chat` for it would make the log claim a
 * policy decision the code never made.
 *
 * ⚠️ Workers inherit their officer's answer rather than deciding for themselves. A spawned worker is
 * part of its parent's turn, so a worker may finish an interrupted turn even when its officer is
 * interactive. An idle interactive officer still waits for a person to start the next turn.
 */
export function mayResume(input: {
  readonly mode: "agent" | "chat" | "human"
  readonly operationMode: "interactive" | "unattended" | undefined
  /** True when a durable attempt was already running before the process stopped. */
  readonly hasWork?: boolean
}): ResumeAuthority {
  if (input.hasWork === false) return { allowed: false, reason: "idle" }
  if (input.mode !== "agent") return { allowed: false, reason: input.mode }
  if (input.operationMode === "interactive" && input.hasWork !== true)
    return { allowed: false, reason: "interactive" }
  return { allowed: true }
}

/**
 * May this session be resumed by boot recovery, a nudge, or another system wake? An already admitted
 * turn has authority to finish after process loss; a new interactive turn still needs a person.
 *
 * Returns the authority, and records the refusal. Callers do not check and must not: this is the one
 * place the rule lives, the same bargain `inject` makes.
 */
export const resume = Effect.fn("Session.steering.resume")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  input?: { readonly reason?: string; readonly hasWork?: boolean },
) {
  const mode = yield* resolveSessionMode(db, sessionID)
  // A worker's own posture is its officer's; `sessionConfigChain` inside `resolveSessionMode` already
  // walks the parent chain, so the mode above is the OWNER's mode for a spawned worker. The human
  // case is already refused by the mode check, so only an officer reaches the operationMode read.
  const operationMode = mode === "agent" ? yield* resolveOperationMode(db, sessionID) : undefined
  const authority = mayResume({
    mode,
    operationMode,
    ...(input?.hasWork === undefined ? {} : { hasWork: input.hasWork }),
  })
  if (!authority.allowed) {
    yield* Log.event("session.steering.refused", {
      "session.id": sessionID,
      "steering.mode": mode,
      "steering.reason": input?.reason ?? "resume",
    })
  }
  return authority
})

/**
 * The owning officer's `operationMode`, or `undefined` for the autonomous default.
 *
 * Absent is unattended by design (`config/agent.ts`: *"How this officer's durable root session
 * behaves. Absent keeps the autonomous officer default."*), so only an explicit `interactive`
 * withholds consent.
 */
const resolveOperationMode = Effect.fn("Session.steering.operationMode")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const chain = yield* sessionConfigChain(sessionID, (id) => SessionRead.get(db, SessionSchema.ID.make(id)))
  const agentID = agentOf(chain) ?? AgentV2.DEFAULT_COLLEAGUE_ID
  if (agentID === AgentV2.OWNER_ID) return undefined
  const row = yield* db
    .select()
    .from(AgentConfigTable)
    .where(eq(AgentConfigTable.name, agentID))
    .get()
    .pipe(Effect.orDie)
  return AgentV2.operationModeOf(AgentConfigStore.fold(row?.layers ?? []))
})

/**
 * Admit ONE harness interjection, if the session is allowed to receive one.
 *
 * Returns the admitted input, or `undefined` for a `chat` or `human` session. Callers do not check and
 * must not: the check here is the only one, which is the entire point of the module.
 */
export const inject = Effect.fn("Session.steering.inject")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  injection: Injection,
) {
  // A chat LLM is not an agent. It has no goal to continue, no loop to be redirected out of, and no
  // `exit` tool to call — so any interjection aimed at one is a turn that cannot end. This is the gate
  // that used to sit one delegation away from twenty call sites.
  const mode = yield* resolveSessionMode(db, injection.sessionID)
  if (mode !== "agent") {
    yield* Log.event("session.steering.refused", {
      "session.id": injection.sessionID,
      "steering.mode": mode,
      "steering.reason": injection.reason,
    })
    return undefined
  }

  const admitted = yield* SessionInput.admit(db, events, {
    id: injection.id ?? SessionMessage.ID.create(),
    sessionID: injection.sessionID,
    prompt: Prompt.make({ text: applySteerProvenance(injection.text) }),
    delivery: "steer",
  })

  yield* Log.event("session.steering.injected", {
    "session.id": injection.sessionID,
    "steering.reason": injection.reason,
  })
  return admitted
})

/** The namespace every caller imports, matching `SessionInput` and `SessionMessage`. */
export const Steering = { inject, resume, mayResume }
