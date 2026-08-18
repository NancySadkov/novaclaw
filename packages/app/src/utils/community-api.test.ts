import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * 🔴 Review 1.15 — **one failed read took the whole application down.**
 *
 * Every community resource used a bare `instanceFetch`, which throws on any non-2xx, and a throw
 * inside a `createResource` read propagates to the nearest ErrorBoundary — the ROOT one. So a single
 * 500 from any of about fifteen endpoints replaced the app with `ErrorPage`, and the user lost their
 * chats, sessions and settings because a peer list did not load.
 *
 * ⚠️ A SOURCE ledger, and it says so: proving "the app survives a 500 from `/api/community/contact`"
 * needs the real router and the real boundary, which this package's tests do not stand up. What it
 * can prove is that every read-shaped endpoint goes through the degrading helper and every action
 * does not — the distinction the fix rests on.
 */
const source = readFileSync(new URL("./community-api.ts", import.meta.url), "utf8")
// ⚠️ Comments stripped: this file's own prose names both `softRead` and `instanceFetch` repeatedly,
// and a scan over raw source would count the explanation as the code.
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

/** Every exported function and the body it returns, so each can be classified. */
const functions = [...code.matchAll(/export function (community\w+)\([\s\S]*?\n\}/g)].map((match) => ({
  name: match[1]!,
  body: match[0],
}))

/**
 * Reads degrade; actions report. A read that fails can show nothing and let the user carry on; a
 * write that fails must be reported, because silently swallowing "your message was not posted" is a
 * worse lie than any error screen.
 */
const READS = new Set([
  "communityTransportState",
  "communityContacts",
  "communityChannels",
  "communityOffers",
  "communityParticipation",
  "communityMyOffer",
  "communityConversations",
  "communityFilters",
  "communityArchivedChannels",
  "communityNearbyChannels",
])

describe("a failed community read degrades; a failed action is reported", () => {
  test("🔴 the scan finds the endpoints at all", () => {
    // An empty list satisfies every loop below — the guard that stops this ledger going vacuous when
    // the file is reorganised.
    expect(functions.length).toBeGreaterThan(20)
    for (const name of READS)
      expect(
        functions.some((entry) => entry.name === name),
        `${name} must still exist to be classified`,
      ).toBe(true)
  })

  test("🔴 every READ-shaped endpoint degrades instead of throwing into the ErrorBoundary", () => {
    for (const entry of functions)
      if (READS.has(entry.name))
        expect(entry.body, `${entry.name} is a read and must not take the app down`).toContain("softRead(")
  })

  test("🔴 and every ACTION still throws, so a failed write is never swallowed", () => {
    for (const entry of functions)
      if (!READS.has(entry.name))
        expect(entry.body, `${entry.name} changes something — its failure must reach the user`).not.toContain(
          "softRead(",
        )
  })
})
