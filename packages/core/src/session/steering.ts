import { Effect } from "effect"
import { Log } from "@novaclaw/schema/log"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { resolveSessionMode } from "./mode"
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
 *                       Session restarted. Recover and proceed."
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
export const Steering = { inject }
