import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CommunityDht } from "@novaclaw/core/community/dht"

/**
 * Community — the DHT seam (`notes/spec/community-p2p.md`).
 *
 * 🔴 The case that matters most is the one that happens on nearly every machine: **the sidecar is
 * not there**. It is a Rust binary and the app builds without a cargo toolchain, so "no binary" is
 * the ORDINARY state, not a fault — and it must cost nothing beyond the peers it would have found.
 *
 * ⚠️ These never spawn the real sidecar. What is under test is the seam: that failure is silent,
 * that a stranger's output is validated on THIS side of the process boundary too, and that the
 * result is the same shape `learnFrom` already consumes.
 */

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("CommunityDht.parse", () => {
  test("🔴 addresses that could not be dialled are dropped, not passed on", () => {
    /**
     * ⚠️ Validated HERE as well as in the sidecar. This data originated with strangers on a public
     * DHT and crossed a process boundary; a caller that trusted it would be trusting the weakest
     * link in the chain. Passing junk on would also push the decision about it to whoever dials next.
     */
    expect(CommunityDht.parse(JSON.stringify({ peers: ["1.2.3.4:4096", "not-an-address", "", 42] }))).toEqual([
      "1.2.3.4:4096",
    ])
    expect(CommunityDht.parse(JSON.stringify({ peers: ["evil.example:4096/../etc"] }))).toEqual([])
  })

  test("⚠️ malformed output is NO PEERS, never a throw", () => {
    // The sidecar is a separate process that could crash mid-line, be an old build, or be something
    // else entirely on a machine where the path was overridden.
    expect(CommunityDht.parse("not json at all")).toEqual([])
    expect(CommunityDht.parse("")).toEqual([])
    expect(CommunityDht.parse(JSON.stringify({ peers: "1.2.3.4:4096" }))).toEqual([])
    expect(CommunityDht.parse(JSON.stringify({ announced: true }))).toEqual([])
  })

  test("bounded, and duplicates collapse", () => {
    const many = Array.from({ length: 40 }, (_, index) => `10.0.0.${index}:4096`)
    expect(CommunityDht.parse(JSON.stringify({ peers: many })).length).toBe(CommunityDht.MAX_DHT_PEERS)
    expect(CommunityDht.parse(JSON.stringify({ peers: ["1.2.3.4:1", "1.2.3.4:1"] }))).toEqual(["1.2.3.4:1"])
  })
})

describe("CommunityDht.find", () => {
  test("🔴 a MISSING sidecar answers no peers — the ordinary case on most machines", async () => {
    const found = await run(
      CommunityDht.find({
        binary: "definitely-not-a-real-binary-anywhere",
        run: () => Promise.reject(new Error("ENOENT")),
      }),
    )
    expect(found).toEqual([])
  })

  test("🔴 a HANGING sidecar does not hold discovery open", async () => {
    /**
     * ⚠️ The failure easiest to miss and worst to ship: a child that neither answers nor exits. The
     * caller is a user waiting on a button, and the design says an unreachable DHT costs freshness,
     * never the join.
     */
    const started = Date.now()
    // A short budget here, because what is under test is that the backstop FIRES — not how long the
    // production one is. The default is deliberately longer than any test should sit waiting.
    const found = await run(CommunityDht.find({ binary: "x", timeoutMs: 1_000, run: () => new Promise(() => {}) }))
    expect(found).toEqual([])
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  test("peers the sidecar reports come back in the shape learnFrom consumes", async () => {
    const found = await run(
      CommunityDht.find({
        binary: "x",
        run: () => Promise.resolve([JSON.stringify({ peers: ["203.0.113.9:4096", "peer.example:8443"] })]),
      }),
    )
    expect(found).toEqual(["203.0.113.9:4096", "peer.example:8443"])
  })

  test("🔴 with an announce, the ANSWER is read — not the acknowledgement before it", async () => {
    /**
     * The sidecar replies once per request, so announcing shifts the answer down a line. Reading the
     * first reply would return `{"announced":true}` — which parses, contains no peers, and looks
     * exactly like a DHT that found nobody.
     */
    const found = await run(
      CommunityDht.find({
        binary: "x",
        announce: "203.0.113.9:4096",
        run: (_binary, lines) => {
          expect(lines.length).toBe(2)
          expect(lines[0]).toContain("announce")
          return Promise.resolve([JSON.stringify({ announced: true }), JSON.stringify({ peers: ["1.2.3.4:4096"] })])
        },
      }),
    )
    expect(found).toEqual(["1.2.3.4:4096"])
  })

  test("⚠️ without an announce, nothing is advertised", async () => {
    // Announcing is only honest from somewhere reachable; a NAT'd instance publishing an address
    // nobody can dial is a promise it cannot keep, so looking must not imply advertising.
    await run(
      CommunityDht.find({
        binary: "x",
        run: (_binary, lines) => {
          expect(lines.length).toBe(1)
          expect(lines[0]).not.toContain("announce")
          return Promise.resolve([JSON.stringify({ peers: [] })])
        },
      }),
    )
  })
})
