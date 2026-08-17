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

/**
 * Every `ask(…)` call in the file, argument text included, read by BALANCED PARENTHESES.
 *
 * ⚠️ A regex cannot do this and that is the whole point of the helper: the argument list of the one
 * call this ledger exists to check contains `Math.max(1, Math.min(deadline - Date.now(), …))`, so
 * any `[^)]` character class stops three nested calls early. Scanning for the matching close paren
 * is exact and does not care how the arguments are formatted or wrapped across lines.
 */
const askCalls = (text: string): ReadonlyArray<string> => {
  const out: string[] = []
  const opener = /\bask\(/g
  for (const match of text.matchAll(opener)) {
    let depth = 0
    let index = match.index + match[0].length - 1
    const start = index
    for (; index < text.length; index++) {
      const char = text[index]
      if (char === "(") depth++
      else if (char === ")") {
        depth--
        if (depth === 0) break
      }
    }
    out.push(text.slice(start, index + 1))
  }
  return out
}

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

  test("🔴 exactly the `turn` routes override the shared budgets — both directions", () => {
    /**
     * ⚠️ The overrides are extra arguments to the shared `ask` helper, so this reads the CALLS. A
     * read-shaped route that quietly grew its own budget would be a second place where "how long may
     * a peer take" is decided, which is exactly how the two numbers drifted apart in the first place.
     *
     * 🔴 **The previous version of this test asserted NOTHING (review 2026-08-17, finding 1.19).**
     * It matched call arguments with `[^)]*?`, which cannot cross a `)` — and the one real call it
     * exists to check reads
     *
     *     ask(address, ASK_PATH, payload, AnswerReply, "POST",
     *         Math.max(1, Math.min(deadline - Date.now(), ANSWER_TIMEOUT_MS)), MAX_ANSWER_BYTES)
     *
     * so `Date.now()` ended the match before `ANSWER_TIMEOUT_MS` was reached. The list came out
     * EMPTY and the loop over it ran zero times. The control below then "proved" the scan worked by
     * matching a hand-written string with no nested call in it — a control that validated a path,
     * not the experiment.
     *
     * So the calls are now read by balanced parentheses, the assertion runs in both directions, and
     * the count of calls found is asserted against the routes themselves.
     */
    for (const call of askCalls(source)) {
      const path = [...call.matchAll(/\b([A-Z_]+_PATH)\b/g)].map((match) => match[1]!)[0]
      if (path === undefined) continue
      const overrides = /ANSWER_TIMEOUT_MS|MAX_ANSWER_BYTES/.test(call)
      if (overrides)
        expect(COST[path], `${path} passes its own budget, so it must be classified as a model turn`).toBe("turn")
      else expect(COST[path], `${path} is a model turn and must NOT run on the read-shaped defaults`).toBe("read")
    }

    // The turn route must carry BOTH — a time budget without a size ceiling leaves the half a
    // hostile peer controls — and it must be a call, not a mention.
    const turnCalls = askCalls(source).filter((call) => /\bASK_PATH\b/.test(call))
    expect(turnCalls.length, "the ask route must actually be dialled").toBe(1)
    expect(turnCalls[0]).toContain("ANSWER_TIMEOUT_MS")
    expect(turnCalls[0]).toContain("MAX_ANSWER_BYTES")
  })

  test("⚠️ and the control: the scan SEES the real calls, nested parentheses and all", () => {
    /**
     * The half that was missing. A scan that finds nothing satisfies every "for each match" loop, so
     * the number of calls it recovers from the REAL file is the only thing that can say it worked —
     * a planted string cannot, because the defect was that the real text has a shape the planted one
     * did not.
     */
    const calls = askCalls(source)
    expect(calls.length, "sync.ts dials every classified route at least once").toBeGreaterThanOrEqual(
      Object.keys(COST).length,
    )
    // The nested-call shape that defeated the old regex, recovered whole.
    expect(calls.some((call) => call.includes("Date.now()") && call.includes("ANSWER_TIMEOUT_MS"))).toBe(true)
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
