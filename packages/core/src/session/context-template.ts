export * as ContextTemplate from "./context-template"

/**
 * THE CONTEXT TEMPLATE — where everything goes in one request, and how long each thing lives.
 *
 * 🔴 **Owner, 2026-09-16: *"Hardcoding this is both error prone, impedes maintenance and obscures
 * mechanism from the user and the agents, inviting everyone to the shotgun debugging olympics. Please
 * ensure we have ContextTemplate module with clean API. Context management is very important and its
 * code needs to be perfect architecturally."***
 *
 * Before this module the layout was spread over FIVE places, each able to drift from the others:
 *
 *  1. `runner/system-compose.ts` — the block ORDER (`systemPartsInOrder`) and the part names.
 *  2. `runner/llm.ts` — WHICH producer fills each block, ~70 lines of inline object building.
 *  3. `runner/system-accounting.ts` — the list to COUNT (already derived from 1, which is the model
 *     this module generalises).
 *  4. `session/context-epoch.ts` — what invalidates the frozen baseline.
 *  5. `runner/llm.ts` again — the frozen TOOL prefix, keyed on the baseline, hundreds of lines from the
 *     system blocks it shares a cache with.
 *
 * The cost of that split is not tidiness. **`volatility` is the field that decides whether a request
 * keeps the server's prefix cache, and getting it wrong is the failure the owner names — gigabytes of
 * KV re-prefill and a box that stops answering.** Today that knowledge is a prose warning in
 * `system-compose.ts`, an implicit consequence of where a value is read in `llm.ts`, and a conditional
 * in `context-epoch.ts`. Here it is one word per slot, next to the slot it applies to.
 *
 * ## The shape
 *
 * A slot is a place in the request. Every slot declares, in one row:
 *
 *  - `name` — the id a log line, a panel, a test and a reader all use. It is the ONLY name.
 *  - `channel` — WHERE it goes: the system prompt, the tool schemas, the transcript, or the tail.
 *  - `volatility` — HOW LONG its value survives. See below; this is the load-bearing column.
 *  - `purpose` — one line saying what the slot is for, for a person or an agent reading the table
 *    rather than the code. This is the "teach, do not gatekeep" half: the mechanism is legible from
 *    the table instead of reconstructed from five files.
 *
 * ## Volatility, and why it is not decoration
 *
 *  - `epoch` — frozen for a context epoch. The text is stored WITH the epoch row and reused verbatim
 *    (or not at all) until the epoch is replaced. Changing an `epoch` slot's content mid-epoch is a
 *    cache miss for the whole history behind it, which is why exactly one slot is this.
 *  - `compaction` — refreshed only when a compaction commits. Snapshot-stable between compactions by
 *    construction, so a mid-run write to the store behind it cannot churn the prefix.
 *  - `turn` — recomputed every turn from current state, with no promise of stability.
 *
 * ⚠️ **`compaction` has no slot yet.** It is declared because the vocabulary is not free-form: the
 * durable area (owner, 2026-09-16) is defined as *"updated only after compaction, from the housekeeped
 * shadow copy"*, so the moment its slot lands it needs this exact value and must not be given `turn`.
 * A reader who finds an empty rung is better served by that sentence than by a surprise.
 *
 * ⚠️ **Order is array order, and the array is the ONE list.** `systemBlocks` below derives the system
 * prompt's order from it; `SystemAccounting.BLOCKS` derives from that; the request assembler fills
 * slots by name. A new place in the request is a new row here, and the ledger test
 * (`test/session-system-compose.test.ts`) fails to typecheck until somebody decides whether it belongs
 * in the standing baseline — which is the decision, made once, in the file a future author reads.
 */

