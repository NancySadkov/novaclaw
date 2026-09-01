/**
 * The ONE plain-record narrowing. Excludes arrays so a JSON "object" check does not accept a tuple
 * as a key/value bag.
 *
 * ⚠️ **Why it lives in the schema leaf and not somewhere more obvious.** `packages/llm` does not
 * depend on `@novaclaw/core` (core depends on llm), `packages/app` does not depend on
 * `packages/novaclaw`, and `@novaclaw/schema` is the only `@novaclaw/*` package that `app`, `core`,
 * `llm` and `novaclaw` ALL declare. So a predicate all four need has exactly one legal home, and
 * this is it — the same argument, and the same shape, as `./text.ts`. Check the manifests before
 * proposing a different one.
 *
 * 🔴 **This predicate is DELIBERATELY loose: `Date`, `Map`, `RegExp` and class instances pass.** It
 * answers *"can I index this with a string key?"*, not *"is this a literal `{}`?"*. Three sites in
 * this tree ask a DIFFERENT question and must not be folded in here — each carries a comment at its
 * own site saying so:
 *
 * - `core/src/observability/logging.ts` (`plain`) adds a PROTOTYPE check, because a `Date` must be
 *   formatted as a leaf value rather than flattened into `.getTime` keys.
 * - `core/src/merge-patch.ts` (`isPlainObject`) is the same expression today under a different
 *   CONTRACT — it documents that `Schema.Class` instances *must* qualify, because its callers spread
 *   them — so it is allowed to diverge from this one and this one is not allowed to drag it along.
 * - `app/src/addons/serialize.ts` omits the array guard on purpose.
 *
 * ⚠️ **The `!!value` vs `value !== null` "divergence" that this consolidation was filed over does
 * not exist.** Both forms were run over 28 shapes on 2026-09-01 — including the three that could
 * plausibly separate them, `new Boolean(false)`, `new Number(0)` and `new String("")`, all truthy
 * objects — with zero disagreements. They cannot differ: the only falsy value whose `typeof` is
 * `"object"` is `null`, and both reject it. The copies were unified because a future reader
 * "fixing" one of them is the real risk, not because either was wrong. `record.test.ts` pins the
 * whole shape table so that stays true.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
