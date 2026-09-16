export * as Durable from "./durable"

/**
 * The durable area's pure half: its LIMITS, how a name becomes a slot, and how the shadow copy
 * renders into the one block the model reads.
 *
 * ⚠️ Separate from `component-registry.ts` because the registry is the CODEC (shape, enforced) and
 * this is the spec and the WORDING, and wording is testable only when it is data — the same split
 * `project-copy.ts` uses for the same reason. Nothing here reads a store, a clock or the filesystem:
 * the render is a pure function of its items, which is what makes the area's bytes reproducible (and
 * therefore prefix-cache-stable) for a given shadow copy.
 *
 * 🔴 **The dependency runs ONE WAY: the registry imports this module, and this module imports
 * nothing.** A cycle here would be loaded-order-dependent and `tsgo` would stay green either way —
 * `config-tier.ts` records the measurement that cost (a `ReferenceError: Cannot access 'REDACTED'
 * before initialization` in one import order only). The codec needs these limits at module scope, so
 * the limits have to be below the codec, not beside it.
 */

/**
 * The area's limits, declared ONCE and shared by the codec, the tools and the tests.
 *
 * Owner, 2026-09-16: *"The area is limited to 10 items (Name can't be longer than 30 chars, Value
 * can't be longer than 512 chars)"*. The first two are enforced by the codec, which is the only door
 * every writer goes through — a limit enforced in one tool is a limit the next writer does not know
 * about, which is the "a gate on one door only is not a gate" rule the registry states for authority.
 * The ITEM COUNT cannot be seen from a codec (it is a property of the set, not of one value), so it
 * is enforced in the tool and pinned by a test.
 */
export const DURABLE_ITEMS_MAX = 10
export const DURABLE_NAME_MAX = 30
export const DURABLE_VALUE_MAX = 512

/**
 * The component id for a Name.
 *
 * 🔴 Why a slug rather than the name itself: component ids are `ComponentID`
 * (`^[a-z0-9][a-z0-9._:-]{0,127}$`), which cannot spell `Report format` or `API key` — the two names
 * a person actually types. Lower-casing and folding runs of anything else to `-` also means two
 * spellings of one name (`Report format`, `report_format`) land on ONE slot rather than two, which is
 * the reading a reader would expect from the rendered area and the wrong one to leave to chance.
 *
 * ⚠️ The fold is Unicode-aware on purpose. `\p{L}`/`\p{N}` keep a non-Latin name addressable at all;
 * folding to ASCII would make `名前` collide with every other all-symbol name and silently share one
 * slot between two unrelated items.
 */
export const keyOf = (name: string): string => {
  const folded = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._:-]+/gu, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
  // A name that folds away entirely (symbols only) still has to address SOMETHING: the item's own
  // name, hashed, so two distinct symbol names do not share a slot.
  return folded.length > 0 ? folded.slice(0, 128) : `item-${digestOf(name)}`
}

/**
 * A stable, short digest of a string, for the fold-away case above.
 *
 * ⚠️ Not a security primitive and not used as one: it only has to be STABLE across processes so a
 * `durable_clear` in a later turn addresses the same slot a `durable_set` created. FNV-1a, 32 bits,
 * rendered hex — the cheapest thing that is not `Math.random`.
 */
export const digestOf = (value: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/** One item, as the registry stores it. Structural, so this module does not import the codec. */
export interface Item {
  readonly id: string
  readonly name: string
  readonly value: string
}

/**
 * The materialised lines, in a DETERMINISTIC order.
 *
 * ⚠️ Sorted by id, never by insertion or database order. The block's whole reason for existing is to
 * be byte-stable between rewrites: a set that renders in a different order after a compaction would
 * change the prompt's tail for no reason a reader could see, and the item that changed would be
 * indistinguishable from the ones that merely moved. Sorting also makes the area's order independent
 * of which item the colleague happened to touch last.
 */
export const render = (items: readonly Item[]): string =>
  [...items]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => `${item.name}: ${item.value}`)
    .join("\n")

/**
 * The materialised text out of a `durable_prompt` value, read STRUCTURALLY.
 *
 * ⚠️ Structural rather than decoded through the codec, and that is the idiom this codebase already
 * uses for a per-session component read on the prompt path: `SessionDrive.assignedGoal` takes an
 * `unknown` component value and reads `.text` off it. The codec gates every WRITE, so a value that
 * does not look like this cannot exist without a component fault being raised where it belongs —
 * which is not the prompt composer, whose job is to decorate a prompt and never to cost the turn it
 * describes.
 */
export const textOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "text" in value ? String((value as { text: unknown }).text) : undefined

/**
 * Raw `durable` component rows as renderable items, dropping anything malformed.
 *
 * ⚠️ Same reasoning as {@link textOf}: this is the read side of a codec-gated write, and one dropped
 * row must not be able to take a turn down. Dropping is deliberately quiet HERE and loud at the
 * registry, which is the layer that owns the fault.
 */
export const itemsOf = (rows: readonly { readonly id?: unknown; readonly value: unknown }[]): readonly Item[] =>
  rows.flatMap((row) => {
    const value = row.value as { name?: unknown; value?: unknown } | null
    if (value === null || typeof value !== "object") return []
    if (typeof value.name !== "string" || typeof value.value !== "string") return []
    return [{ id: String(row.id ?? keyOf(value.name)), name: value.name, value: value.value }]
  })

/** What the colleague is told when a write is refused, so the refusal names the way forward. */
export const overLongValueNotice = (name: string, length: number): string =>
  `"${name}" is ${length} characters and the durable area holds at most ${DURABLE_VALUE_MAX}. ` +
  "Write the text to a file in your scratch folder and set the value to that path instead: a durable " +
  "item is a pointer you can follow, and the area is quoted into the prompt, so it has to stay short."

export const nameTooLongNotice = (name: string): string =>
  `A durable item's name is at most ${DURABLE_NAME_MAX} characters; "${name}" is ${name.length}. ` +
  "Shorten it — the name is what the area renders as the label, and a long one pushes the values out " +
  "of the reader's view."

/**
 * The refusal when the area is already full.
 *
 * ⚠️ It lists what is IN the area rather than evicting the "oldest" itself. The owner's invariant says
 * the colleague keeps the *ten most important* items: importance is the agent's judgement, and a
 * harness that silently drops an item to make room is a harness that deletes a fact the agent chose
 * to keep. So the write fails and the refusal hands back the menu.
 */
export const areaFullNotice = (items: readonly Item[]): string =>
  `The durable area already holds ${items.length} items, which is its limit. Clear one first ` +
  `(\`durable_clear\`), then set this one. It currently holds: ${items.map((item) => item.name).join(", ")}.`
