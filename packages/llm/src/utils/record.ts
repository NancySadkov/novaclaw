/**
 * Plain-record narrowing. Excludes arrays so JSON object checks don't accept tuples as key/value bags.
 *
 * ⚠️ **This was a hand-rolled copy until 2026-09-01; it is now the shared predicate under this
 * package's local name** (). The earlier decision to keep it a copy rested on a premise that
 * no longer holds: there was no home `llm` and `novaclaw` shared *worth the trade*, since the only
 * `@novaclaw/*` dependency they have in common is `@novaclaw/schema`. That home now exists —
 * `@novaclaw/schema/record`, beside `@novaclaw/schema/text`, which is the same argument settled the
 * same way — and twelve other sites moved onto it, so the trade is no longer three lines against a
 * new module.
 *
 * The five local importers keep importing `../utils/record`; only the body moved. The shape table
 * that pins its behaviour (including the falsified `!!value` divergence and the two contracts that
 * must NOT be folded in) is `packages/schema/src/record.test.ts`.
 */
export { isRecord } from "@novaclaw/schema/record"
