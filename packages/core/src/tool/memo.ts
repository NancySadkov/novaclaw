export * as MemoTool from "./memo"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@novaclaw/llm"
import { makeLocationNode } from "../effect/app-node"
import { Durable } from "../session/durable"
import { SessionComponentRegistry } from "../session/component-registry"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * `memo_set` / `memo_clear` — the two tools the owner named for the memo area.
 *
 * Owner, 2026-09-17: *"rename `durable_set` and `durable_clear` to `memo_set` and `memo_clear`,
 * while ensuring it is part of the basic tools list, like `edit` and `spawn`."* The storage kind
 * stays `durable` (`session/durable.ts`) — the owner named the TOOLS, and a kind is a storage
 * column, not a word a model reads.
 *
 * ⚠️ **Why dedicated tools when the generic `session` tool can already write a component of any kind.**
 * Three reasons, and the first is load-bearing: the ITEM COUNT is a property of the SET, which no
 * single-value codec can see, so the ≤10 rule has to live in a writer that reads the set first. The
 * other two are the agent's side of the same rule — a refusal that names the remedy (a value that is
 * too long belongs in a file, whose path is then the value) and a success that shows the area it just
 * changed, because the write does not reach the prompt until the next rewrite and a tool that answers
 * only "ok" leaves the colleague unable to tell whether its note landed.
 *
 * 🔴 **No permission charge (owner, 2026-09-18).** A dedicated writer used to re-implement the
 * generic tool's `session`-tier charge, exactly so a second door could not make the tier inert. With
 * the write tiers gone, the agent owns this area outright: the memo is its own working memory, and
 * `durable` has no authority gate in `component-registry.ts` beyond the codec. The failure that
 * prompted the removal was `memo_set` itself, refused with *"needs a human's approval… no operator is
 * present to answer a consent prompt"*.
 *
 * ⚠️ **The write is immediate and the VISIBILITY is deferred, deliberately.** The item is in the shadow
 * the moment this returns (so `session list kind=durable` shows it, and the next compaction renders
 * it), while the block in the system prompt changes only at a rewrite. That split is the owner's
 * invariant — see `component-registry.ts`'s `DurablePrompt` — not an implementation detail.
 */

export const SetInput = Schema.Struct({
  name: Schema.String.annotate({
    description: `The item's short name — at most ${Durable.DURABLE_NAME_MAX} characters, one line. Reusing a name replaces that item.`,
  }),
  value: Schema.String.annotate({
    description: `The item's value — at most ${Durable.DURABLE_VALUE_MAX} characters, one line. Too long? Write the text to a file in your scratch folder and put that path here.`,
  }),
})
export type SetInput = typeof SetInput.Type

export const ClearInput = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the item to clear." }),
})
export type ClearInput = typeof ClearInput.Type

export const Output = Schema.Struct({ message: Schema.String })
export type Output = typeof Output.Type

/** Yieldable, exactly as `tool/session.ts` does it: an Effect generator can `yield*` this error. */
const failure = (message: string) => new ToolFailure({ message })

const kind = "durable" as const

/**
 * The area as the tool reports it back.
 *
 * ⚠️ The count is always stated. A colleague that can see "3 of 10" knows how much room its memory has
 * left without spending a call to ask, and at the limit the NAMES are what it needs in order to choose
 * what to drop.
 */
const describeArea = (items: readonly Durable.Item[]): string =>
  items.length === 0
    ? "The memo area is empty."
    : `The memo area now holds ${items.length} of ${Durable.DURABLE_ITEMS_MAX}: ${items.map((item) => item.name).join(", ")}.`

/**
 * The services this tool needs, CAPTURED in the layer instead of yielded inside `execute`.
 *
 * ⚠️ Not a style choice. `Tool.make`'s `execute` is typed `Effect<Output, ToolFailure>` — with NO
 * requirements — so a service yielded in the body makes the registration fail to typecheck (measured:
 * `Type 'Service' is not assignable to type 'never'`). The sibling tools capture for the same reason
 * (`tool/kill.ts` holds `ColleagueHandoff.Service` this way), and it also makes the captured instance
 * the one the location graph actually provided.
 */
export interface Deps {
  readonly components: SessionComponentRegistry.Interface
}

const readItems = (deps: Deps, context: { readonly sessionID: SessionSchema.ID }) =>
  Effect.gen(function* () {
    const rows = yield* deps.components
      .list({ sessionID: context.sessionID, kind })
      .pipe(Effect.orElseSucceed((): readonly { readonly value: unknown }[] => []))
    return Durable.itemsOf(rows)
  })

