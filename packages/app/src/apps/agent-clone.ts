// Cloning a colleague (owner, 2026-08-21): "new agent inherits everything, beside a name".
//
// 🔴 **What a clone must NOT inherit is the interesting half.** It takes the BRIEF — the job, the
// personality, the model, the memory setting — and none of the LIFE: not the conversation, not the
// remembered facts, not the spend. Those belong to the colleague that lived them, and a copy that
// inherited them would be a second Theron who remembers work it never did. (The surveyed competitor
// draws the same line — profile, settings and skills yes, history and learned memory no —
// `notes/survey/grokbot-research.md`.) Here that separation is free rather than enforced: memory is
// keyed `agent:<id>` and chats are bound to an agent id, so a new id starts empty by construction.

import { OfficerName } from "@novaclaw/core/agent/officer-name"
import type { AgentLike } from "./contacts"

/** The config fragment a clone is written with, plus the identity it was given. */
export interface Clone {
  /** The new agent's id — the key its memory scope and its chat will hang off. */
  readonly id: string
  /** Its display name, drawn from the pool. */
  readonly name: string
  /** The `agents.<id>` fragment to PATCH. */
  readonly fragment: Record<string, unknown>
}

/**
 * Plan a clone. Pure: the caller does the writing, so the naming rule and the inheritance rule are
 * both testable without a server.
 *
 * `taken` must carry every existing id AND display name — a roster with two "Theron"s is
 * indistinguishable in a hand-off line even when the ids differ, which is the confusion the name
 * pool exists to prevent.
 */
export const planClone = (input: {
  readonly source: AgentLike
  readonly taken: Iterable<string>
  readonly random: () => number
}): Clone => {
  const name = OfficerName.pick({ taken: input.taken, random: input.random })
  const fragment: Record<string, unknown> = { name: OfficerName.display(name) }
  // Copy only what a BRIEF is made of. Anything absent on the source stays absent on the clone
  // rather than being written as an empty string: a blank title is a different fact from "no title",
  // and the roster already renders the two differently.
  const carry = ["title", "personality", "avatar", "memory", "description", "system", "mode"] as const
  for (const key of carry) {
    const value = (input.source as unknown as Record<string, unknown>)[key]
    if (typeof value === "string" && value.trim() !== "") fragment[key] = value
    else if (typeof value === "boolean" || typeof value === "number") fragment[key] = value
  }
  // A clone of a colleague with no explicit mode is still a colleague, not staff: without this a
  // fragment carrying no `mode` would default to whatever the store's default is, and a roster entry
  // that silently becomes a sub-agent vanishes from the list the user just cloned it in.
  if (fragment["mode"] === undefined) fragment["mode"] = "primary"
  return { id: name, name: OfficerName.display(name), fragment }
}
