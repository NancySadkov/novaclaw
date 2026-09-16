export * as DurableTool from "./durable"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@novaclaw/llm"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { Durable } from "../session/durable"
import { SessionComponentRegistry } from "../session/component-registry"
import { SessionComponentTier } from "../session/component-tier"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * `durable_set` / `durable_clear` — the two tools the owner named for the durable area.
 *
 * Owner, 2026-09-16: *"This context area stores named entries set by either harness or the agent itself
 * using `durable_set Name Value` and `durable_clear Name` tools … The area is limited to 10 items (Name
 * can't be longer than 30 chars, Value can't be longer than 512 chars) and updated only after
 * compaction, from the housekeeped shadow copy."*
 *
 * ⚠️ **Why dedicated tools when the generic `session` tool can already write a component of any kind.**
 * Three reasons, and the first is load-bearing: the ITEM COUNT is a property of the SET, which no
 * single-value codec can see, so the ≤10 rule has to live in a writer that reads the set first. The
 * other two are the agent's side of the same rule — a refusal that names the remedy (a value that is
 * too long belongs in a file, whose path is then the value) and a success that shows the area it just
 * changed, because the write does not reach the prompt until the next rewrite and a tool that answers
 * only "ok" leaves the colleague unable to tell whether its note landed.
 *
 * 🔴 **The permission charge is NOT optional here, and this is the half a dedicated writer gets wrong.**
 * `SessionComponentTier.tierOf("durable")` is `consequential`, which is priced at the `session`
 * permission action — but a tier is only a price if somebody charges it. The generic tool charges it in
 * its own body, so a second door that writes the same kind silently made the tier inert: the reader of
 * `component-tier.ts` would see a price with no checkout. {@link charge} is that checkout, copied from
 * `tool/session.ts`'s write path rather than re-derived, including the `source` triple a refusal is
 * attributed to.
 *
 * ⚠️ **The write is immediate and the VISIBILITY is deferred, deliberately.** The item is in the shadow
 * the moment this returns (so `session list kind=durable` shows it, and the next compaction renders
 * it), while the block in the system prompt changes only at a rewrite. That split is the owner's
 * invariant — see `component-registry.ts`'s `DurablePrompt` — not an implementation detail.
 */

export const name = "durable_set"

const SetInput = Schema.Struct({
  name: Schema.String.annotate({
    description: `The item's short name — at most ${Durable.DURABLE_NAME_MAX} characters, one line. Reusing a name replaces that item.`,
  }),
  value: Schema.String.annotate({
    description: `The item's value — at most ${Durable.DURABLE_VALUE_MAX} characters, one line. Too long? Write the text to a file in your scratch folder and put that path here.`,
  }),
})
export type SetInput = typeof SetInput.Type

const ClearInput = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the item to clear." }),
})
export type ClearInput = typeof ClearInput.Type

const Output = Schema.Struct({ message: Schema.String })
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
    ? "The durable area is empty."
    : `The durable area now holds ${items.length} of ${Durable.DURABLE_ITEMS_MAX}: ${items.map((item) => item.name).join(", ")}.`

/**
 * The services this tool needs, CAPTURED in the layer instead of yielded inside `execute`.
 *
 * ⚠️ Not a style choice. `Tool.make`'s `execute` is typed `Effect<Output, ToolFailure>` — with NO
 * requirements — so a service yielded in the body makes the registration fail to typecheck (measured:
 * `Type 'Service' is not assignable to type 'never'`). The sibling tools capture for the same reason
 * (`tool/kill.ts` holds `ColleagueHandoff.Service` this way), and it also makes the captured instance
 * the one the location graph actually provided.
 */
interface Deps {
  readonly components: SessionComponentRegistry.Interface
  readonly permission: PermissionV2.Interface
}

const readItems = (deps: Deps, context: { readonly sessionID: SessionSchema.ID }) =>
  Effect.gen(function* () {
    const rows = yield* deps.components
      .list({ sessionID: context.sessionID, kind })
      .pipe(Effect.orElseSucceed((): readonly { readonly value: unknown }[] => []))
    return Durable.itemsOf(rows)
  })

/**
 * Charge the kind's price, exactly as the generic component tool does.
 *
 * ⚠️ `operational` kinds are free and that case is kept explicitly rather than assumed: the tier table
 * is the single place a kind's price is decided, so this reads it instead of restating "durable costs
 * a session approval" — a restatement would be a second answer that drifts the day the tier moves.
 */
const charge = (deps: Deps, context: Tool.Context, operation: string) =>
  Effect.gen(function* () {
    const tier = SessionComponentTier.tierOf(kind)
    if (tier === "operational") return
    yield* deps.permission.assert({
      action: SessionComponentTier.TIER_ACTION[tier],
      resources: [kind],
      save: [kind],
      metadata: { tier, operation },
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
    })
  })

