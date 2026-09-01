/**
 * ALIAS, not a copy. The monotonic-ID algorithm lives once, in
 * `@novaclaw/schema/identifier`, and `@novaclaw/core/id/id` owns the prefix table over it.
 *
 * This module used to carry its own copy of the algorithm with its own `lastTimestamp`/`counter`
 * pair. `packages/novaclaw` imports `@novaclaw/core`, so both counters ran in the SAME process:
 * two ids minted in the same millisecond from the two modules each got `counter = 1` and therefore
 * an identical 12-hex time prefix, leaving their relative order to the random tail. "Ascending" is
 * a per-process guarantee or it is not a guarantee, so there is one counter.
 */
export { ascending, create, descending, Identifier } from "@novaclaw/core/id/id"
