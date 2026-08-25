import { expect, test } from "bun:test"
import { KbClaim } from "@novaclaw/core/kb-graph/claim"
import { EVIDENCE_KINDS, MemoryGroup, PERSON_CLAIM_STATUSES } from "@novaclaw/protocol/groups/memory"

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