/**
 * Where a slot's content goes in the request.
 *
 * | channel | lands as |
 * |---|---|
 * | `system` | one entry of the system prompt, in slot order (`systemBlocks`) |
 * | `tools` | the request's `tools:` array — the tool SCHEMAS, never prose |
 * | `messages` | the transcript, ahead of the tail |
 * | `tail` | messages appended AFTER the transcript, in slot order |
 *
 * ⚠️ The tool schemas are a request FIELD, not a system block, and they share the same prefix cache as
 * the system prompt. `toolDiscovery` (a `system` slot) only says the list is partial; the schemas
 * themselves are `tools`. Keeping those two facts in one table is what stops "add a line about tools"
 * from meaning two different things in two files.
 */
export type Channel = "system" | "tools" | "messages" | "tail"

/** How long a slot's value survives. See the header: this is the prefix-cache contract. */
export type Volatility = "epoch" | "compaction" | "turn"

export interface Slot {
  readonly name: string
  readonly channel: Channel
  readonly volatility: Volatility
  /** One line for a human or an agent reading the table. Not a restatement of the name. */
  readonly purpose: string
  /**
   * Why it sits where it sits, when the position is not obvious. Absent for slots whose order is
   * forced by the list itself.
   *
   * 🔴 These notes are not new: they are the comments that used to live inside the ORDER array that
   * this module replaced. Moving them here is the point — a reason that sits at the slot it constrains
   * cannot be separated from it by a refactor.
   */
  readonly placement?: string
}

/**
 * THE TABLE. Order is the array order, and it is the system prompt's order.
 *
 * ⚠️ Every `system` slot's name is also the key in `SystemPromptParts`, so `systemBlocks` and the
 * runner's part builder cannot disagree about what exists. See `systemSlotNames`.
 */