const set = (deps: Deps, input: SetInput, context: Tool.Context) =>
  Effect.gen(function* () {
    const components = deps.components
    const ctx = context
    const itemName = input.name.trim()
    const itemValue = input.value.trim()
    if (itemName.length === 0) return yield* failure("A durable item needs a name.")
    if (itemName.length > Durable.DURABLE_NAME_MAX) return yield* failure(Durable.nameTooLongNotice(itemName))
    if (itemValue.length === 0) return yield* failure("A durable item needs a value.")
    if (itemValue.length > Durable.DURABLE_VALUE_MAX)
      return yield* failure(Durable.overLongValueNotice(itemName, itemValue.length))
    // 🔴 The framing rule, refused before anything is stored: the area renders as `Name: Value` LINES
    // inside the system prompt, so a line break in either half can forge a second item — text the user
    // never wrote, in the block whose whole job is to be believable across a rewrite.
    if (/[\r\n]/u.test(itemName) || /[\r\n]/u.test(itemValue))
      return yield* failure(
        "A durable item is one line of `Name: value`, so neither half may contain a line break. If the text " +
          "needs several lines, write it to a file and set the value to that path.",
      )

    const id = Durable.keyOf(itemName)
    const items = yield* readItems(deps, ctx)
    const existing = items.find((item) => item.id === id)
    if (existing === undefined && items.length >= Durable.DURABLE_ITEMS_MAX)
      return yield* failure(Durable.areaFullNotice(items))

    // Validate BEFORE the charge, so a hard codec refusal cannot be mistaken for something a permission
    // grant would have allowed (the order `tool/session.ts` established for the same reason).
    const value = yield* components
      .validate({ sessionID: ctx.sessionID, kind, id, value: { name: itemName, value: itemValue } })
      .pipe(Effect.mapError((error) => failure(error.message)))
    yield* charge(deps, context, "set")
    yield* components
      .put({ sessionID: ctx.sessionID, kind, id, value })
      .pipe(Effect.mapError((error) => failure(error.message)))

    const after = existing === undefined ? [...items, { id, name: itemName, value: itemValue }] : items
    return {
      message:
        `${existing === undefined ? "Kept" : "Replaced"} \`${itemName}\` in the durable area, which is rebuilt ` +
        `into your system prompt after the next compaction. ${describeArea(after)}`,
    }
  })

const clear = (deps: Deps, input: ClearInput, context: Tool.Context) =>
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
      yield* charge(deps, context, "remove")
      yield* components
        .remove({ sessionID: ctx.sessionID, kind, id })
        .pipe(Effect.mapError((error) => failure(error.message)))
    }

    const items = (yield* readItems(deps, ctx)).filter((item) => item.id !== id)
    return {
      message:
        previous === undefined
          ? `There is no durable item named \`${itemName}\`. ${describeArea(items)}`
          : `Cleared \`${itemName}\` from the durable area. ${describeArea(items)}`,
    }
  })

/**
 * Every failure this tool can raise, as the one `ToolFailure` the tool contract allows.
 *
 * ⚠️ Copied in shape from `tool/session.ts`, which is the other writer of a session component and the
 * reason this exists: `permission.assert` fails with `PermissionV2.DeniedError`, and a refusal the
 * model cannot read is a refusal it will retry five times. `PermissionV2.denialMessage` is the single
 * place a denial becomes a sentence, so this delegates rather than re-wording it — and says WHAT is
 * unchanged, because "denied" alone leaves the colleague unsure whether its note was half-written.
 */
const toFailure = (error: unknown): ToolFailure => {
  if (error instanceof ToolFailure) return error
  const denial = PermissionV2.denialMessage(error)
  if (denial) return failure(`Durable area unchanged. ${denial}`)
  if (error instanceof SessionComponentRegistry.InvalidValueError)
    return failure(`Invalid durable item: ${error.message}`)
  return failure(error instanceof Error ? error.message : String(error))
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const components = yield* SessionComponentRegistry.Service
    const permission = yield* PermissionV2.Service
    const deps: Deps = { components, permission }

    const setTool = Tool.make({
      description:
        "Keep a short named item in this session's durable area: a place for the handful of facts that must " +
        "survive a context rewrite (a path that matters, a decision already made, what the user is waiting " +
        `for). The area holds at most ${Durable.DURABLE_ITEMS_MAX} items and is rebuilt into your system ` +
        "prompt after each compaction, so a write here reaches the prompt from the next rewrite onwards — read " +
        "it back sooner with the `session` tool (`kind: \"durable\"`). Reusing a name replaces that item. " +
        "Nothing is evicted for you: clear what you no longer need with `durable_clear`.",
      input: SetInput,
      output: Output,
      toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
      execute: (input, context) => set(deps, input, context).pipe(Effect.mapError(toFailure)),
    })

    const clearTool = Tool.make({
      description:
        "Remove one item from this session's durable area by name. Nothing is evicted automatically, so this is " +
        "how room is made once the area is full. The item leaves the shadow immediately; the block in your " +
        "system prompt drops it at the next compaction.",
      input: ClearInput,
      output: Output,
      toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
      execute: (input, context) => clear(deps, input, context).pipe(Effect.mapError(toFailure)),
    })

    /**
     * 🔴 DEFERRED, and the byte ratchet in `test/location-layer.test.ts` is why the question got asked
     * rather than assumed. A resident schema is paid on every turn of every session forever; deferred
     * costs one `tool_search` round-trip in the sessions that need it.
     *
     * *Which is this?* Occasional, like `log` and `community`: a colleague keeps a durable item when
     * something happens worth keeping — a decision made, a path it must not lose — not every turn. That
     * is the criterion the ratchet's own list states, and their only sibling (`session`, the generic
     * component tool) is deferred for the same reason. What replaces residency is the hint: the
     * `#DURABLE` block itself names both tools, so a session that has an area has already been told how
     * to maintain it.
     */
    yield* tools
      .register({ [name]: Tool.withDeferred(setTool), durable_clear: Tool.withDeferred(clearTool) })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/durable",
  layer,
  // `PermissionV2.node` is here because {@link charge} is what makes the kind's tier real — see the
  // header. Omitting it is the failure this file was written twice to avoid.
  deps: [ToolRegistry.node, PermissionV2.node, SessionComponentRegistry.node],
})

