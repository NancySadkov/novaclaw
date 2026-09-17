export * as ContextTemplate from "./context-template"

/**
 * THE TAIL — the ordered messages appended AFTER the transcript.
 *
 * 🗑️ **Retired as the layout of the whole request (owner, 2026-09-17).** This module used to declare
 * every place in a request — the system blocks, the tool schemas, the transcript and the tail — each
 * with a `volatility` column that was the prefix-cache contract. The system prompt is now ONE
 * monolithic `role: "system"` message rendered by `session/runner/prompt-manager.ts`, so the
 * `system`/`tools`/`messages` channels have no rows and the volatility vocabulary went with them. The
 * old per-turn part assembly (`system-compose.ts`) and its accounting instrument are deleted.
 *
 * What remains is the half that was always separate and still is: the TAIL. These are real messages
 * after the transcript (recall, grounding, reminders), recomputed every turn, and their ORDER is still
 * decided here rather than in the runner so the two cannot drift.
 */

export interface Slot {
  readonly name: string
  /** One line saying what the slot is for, for a person or an agent reading the table. */
  readonly purpose: string
}

export const SLOTS = [
  {
    name: "projectGrounding",
    purpose: "The grounding cadence's steer: what the folder looks like now, for an agent working on it.",
  },
  {
    name: "memoryRecall",
    purpose: "What the colleague remembers about this turn's subject, packed to a bounded token budget.",
  },
  {
    name: "todoReminder",
    purpose: "The live plan reminder, when the plan has gone stale against the conversation.",
  },
  {
    name: "toolCatalogueUpdate",
    purpose: "A note that the tool catalogue moved since the frozen prefix was taken.",
  },
  {
    name: "maxSteps",
    purpose: "The step-budget notice for a turn that has run long.",
  },
] as const satisfies readonly Slot[]

export type SlotName = (typeof SLOTS)[number]["name"]

/** Every tail slot's name, in order. */
export const tailSlotNames = (): readonly SlotName[] => SLOTS.map((slot) => slot.name)

/**
 * The tail, in table order, from per-slot items.
 *
 * ⚠️ **Generic over the message type on purpose**: the table owns the ORDER, and the protocol owns what
 * a message IS. An absent slot contributes nothing rather than an empty entry: a tail item with no
 * content is a message the model reads and learns nothing from, and it still costs tokens every turn.
 */
export const tailMessages = <M>(items: { readonly [K in SlotName]?: M | undefined }): readonly M[] =>
  tailSlotNames().flatMap((name) => {
    const item = items[name]
    return item === undefined ? [] : [item]
  })

/**
 * THE TABLE AS TEXT — for a log line, a settings panel, or an agent that asks where things go.
 *
 * Data in, text out — no I/O, no environment, so a test can pin it and a UI can render it.
 */
export const describe = (): string =>
  SLOTS.map((slot) => `${slot.name.padEnd(20)} tail       ${slot.purpose}`).join("\n")
