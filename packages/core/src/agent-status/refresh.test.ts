import { expect, test } from "bun:test"
import { REFRESH_INTERVAL_MS, due, shouldRefresh, type Candidate } from "./refresh"

const HOUR = 60 * 60 * 1000
const now = 1_000 * HOUR

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  agent: "theron",
  latest: now - HOUR,
  current: { observed: now - 10 * HOUR },
  ...over,
})

test("🔴 a colleague with no activity gets no status at all", () => {
  // Never invent a label. A colleague nobody has talked to has no task, and a guessed line in
  // Contacts is words put in its mouth — the thing the retired session title did when it showed
  // "New session" for a chat that had never been used.
  expect(shouldRefresh(candidate({ latest: undefined, current: undefined }), now)).toBe(false)
  expect(shouldRefresh(candidate({ latest: undefined }), now)).toBe(false)
})

test("🔴 the FIRST label does not wait for the interval", () => {
  // The moment a colleague starts working is exactly when the user most wants to see what it is
  // doing. Making them wait three hours for the first line would make this look broken on day one.
  expect(shouldRefresh(candidate({ current: undefined, latest: now - 1 }), now)).toBe(true)
})

test("🔴 a label that already covers the newest activity is not re-derived", () => {
  // The control for the interval test below: without this, a colleague that STOPPED working would
  // spend a model call every interval, forever, writing the same sentence.
  const settled = { latest: now - 50 * HOUR, current: { observed: now - 50 * HOUR } }
  expect(shouldRefresh(candidate(settled), now)).toBe(false)
  // Even older activity than the label — a clock skew or a re-read — is still not newer.
  expect(shouldRefresh(candidate({ latest: now - 60 * HOUR, current: { observed: now - 50 * HOUR } }), now)).toBe(false)
})

test("new activity still waits for the interval", () => {
  const justWritten = { latest: now - 1, current: { observed: now - 1 * HOUR } }
  expect(shouldRefresh(candidate(justWritten), now)).toBe(false)
})

test("the interval boundary is inclusive", () => {
  const at = { latest: now - 1, current: { observed: now - REFRESH_INTERVAL_MS } }
  expect(shouldRefresh(candidate(at), now)).toBe(true)
  const just = { latest: now - 1, current: { observed: now - REFRESH_INTERVAL_MS + 1 } }
  expect(shouldRefresh(candidate(just), now)).toBe(false)
})

test("🔴 the stalest colleague is refreshed first", () => {
  /**
   * Order is not cosmetic. A pass that runs out of budget — a model that is down, a shutdown
   * mid-sweep — must leave the STALEST lines unrefreshed rather than a random subset, or successive
   * passes thrash over the same few colleagues and the oldest line never updates.
   */
  const stale = candidate({ agent: "stale", latest: now - 1, current: { observed: now - 90 * HOUR } })
  const fresher = candidate({ agent: "fresher", latest: now - 1, current: { observed: now - 4 * HOUR } })
  const first = candidate({ agent: "first", latest: now - 1, current: undefined })

  expect(due([fresher, stale, first], now).map((c) => c.agent)).toEqual(["first", "stale", "fresher"])
})

test("due() returns nothing when nothing qualifies", () => {
  const quiet = candidate({ latest: undefined, current: undefined })
  const settled = candidate({ latest: now - 50 * HOUR, current: { observed: now - 50 * HOUR } })
  expect(due([quiet, settled], now)).toEqual([])
})
