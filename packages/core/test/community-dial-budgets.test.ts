import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { CommunitySync } from "@novaclaw/core/community/sync"
import { MAX_ANSWER_BYTES, MAX_PEER_RESPONSE_BYTES } from "@novaclaw/core/community/transport"

/**
 * 🔴 **Every route `sync.ts` dials, and what it costs the peer — derived, not remembered.**
 *
 * Three defects in one day shared a shape: *a bound copied from a neighbouring route inherits that
 * route's shape, not its correctness.* The ten-second request budget is right for a summary, a page
 * of ids, a DM ack — database reads — and far too short for a model turn, so `askPeer` gave up before
 * an honest instance could reply. The four-megabyte ceiling is derived from 256 messages at 8 KB and
 * absurd for one sentence. **Both were correct where they were written.**
 *
 * ⚠️ So the classification is the mechanism. A route added later fails here until somebody says which
 * kind it is, which is the only thing that stops the next one inheriting a default nobody chose for
 * it. The checklist's own meta-rule: *derive, never list by hand.*
 *
 * ⚠️ SCOPE: the routes `sync.ts` dials, derived from its own exports. `search.ts` is the other
 * dialling file and has its own ledger (`community-search.test.ts`) requiring it to use the shared
 * size guard — said here because "every route we dial" would otherwise read as a claim this file
 * cannot make, and a ledger that overstates its reach is how the next gap hides.
 */

const source = readFileSync(new URL("../src/community/sync.ts", import.meta.url), "utf8")

/**
 * What each dialled route costs the PEER that answers it.
 *
 * `read` — it is answered from their database. Fast, small, and the shared defaults fit.
 * `turn`  — it costs them a MODEL TURN. Needs its own time budget and its own size ceiling, because
 *           neither of the defaults was derived from anything like it.
 */
const COST: Record<string, "read" | "turn"> = {
  IDENTITY_PATH: "read",
  DM_PATH: "read",
  SUCCESSION_PATH: "read",
  LISTED_PATH: "read",
  PEERS_PATH: "read",
  OFFER_PATH: "read",
  SYNC_SUMMARY_PATH: "read",
  SYNC_IDS_PATH: "read",
  SYNC_MESSAGES_PATH: "read",
  /** The only one, and the reason both overrides exist. */
  ASK_PATH: "turn",
}

/** Every `*_PATH` this module exports — the set the classification must cover exactly. */
const exported = [...source.matchAll(/export const ([A-Z_]+_PATH) = /g)].map((match) => match[1]!)

describe("every dialled route is classified by what it costs the peer", () => {
  test("🔴 the classification covers the exported routes EXACTLY", () => {
    /**
     * Both directions. A missing key is the case that matters — a new route must not inherit the
     * read-shaped defaults by omission — and an extra key means a route was removed while its claim
     * stayed, which is how a ledger starts describing a program that no longer exists.
     */
    expect(exported.length, "the scan must find the routes at all").toBeGreaterThan(5)
    expect([...exported].sort()).toEqual(Object.keys(COST).sort())
  })

  test("🔴 only a `turn` route overrides the shared budgets", () => {
    /**
     * ⚠️ The overrides are extra arguments to the shared `ask` helper, so this reads the CALLS. A
     * read-shaped route that quietly grew its own budget would be a second place where "how long may
     * a peer take" is decided, which is exactly how the two numbers drifted apart in the first place.
     */
    const overriding = [...source.matchAll(/ask\(\s*[^)]*?([A-Z_]+_PATH)[^)]*?(ANSWER_TIMEOUT_MS|MAX_ANSWER_BYTES)/gs)]
      .map((match) => match[1]!)
      .filter((path, index, all) => all.indexOf(path) === index)

    for (const path of overriding) {
      expect(COST[path], `${path} passes its own budget, so it must be classified as a model turn`).toBe("turn")
    }
    // And the turn route must actually carry BOTH overrides — a time budget without a size ceiling
    // leaves the half that a hostile peer controls.
    expect(source).toContain("ANSWER_TIMEOUT_MS")
    expect(source).toContain("MAX_ANSWER_BYTES")
  })

  test("⚠️ and the control: the scan can SEE an override", () => {
    // Otherwise the loop above passes against a regex that matches nothing at all.
    const planted = 'const reply = yield* ask(address, ASK_PATH, payload, Reply, "POST", ANSWER_TIMEOUT_MS)'
    const seen = [...planted.matchAll(/ask\(\s*[^)]*?([A-Z_]+_PATH)[^)]*?(ANSWER_TIMEOUT_MS|MAX_ANSWER_BYTES)/gs)]
    expect(seen.map((match) => match[1])).toEqual(["ASK_PATH"])
  })
})

describe("the numbers themselves", () => {
  test("🔴 a model turn gets more time and LESS room than a page of messages", () => {
    /**
     * The asymmetry is the point, and it is easy to get backwards. A turn takes longer to produce
     * (so a bigger time budget) and produces less (so a smaller size ceiling). Copying either number
     * from a read-shaped route gets exactly one of them wrong.
     */
    expect(CommunitySync.ANSWER_TIMEOUT_MS).toBeGreaterThan(10_000)
    expect(MAX_ANSWER_BYTES).toBeLessThan(MAX_PEER_RESPONSE_BYTES)
    // Room for a long answer — the answering side is bounded by maxTokens, ~8 KB of text.
    expect(MAX_ANSWER_BYTES).toBeGreaterThan(8 * 1024)
  })
})