export const setMemo = (deps: Deps, input: SetInput, context: Tool.Context) =>
  Effect.gen(function* () {
    const components = deps.components
    const ctx = context
    const itemName = input.name.trim()
    const itemValue = input.value.trim()
    if (itemName.length === 0) return yield* failure("A memo item needs a name.")
    if (itemName.length > Durable.DURABLE_NAME_MAX) return yield* failure(Durable.nameTooLongNotice(itemName))
    if (itemValue.length === 0) return yield* failure("A memo item needs a value.")
    if (itemValue.length > Durable.DURABLE_VALUE_MAX)
      return yield* failure(Durable.overLongValueNotice(itemName, itemValue.length))
    // 🔴 The framing rule, refused before anything is stored: the area renders as `Name: Value` LINES
    // inside the system prompt, so a line break in either half can forge a second item — text the user
    // never wrote, in the block whose whole job is to be believable across a rewrite.
    if (/[\r\n]/u.test(itemName) || /[\r\n]/u.test(itemValue))
      return yield* failure(
        "A memo item is one line of `Name: value`, so neither half may contain a line break. If the text " +
          "needs several lines, write it to a file and set the value to that path.",
      )

    const id = Durable.keyOf(itemName)
    const items = yield* readItems(deps, ctx)
    const existing = items.find((item) => item.id === id)
    if (existing === undefined && items.length >= Durable.DURABLE_ITEMS_MAX)
      return yield* failure(Durable.areaFullNotice(items))

    // Validate before the write, so a hard codec refusal names the fault (the id↔name agreement and
    // the no-newline framing rule) instead of surfacing as some later storage error.
    const value = yield* components
      .validate({ sessionID: ctx.sessionID, kind, id, value: { name: itemName, value: itemValue } })
      .pipe(Effect.mapError((error) => failure(error.message)))
    yield* components
      .put({ sessionID: ctx.sessionID, kind, id, value })
      .pipe(Effect.mapError((error) => failure(error.message)))

    const after = existing === undefined ? [...items, { id, name: itemName, value: itemValue }] : items
    return {
      message:
        `${existing === undefined ? "Kept" : "Replaced"} \`${itemName}\` in the memo area, which is rebuilt ` +
        `into your system prompt after the next compaction. ${describeArea(after)}`,
    }
  })

export const clearMemo = (deps: Deps, input: ClearInput, context: Tool.Context) =>
  Effect.gen(function* () {
    const components = deps.components
    const ctx = context
    const itemName = input.name.trim()
    const id = Durable.keyOf(itemName)
    const previous = yield* components
      .get({ sessionID: ctx.sessionID, kind, id })
      .pipe(Effect.orElseSucceed(() => undefined))

    if (previous !== undefined) {
      yield* components
        .validateRemoval({ sessionID: ctx.sessionID, kind, id })
        .pipe(Effect.mapError((error) => failure(error.message)))
      yield* components
        .remove({ sessionID: ctx.sessionID, kind, id })
        .pipe(Effect.mapError((error) => failure(error.message)))
    }

    const items = (yield* readItems(deps, ctx)).filter((item) => item.id !== id)
    return {
      message:
        previous === undefined
          ? `There is no memo item named \`${itemName}\`. ${describeArea(items)}`
          : `Cleared \`${itemName}\` from the memo area. ${describeArea(items)}`,
    }
  })

/**
 * Every failure this tool can raise, as the one `ToolFailure` the tool contract allows.
 *
 * ⚠️ Copied in shape from `tool/session.ts`, which is the other writer of a session component: a
 * refusal the model cannot read is a refusal it will retry five times. There is no permission denial
 * to translate any more (the write tiers are gone), so this maps the registry's own refusals — the
 * codec limits and the id↔name agreement — and otherwise passes the registry's sentence through.
 */
export const toFailure = (error: unknown): ToolFailure => {
  if (error instanceof ToolFailure) return error
  if (error instanceof SessionComponentRegistry.InvalidValueError)
    return failure(`Invalid memo item: ${error.message}`)
  return failure(error instanceof Error ? error.message : String(error))
}

// 🗑️ The registration lives in `memo-set.ts` and `memo-clear.ts`. What stays here is the half both
// tools share: the two schemas, the item/deps plumbing, and the refusal mapping. Nothing in this file
// registers a tool.