export const SLOTS = [
  {
    name: "persona",
    channel: "system",
    volatility: "turn",
    purpose: "Who Nova is: the standing product identity, before anything an officer or a person adds.",
  },
  {
    name: "modelPrePrompt",
    channel: "system",
    volatility: "turn",
    purpose: "The operator's correction for THIS model's known behaviour, which is why it travels with the weights.",
    placement:
      "Immediately after the persona baseline: the correction applies to everything the model reads, including its own identity text.",
  },
  {
    name: "expertiseHint",
    channel: "system",
    volatility: "turn",
    purpose: "The plain-language stance for a Normal-expertise user.",
  },
  {
    name: "taxonomyHint",
    channel: "system",
    volatility: "turn",
    purpose: "The small-model scaffold — supplied only for a model the operator classified `fast`.",
  },
  {
    name: "systemPromptOverride",
    channel: "system",
    volatility: "turn",
    purpose: "A per-session system prompt override from the config walk.",
  },
  {
    name: "agentIdentity",
    channel: "system",
    volatility: "turn",
    purpose: "The officer's name, title and personality, wrapped in exactly one identity section.",
  },
  {
    name: "agentSystem",
    channel: "system",
    volatility: "turn",
    purpose: "The officer's own job instructions. In a pure Chat this is the ONLY system block.",
  },
  {
    name: "organization",
    channel: "system",
    volatility: "turn",
    purpose: "The reporting line and the authority that narrows down it.",
    placement:
      "After the editable identity and job text, so neither a personality nor a cloned brief can promote an officer into a second CEO.",
  },
  {
    name: "toolDiscovery",
    channel: "system",
    volatility: "turn",
    purpose: "That the tool list is PARTIAL, and how many schemas are being held back.",
    placement: "Beside the other runtime-capability facts, which a persona must not be able to bury.",
  },
  {
    name: "perception",
    channel: "system",
    volatility: "turn",
    purpose: "That this model can see, and that an image on disk is therefore its own to look at.",
  },
  {
    name: "delegation",
    channel: "system",
    volatility: "turn",
    purpose: "Who else can do work — `spawn` for more hands, `colleague` for somebody else's job.",
  },
  {
    name: "memoryStance",
    channel: "system",
    volatility: "turn",
    purpose: "What this colleague keeps: nothing at all, or nothing archived, or the ordinary case.",
  },
  {
    name: "projectScope",
    channel: "system",
    volatility: "turn",
    purpose: "The kernel's standing instruction about the folder it may touch, by permission mode.",
    placement:
      "Immediately before `base`: it is a kernel constraint, not task material, and a well-meaning agent prompt must not be able to bury it under later instructions.",
  },
  {
    name: "workspace",
    channel: "system",
    volatility: "turn",
    purpose: "Where a colleague with BOTH a project folder and a scratch folder should put scratch.",
    placement:
      "After `projectScope` on purpose: that section says keep scratch inside the working folder, which is right until the colleague has a workspace of its own. The specific instruction has to land last or a model is left reconciling two rules.",
  },
  {
    name: "base",
    channel: "system",
    volatility: "epoch",
    purpose:
      "The epoch-frozen kernel baseline: environment, standing instructions (AGENTS.md), skills index, tool catalogue, references, ad-hoc tools, live-work ledger.",
    placement:
      "LAST of the framing material: it is the largest block on most turns and the one a reader scrolls to, so everything that frames how to behave comes before what to work on.",
  },
  {
    name: "goal",
    channel: "system",
    volatility: "turn",
    purpose:
      "The officer's durable objective, shown only while the session is unattended — so the Interactive ⇄ Unattended switch adds and removes it.",
    placement:
      "After `base`, i.e. last: the owner's own sketch puts the goal and the durable area at the end, immediately before the first user prompt, and a block at the END invalidates the fewest messages when it changes.",
  },
  {
    name: "durable",
    channel: "system",
    volatility: "compaction",
    purpose:
      "The durable area: short named items the colleague must not lose to a rewrite, set with `durable_set` and cleared with `durable_clear`.",
    placement:
      "Immediately after `goal`, which is where the owner's own sketch puts it (`<goal>`, `#DURABLE`, then the first user prompt). It is the one `compaction`-volatile slot in the table: materialised from the `durable` items when the context is REBUILT, never mid-turn, so the prompt is byte-stable for the whole epoch.",
  },
  // ── the tail ────────────────────────────────────────────────────────────────────────────────────
  // Appended AFTER the transcript, in this order. Recalled memory is here rather than in the system
  // prompt because it is the one genuinely per-turn-volatile thing in the request: as a system block it
  // threw away the server-side prefix cache on every turn (see the `system-compose.ts` header).
  {
    name: "projectGrounding",
    channel: "tail",
    volatility: "turn",
    purpose: "The grounding cadence's steer: what the folder looks like now, for an agent working on it.",
  },
  {
    name: "memoryRecall",
    channel: "tail",
    volatility: "turn",
    purpose: "What the colleague remembers about this turn's subject, packed to a bounded token budget.",
  },
  {
    name: "todoReminder",
    channel: "tail",
    volatility: "turn",
    purpose: "The live plan reminder, when the plan has gone stale against the conversation.",
  },
  {
    name: "toolCatalogueUpdate",
    channel: "tail",
    volatility: "turn",
    purpose: "A note that the tool catalogue moved since the frozen prefix was taken.",
  },
  {
    name: "maxSteps",
    channel: "tail",
    volatility: "turn",
    purpose: "The step-budget notice for a turn that has run long.",
  },
] as const satisfies readonly Slot[]

export type SlotName = (typeof SLOTS)[number]["name"]

/**
 * The SYSTEM-prompt slots only, as a union of names.
 *
 * ⚠️ `Extract` on the table, not a hand-written union: the tail slots are deliberately NOT part of
 * `SystemPromptParts`, and the first version of this module mapped the parts type over every
 * `SlotName` — which the existing compose ledger caught immediately by demanding `memoryRecall`,
 * `todoReminder`, `toolCatalogueUpdate` and `maxSteps` as system blocks. A table that lets one channel
 * leak into another is the kind of mistake this module exists to make impossible, so the channel filter
 * is derived rather than trusted.
 */
