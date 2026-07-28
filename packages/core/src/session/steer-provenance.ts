// 1N (codehamr A1) — every harness-injected steer carries this provenance prefix. A ~30B model
// reads a bare mid-turn injected message as an *empty user turn* and just stops; naming the note
// as an automated check (not the user speaking) keeps it acting. The prefix doubles as the steer
// MARKER across the system: title generation, Strict, context-pack, and the session-ui renderer
// all detect steers by it (it is the only steer fact that survives into the durable message text).
//
// This module is PURE and dependency-free ON PURPOSE — the session-ui renderer imports it into
// the browser bundle to fold steers out of the transcript, so nothing server-only (db, Effect,
// drizzle) may ever be imported here. The injection machinery lives in `session/input.ts`.
export const STEER_PROVENANCE_PREFIX = "[Automated NovaClaw check — not a message from your user.] "

/** Prepend the 1N provenance prefix unless the text already carries it (idempotent). */
export const applySteerProvenance = (text: string) =>
  text.startsWith(STEER_PROVENANCE_PREFIX) ? text : STEER_PROVENANCE_PREFIX + text

/** Whether a user-role message text is a harness-injected steer rather than the user speaking. */
export const isSteerText = (text: string) => text.startsWith(STEER_PROVENANCE_PREFIX)

/** The steer body without the provenance prefix (for display — the model still sees the full text). */
export const stripSteerProvenance = (text: string) =>
  text.startsWith(STEER_PROVENANCE_PREFIX) ? text.slice(STEER_PROVENANCE_PREFIX.length) : text

// ─────────────────────────────────────────────────────────────────────────────
// B2 — ONE answer to "is this really the user talking?", and the transcript walks that use it.
//
// A steer rides the `user` role all the way into the durable record, so every consumer that reads
// "the user's text" out of a transcript has to ask that question. Six did, in four different ways:
// three raw `startsWith` calls, one locally re-declared predicate, and TWO that never asked at all.
// The two silent ones were the expensive kind of wrong — auto-extraction (`runner/extract.ts`) fed
// the harness's own instruction text to the extractor, which wrote it into SESSION memory as a fact
// about the user, and `kb-graph`'s `consolidate()` then promoted it to a GLOBAL, cross-session twin;
// auto-recall (`runner/recall.ts`) searched memory with that same scaffolding as the query.
//
// So the walks live here, once, and consumers take a LOCATOR instead of re-deriving `type === "user"`
// (which compiles green whether or not it asks). `test/steer-provenance.test.ts` is the mechanical
// half: it scans `src/session/**` for raw user-role discriminators and fails on any file that
// neither routes through this module nor sits on its named ledger.
//
// The type-only import below is erased at build time — this module stays runtime-dependency-free for
// the browser bundle. The WIRE-shaped twin (`@novaclaw/llm` messages, whose text lives in parts
// rather than a flat field) is `runner/context-pack.ts`'s `isRealUserMessage`; it delegates to
// `isSteerText` above so there is still only one place that knows what a steer looks like.

import type { SessionMessage } from "./message"

/** Is this transcript message the user speaking — rather than a harness steer riding the user role? */
export const isRealUserTurn = (message: SessionMessage.Message): message is SessionMessage.User =>
  message.type === "user" && !isSteerText(message.text)

/** A located real user turn: where it sits in the transcript, and its trimmed (non-empty) text. */
export interface RealUserTurn {
  readonly index: number
  readonly text: string
}

const locate = (context: readonly SessionMessage.Message[], index: number): RealUserTurn | undefined => {
  const message = context[index]
  if (message === undefined || !isRealUserTurn(message)) return undefined
  const text = message.text.trim()
  return text.length > 0 ? { index, text } : undefined
}

/**
 * The NEWEST real user turn that actually says something — what this turn of the conversation is
 * about (auto-recall's query, auto-extraction's anchor, Strict's task). Blank turns are skipped
 * rather than terminating the walk, matching the long-standing `strict.ts` semantics.
 */
export const lastRealUserTurn = (context: readonly SessionMessage.Message[]): RealUserTurn | undefined => {
  for (let i = context.length - 1; i >= 0; i--) {
    const found = locate(context, i)
    if (found !== undefined) return found
  }
  return undefined
}

/** The OLDEST real user turn that says something — the original task (title seed, context anchor). */
export const firstRealUserTurn = (context: readonly SessionMessage.Message[]): RealUserTurn | undefined => {
  for (let i = 0; i < context.length; i++) {
    const found = locate(context, i)
    if (found !== undefined) return found
  }
  return undefined
}

/** Text of the newest real user turn (see `lastRealUserTurn`). */
export const lastRealUserText = (context: readonly SessionMessage.Message[]): string | undefined =>
  lastRealUserTurn(context)?.text

/** Text of the oldest real user turn (see `firstRealUserTurn`). */
export const firstRealUserText = (context: readonly SessionMessage.Message[]): string | undefined =>
  firstRealUserTurn(context)?.text

/**
 * Index of the newest real user turn, TEXT-LESS ONES INCLUDED (`-1` when there is none). Deliberately
 * distinct from `lastRealUserTurn().index`: this answers "where did the current goal start", and a
 * files-only prompt with no text is still a new goal — whereas the text-bearing walks above answer
 * "what did the user say", which a blank turn cannot.
 */
export const lastRealUserIndex = (context: readonly SessionMessage.Message[]): number => {
  for (let i = context.length - 1; i >= 0; i--) if (isRealUserTurn(context[i]!)) return i
  return -1
}
