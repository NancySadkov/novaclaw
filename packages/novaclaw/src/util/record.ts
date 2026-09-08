/**
 * Plain-record narrowing. Excludes arrays so JSON object checks don't accept tuples as key/value bags.
 *
 * ⚠️ **This was a deliberate SECOND copy of `packages/llm/src/utils/record.ts` until 2026-09-01; it
 * is now the shared predicate under this package's local name** (). The argument for keeping
 * two copies was that sharing three lines cost either a new export on `@novaclaw/llm`'s published
 * surface or a `record.ts` inside a package that holds schema definitions. The second of those is
 * what was built — `@novaclaw/schema/record`, beside the existing `@novaclaw/schema/text`, which is
 * the same argument already settled the same way — and it now serves twelve other sites, so it is
 * no longer a module that exists to save three lines.
 *
 * ⚠️ **What was fixed before that was the DIVERGENCE, which turned out not to be one.** This copy
 * read `!!value && typeof value === "object"` where the other read `typeof value === "object" &&
 * value !== null`. Run over 28 shapes on 2026-09-01 — including the three that could plausibly
 * separate them, `new Boolean(false)`, `new Number(0)` and `new String("")`, all truthy objects —
 * zero disagreements. That A/B is now a standing test, not a one-off script:
 * `packages/schema/src/record.test.ts`.
 *
 * 🔴 A THIRD predicate exists on purpose and must not be folded in: `core/src/merge-patch.ts`'s
 * `isPlainObject` documents that `Schema.Class` instances must qualify, because its callers spread
 * them. Same expression today, different CONTRACT — it is allowed to diverge and this one is not.
 *
 * (Originally inlined from the removed TUI package's `util/record`. TUI retired; HTML-UI-only.)
 */
export { isRecord } from "@novaclaw/schema/record"