export type SystemSlotName = Extract<(typeof SLOTS)[number], { readonly channel: "system" }>["name"]

/** The slots of one channel, in table order. The ONE filter every consumer uses. */
export const slotsIn = (channel: Channel): readonly Slot[] => SLOTS.filter((slot) => slot.channel === channel)

/** Every system-prompt slot's name, in order. The key set of `SystemPromptParts`. */
export const systemSlotNames = (): readonly SystemSlotName[] =>
  slotsIn("system").map((slot) => slot.name as SystemSlotName)

/**
 * The system prompt's parts — the type is DERIVED from the table, so a slot cannot exist without a key
 * and a key cannot exist without a slot.
 *
 * ⚠️ Optional, and deliberately: a slot with nothing to say composes nothing (an absence teaches
 * nothing, and an empty block costs tokens on every turn). The ledger test is what forces a decision
 * when a slot is added, by failing to typecheck until somebody says whether it belongs in the standing
 * baseline or is conditional.
 */
export type SystemPromptParts = {
  readonly [K in SystemSlotName]?: string
}

/**
 * The ordered, non-empty system blocks for one turn — `{ block, text }` pairs, honouring the table's
 * order.
 *
 * ⚠️ The non-empty predicate is the one the runner has always used (`!== undefined && length > 0`).
 * It is stated here, once, because it decides whether a block participates in the prefix at all.
 */
export const systemBlocks = (parts: SystemPromptParts): ReadonlyArray<{ block: string; text?: string }> =>
  slotsIn("system").map((slot) => ({ block: slot.name, text: parts[slot.name as SystemSlotName] }))

/** The system blocks that actually compose, in order. What `composeSystemParts` joins. */
export const composedBlocks = (parts: SystemPromptParts): readonly string[] =>
  systemBlocks(parts)
    .filter((part) => part.text !== undefined && part.text.length > 0)
    .map((part) => part.block)

/** The TAIL slots only, as a union of names — the same `Extract` discipline as `SystemSlotName`. */
export type TailSlotName = Extract<(typeof SLOTS)[number], { readonly channel: "tail" }>["name"]

/** Every tail slot's name, in order. */
export const tailSlotNames = (): readonly TailSlotName[] => slotsIn("tail").map((slot) => slot.name as TailSlotName)

/**
 * The tail, in table order, from per-slot items.
 *
 * ⚠️ **Generic over the message type on purpose**: the table owns the ORDER, and the protocol owns what
 * a message IS. A template that imported `Message` would be a layering mistake and would make this
 * module un-renderable by the UI and unavailable to anything that only wants the order. So the caller
 * supplies a value per slot and gets them back in the one order.
 *
 * ⚠️ An absent slot contributes nothing rather than an empty entry: a tail item with no content is a
 * message the model reads and learns nothing from, and it still costs tokens on every turn.
 */
export const tailMessages = <M>(items: { readonly [K in TailSlotName]?: M | undefined }): readonly M[] =>
  tailSlotNames().flatMap((name) => {
    const item = items[name]
    return item === undefined ? [] : [item]
  })

/**
 * THE TABLE AS TEXT — for a log line, a settings panel, or an agent that asks where things go.
 *
 * 🔴 This exists because "obscures mechanism from the user and the agents" is the complaint, not a
 * side note: the mechanism was only legible by reading five files, so every question about it cost an
 * investigation. A rendering is the difference between a table people consult and a grep they perform.
 * It is data in, text out — no I/O, no environment, so a test can pin it and a UI can render it.
 */
export const describe = (): string =>
  SLOTS.map((slot) => {
    const where =
      slot.channel === "system" ? `system[${slotsIn("system").findIndex((s) => s.name === slot.name)}]` : slot.channel
    return `${slot.name.padEnd(20)} ${where.padEnd(10)} ${slot.volatility.padEnd(11)} ${slot.purpose}`
  }).join("\n")
