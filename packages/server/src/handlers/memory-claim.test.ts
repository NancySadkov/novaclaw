import { expect, test } from "bun:test"
import { KbClaim } from "@novaclaw/core/kb-graph/claim"
import { CLAIM_PREDICATES, EVIDENCE_KINDS, MemoryGroup, PERSON_CLAIM_STATUSES } from "@novaclaw/protocol/groups/memory"

/**
 * ─── THE CLAIM ENDPOINTS' VOCABULARIES, DERIVED RATHER THAN TRUSTED ──────────────────────────────
 *
 * `@novaclaw/protocol` depends on `@novaclaw/schema` and nothing else, while `KbClaim` lives in
 * core — so `/api/memory/claim`'s evidence kinds and `/api/memory/claim/status`'s statuses are
 * hand-kept COPIES of vocabularies defined somewhere the group cannot import.
 *
 * 🔴 A hand-kept subset of a vocabulary goes stale silently, and it goes stale in the direction that
 * looks fine: adding `commit` to `EVIDENCE_KINDS` leaves the endpoint rejecting it with a 400 that
 * reads exactly like a caller mistake. This package can see both, so the two are compared here
 * instead of either being trusted.
 */

test("🔴 the claim endpoint's predicates are exactly KbClaim's closed table", () => {
  // A predicate outside the table is not an error — `conflictKey` returns undefined, the claim is
  // written with no identity, and the caller gets a 200 saying `identified: false`. Measured: three
  // claims about one subject sent with `predicate: "opening hours"` produced three simultaneously
  // current answers and no supersession. The endpoint offers the list so a wrong value is a 400.
  expect(CLAIM_PREDICATES.length).toBeGreaterThan(0)
  expect([...CLAIM_PREDICATES].toSorted()).toEqual([...KbClaim.CLAIM_PREDICATE_NAMES].toSorted())
})

test("⚠️ at least one predicate on each side of the cardinality split, so the union cannot silently lose a half", () => {
  const single = CLAIM_PREDICATES.filter((one) => KbClaim.CLAIM_PREDICATES[one] === "single")
  const multi = CLAIM_PREDICATES.filter((one) => KbClaim.CLAIM_PREDICATES[one] === "multi")
  // `single` is what supersession keys on; `multi` is what must never auto-correct. An endpoint that
  // offered only one kind would be a different feature wearing this one's name.
  expect(single.length).toBeGreaterThan(0)
  expect(multi.length).toBeGreaterThan(0)
})

test("🔴 the claim endpoint's evidence kinds are exactly KbClaim.EVIDENCE_KINDS", () => {
  // Not vacuous: an empty list would make the comparison trivially true, which is how a guard of
  // this shape rots into a no-op.
  expect(EVIDENCE_KINDS.length).toBeGreaterThan(0)
  expect([...EVIDENCE_KINDS].toSorted()).toEqual([...KbClaim.EVIDENCE_KINDS].toSorted())
})

test("🔴 the status endpoint offers exactly the statuses a PERSON controls — never `superseded`", () => {
  expect(PERSON_CLAIM_STATUSES).not.toContain("superseded")
  expect([...PERSON_CLAIM_STATUSES].toSorted()).toEqual(["active", "archived", "needs_review"])
  // …and every one of them is a status the store itself knows, so the endpoint cannot offer a state
  // the engine would refuse.
  for (const status of PERSON_CLAIM_STATUSES) expect(KbClaim.CLAIM_STATUSES).toContain(status)
})

test("both new endpoints are on the ONE contract, under /api", () => {
  const paths = Object.values(MemoryGroup.endpoints).map((one) => (one as { readonly path: string }).path)
  expect(paths).toContain("/api/memory/claim")
  expect(paths).toContain("/api/memory/claim/status")
  // Ruling 11: the legacy `/memory/*` surface may only SHRINK, so nothing here may live outside /api.
  for (const path of paths) expect(path.startsWith("/api/")).toBe(true)
})
