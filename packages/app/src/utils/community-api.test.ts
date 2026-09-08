import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { stripComments } from "@/utils/strip-comments"

/**
 * 🔴 **Nothing in the community client swallows a failure, and the page that reads it can tell a
 * failure from an empty answer.**
 *
 * The first repair of *"one failed read took the whole application down"* wrapped every read in a
 * `softRead` helper that caught, warned and returned a fallback. It closed the crash and opened a
 * quieter defect: the fallback is the same value a successful empty answer produces, so an instance
 * that could not be asked rendered as a community with nobody in it — and, because participation's
 * fallback was `undefined` and the panel's door read `undefined` as *joined*, as a community the
 * user was told they had joined. AGENTS.md: **joining is a decision, not a default.**
 *
 * ⚠️ A SOURCE ledger, and it says so. Proving *"the app survives a 500 from
 * `/api/community/contact`"* needs the real router and the real boundary, which this package's tests
 * do not stand up; `test-browser/community-calendar-degraded-render.test.tsx` mounts the panel and
 * proves the three renderings. What this file proves is the pair of structural facts those
 * renderings rest on: **no handler here invents a value**, and **every read is held in a
 * `createSettledResource`** — the wrapper whose accessor cannot throw and whose `failed` is distinct
 * from an empty answer.
 */
const API_SOURCE = readFileSync(new URL("./community-api.ts", import.meta.url), "utf8")
const PANEL_SOURCE = readFileSync(
  new URL("../pages/home-screen/community-network.tsx", import.meta.url),
  "utf8",
)

/**
 * ⚠️ Comments stripped before ANY match. Both files document this very defect in prose — the words
 * `catch`, `createResource` and `softRead` all appear in explanations of what not to write — and a
 * regex over raw source counts the explanation as the code.
 */
const api = stripComments(API_SOURCE)
const panel = stripComments(PANEL_SOURCE)

/** Every exported function and the body it returns, so each can be classified. */
const functions = [...api.matchAll(/export function (community\w+)\([\s\S]*?\n\}/g)].map((match) => ({
  name: match[1]!,
  body: match[0],
}))

/**
 * The read-shaped endpoints. Kept as a list rather than derived, because the property under test is
 * exactly that somebody looked at each one and said which it is.
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
  "communityChannelHistory",
  "communityDirectHistory",
])

/** `createResource(` as a CALL — the lookbehind rejects `createSettledResource(`. */
const BARE_RESOURCE = /(?<![A-Za-z0-9_$.])createResource\s*\(/g

describe("the community client never invents a value for a failed read", () => {
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

  test("🔴 no endpoint catches its own rejection — reads and actions alike", () => {
    // Reads: a swallowed rejection is invisible to `failed`, and the panel renders it as empty.
    // Actions: a swallowed rejection tells the user their message was posted when it was not.
    // Ruling 2 forbids both halves, so the file-wide rule is the simpler and stronger one.
    const offenders = functions.filter(
      (entry) => /\.catch\s*\(/.test(entry.body) || /\bcatch\s*(?:\([^()]*\))?\s*\{/.test(entry.body),
    )
    expect(offenders.map((entry) => entry.name)).toEqual([])
  })

  test("🔴 and no swallow anywhere else in the module either", () => {
    // The helper this replaced lived at module scope, outside every `export function` body, so a
    // per-function scan would not have seen it. This is the assertion that keeps it gone.
    expect(api).not.toContain("softRead")
    expect(/\.catch\s*\(/.test(api)).toBe(false)
    expect(/\bcatch\s*(?:\([^()]*\))?\s*\{/.test(api)).toBe(false)
  })

  test("🔴 the only consumer holds every read in a createSettledResource", () => {
    // Because these now reject, an unguarded `createResource` would put the ROOT ErrorBoundary crash
    // back — the original defect. `createSettledResource` is what keeps the accessor total while
    // still reporting the outage, and this is the door that stops a fourteenth read arriving bare.
    expect(panel.match(BARE_RESOURCE)).toBeNull()
    expect(panel).toContain("createSettledResource(")

    // Thirteen, and stated as a number rather than "at least one": this is the count the
    // settled-resource ledger lowered to zero on the other side of the same conversion, so the two
    // files disagree loudly if a read is ever quietly dropped or added.
    expect(panel.match(/createSettledResource\(/g)?.length ?? 0).toBe(13)
  })

  test("🔴 the door does not read a missing answer as JOINED", () => {
    // The sharpest half of the defect, pinned as a string because it is one expression: the gate
    // used to be `participation() === undefined || participation()?.participating`, so a failed read
    // took the joined branch and offered a "Turn off" button for something never joined.
    expect(panel).not.toContain("participation() === undefined")
    expect(panel).toContain("participation.failed")
  })

  test("POSITIVE CONTROL — the detectors flag a module that does the thing", () => {
    // ⚠️ A guard reporting zero because it matches NOTHING is indistinguishable from a clean file,
    // and every assertion above reports zero on a healthy tree by design. So each detector is aimed
    // at text written to be caught.
    const swallowing = `
      export function communityContacts(server) {
        return instanceFetch(server, { route: "api/community/contact" }).catch(() => [])
      }
      export function communityChannels(server) {
        try {
          return instanceFetch(server, { route: "api/community/channel" })
        } catch {
          return []
        }
      }
    `
    const bodies = [...swallowing.matchAll(/export function (community\w+)\([\s\S]*?\n      \}/g)].map((m) => m[0])
    expect(bodies.length).toBe(2)
    expect(/\.catch\s*\(/.test(bodies[0]!)).toBe(true)
    expect(/\bcatch\s*(?:\([^()]*\))?\s*\{/.test(bodies[1]!)).toBe(true)

    const bare = `const [contacts] = createResource(connection, (value) => communityContacts(value.http))`
    expect(bare.match(BARE_RESOURCE)).not.toBeNull()

    const oldGate = `<Show when={participation() === undefined || participation()?.participating}>`
    expect(oldGate).toContain("participation() === undefined")
  })

  test("NEGATIVE CONTROL — the shapes this tree actually ships are NOT flagged", () => {
    // Each line is a real shape from these two files that an earlier draft of these regexes caught.
    const good = stripComments(`
      /** Never .catch(() => []) a read, and never createResource(...) one. */
      // const [rows] = createResource(source, () => read().catch(() => []))
      export function communityContacts(server) {
        return instanceFetch(server, { route: "api/community/contact" })
      }
      const [contacts, contactActions] = createSettledResource(connection, (v) => communityContacts(v.http))
      const url = "https://example.invalid/a//b"
    `)
    expect(good.match(BARE_RESOURCE)).toBeNull()
    expect(/\.catch\s*\(/.test(good)).toBe(false)
    expect(/\bcatch\s*(?:\([^()]*\))?\s*\{/.test(good)).toBe(false)
    // …and the stripper really did remove the prose, rather than the file happening to lack it.
    expect(good).not.toContain("Never")
  })

  test("the scan is reading real files (vacuity)", () => {
    expect(API_SOURCE.length).toBeGreaterThan(2000)
    expect(PANEL_SOURCE.length).toBeGreaterThan(2000)
    expect(api).toContain("instanceFetch")
    expect(panel).toContain("communityParticipation")
  })
})
