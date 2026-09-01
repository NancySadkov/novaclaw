/**
 * ALIAS, not a copy. The monotonic-ID algorithm lives once, in
 * `@novaclaw/schema/identifier`, and `@novaclaw/core/id/id` owns the prefix table over it.
 *
 * The renderer used to carry its own copy with its own prefix table and its own randomness source,
 * which fell back to `Math.random()` when `globalThis.crypto` was missing — a fallback that never
 * fires (`crypto.getRandomValues` is available on insecure origins too) and would have been a
 * silent downgrade if it did. The ids minted here (`msg_…`) travel to the server and are sorted
 * beside ids the server minted, so the two sides must agree on the algorithm by construction.
 */
export { Identifier } from "@novaclaw/core/id/id"
