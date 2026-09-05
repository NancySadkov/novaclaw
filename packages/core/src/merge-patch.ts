export * as MergePatch from "./merge-patch"

/**
 * ─── the deletion ruling, recorded where the merge lives ────────────────────────────────────────
 *
 * **`null` is a VALUE here, never a tombstone, and that is now a decision rather than an omission**
 * (v0.2.0 item 4.3, 2026-08-07). RFC-7396 merge-patch spends `null` to mean *remove this key*; this
 * implementation deliberately does not, and deletion is a **separate verb** taking explicit paths
 * (`ConfigStoreWrite.remove`, `POST /api/config/remove`) rather than a magic value inside the
 * document.
 *
 * 🔴 **One premise below is FALSE on the wire, and the conclusion survives anyway — read both.**
 * Measured live 2026-08-12: `PATCH /global/config {"memory":{"embedding":null}}` answered **200 with
 * the value unchanged**. The decode argument that follows holds on the TYPE side
 * (`decodeUnknownSync(Config.Info)` throws *"Expected boolean | undefined, got null"*) and fails on
 * the ENCODED side, which is the one an `HttpApiEndpoint` payload actually decodes: there the union is
 * `boolean | null`, as that route's own 400 for a mistyped value says out loud. So `null` was legal
 * input and decoded to ABSENT — the merge saw no key and did nothing, silently. The ruling is
 * unchanged (a tombstone would still have to widen every deletable slot's schema); what changed is
 * that the wire now REFUSES a `null` by name and names the remove verb
 * (`rejectNullConfigValues`, `NULL_CONFIG_VALUE_KIND`). **A decode cited as a guarantee must say
 * which direction it runs in.**
 *
 * ⚠️ **The `null`-ambiguity answer, stated explicitly because it is the whole question.** The usual
 * objection to RFC-7396 is soft — *a config value might legitimately be null, so the tombstone is
 * ambiguous*. Here the objection is hard: a tombstone has to be a legal value of the slot it is
 * deleting, and on the TYPE side it is not, anywhere that matters:
 *   · `mcp.servers.<name>` is `Schema.Record(String, Union([Local, Remote]))` tagged on `type` —
 *     `null` matches no branch and fails the decode;
 *   · `providers.<id>.models.<id>` is `Record(String, Model)` — same;
 *   · `default_agent` is `Schema.String.pipe(Schema.optional)` — `null` cannot decode either, which
 *     is exactly what commit `53051cca8` found when it discovered the key was WRITE-ONLY.
 * So adopting `null`-deletion is not a change to this function: it is a change to **every deletable
 * slot's schema**, each widened to `Union([X, Null])`, which permanently makes `null` a legal
 * inhabitant of the wire type, pushes `T | null` through the generated SDK to every consumer, and
 * hands us the RFC's ambiguity for real instead of avoiding it. We would be *creating* the ambiguity
 * in order to work around it. The value channel therefore stays un-overloaded: a value means the
 * value, and removal is said out loud.
 *
 * ⚠️ **A path is a SEGMENT ARRAY, never a dotted string** — see {@link removeAt}.
 */

/**
 * One location in the config document: one string per level.
 *
 * ⚠️ **Not a dotted string, and that is forced rather than stylistic.** Config keys routinely
 * contain the separators a flat path syntax would need: model ids carry dots AND slashes
 * (`holo3.1`, `openai/gpt-oss-120b`, `hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL`), MCP server
 * names are user-chosen, and header names inside `providers.<id>.api.headers` are arbitrary. A
 * dotted `providers.spark-holo.models.holo3.1` splits into FIVE segments and names nothing — it
 * would report "no such path" for a model that is sitting right there, or worse, with an escaping
 * scheme, quietly target a different key. `catalog/model-prune.ts` records the same trap from the
 * other side (`refNamesModel` splits on the FIRST slash only). Segments are unambiguous and need no
 * escape syntax at all.
 */
export type Path = ReadonlyArray<string>

/** Render a path for a human-facing message. Display only — never parse this back. */
export const showPath = (path: Path): string => path.map((segment) => JSON.stringify(segment)).join(" → ")

/**
 * Remove `path` from a plain-object tree, structurally — the input is not mutated.
 *
 * Returns `undefined` when the path names nothing, and that distinction is the entire point of the
 * return type, for the same reason `ModelPrune.stripModel` has it: **a caller that cannot tell
 * "removed" from "was never there" has to report success either way**, which is the
 * failed-mutation-reports-success shape todo.md ruling 2 forbids. Every caller here turns
 * `undefined` into a named refusal, not a cheerful no-op.
 *
 * ⚠️ **It refuses to descend into or delete out of an ARRAY, deliberately.** Arrays replace
 * wholesale under the merge contract, so `PATCH /config` can already delete an array entry by
 * sending the array without it — commit `53051cca8` ruled on exactly this and left `skills`
 * (and, while it existed, `plugins`) without delete routes for that reason. Supporting an index segment here would add a
 * second way to do a thing that already works, with an off-by-one and a "what does removing index 2
 * of a list someone else just appended to mean" race attached. The refusal surfaces as
 * `undefined`; the callers' ledger names the key and says what to send instead.
 */
export function removeAt(base: unknown, path: Path): { readonly value: unknown } | undefined {
  if (path.length === 0) return undefined
  if (!isPlainObject(base)) return undefined
  const [head, ...rest] = path as [string, ...string[]]
  if (!Object.prototype.hasOwnProperty.call(base, head)) return undefined
  if (rest.length === 0) {
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(base)) if (key !== head) next[key] = value
    return { value: next }
  }
  const inner = removeAt((base as Record<string, unknown>)[head], rest)
  if (inner === undefined) return undefined
  return { value: { ...(base as Record<string, unknown>), [head]: inner.value } }
}

/** A mergeable/prunable object: not null, not an array. Schema.Class instances qualify — their
 *  fields are own enumerable properties, so a spread reproduces them.
 *
 *  🔴 **Deliberately NOT `@novaclaw/schema/record` (, 2026-09-01), even though the expression
 *  is identical today.** This is a CONTRACT, not a copy: the sentence above is a promise to the
 *  callers that spread these values, and it is allowed to diverge from the shared predicate — which
 *  is free to tighten — without anything noticing. Importing would silently couple that promise to
 *  a decision made in another package. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Deep patch-merge with the updateConfig contract: objects merge recursively, arrays and
 * primitives replace. A LEAF module (no imports) — shared by the config write router and the
 * settings seed without creating an import cycle through config.ts.
 *
 * ⚠️ `null` SETS null (see the ruling at the top of this file); it does not delete.
 */
export function mergePatch(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (
    base === null ||
    patch === null ||
    typeof base !== "object" ||
    typeof patch !== "object" ||
    Array.isArray(base) ||
    Array.isArray(patch)
  ) {
    return patch
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    result[key] = key in result ? mergePatch(result[key], value) : value
  }
  return result
}
