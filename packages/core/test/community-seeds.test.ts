import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CommunitySeeds } from "@novaclaw/core/community/seeds"

/**
 * Community — the DEFAULT way in (`AGENTS.md`, "Joining is doorman-FREE").
 *
 * 🔴 What these pin is that a seed lookup can never stop somebody joining. Every failure mode must
 * answer "no seeds" rather than an error, because the moment a join can fail on DNS the seeds have
 * stopped being a convenience and become the dependency the whole design refuses to have.
 */

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("CommunitySeeds.parse", () => {
  test("🔴 TXT chunks are JOINED before anything is read", () => {
    /**
     * A TXT record is an array of 255-byte pieces split wherever the publisher's tooling chose.
     * Reading each chunk as an address works until a record is long enough to split — a bug that
     * appears only once somebody publishes a real list, which is the worst time to find it.
     */
    expect(CommunitySeeds.parse([["seed-one.exam", "ple.net:4096"]])).toEqual(["seed-one.example.net:4096"])
  })

  test("several addresses in one record, however the zone editor spaced them", () => {
    expect(CommunitySeeds.parse([["a.example:1, b.example:2  c.example:3"]])).toEqual([
      "a.example:1",
      "b.example:2",
      "c.example:3",
    ])
  })

  test("🔴 bounded, and duplicates collapse", () => {
    const many = Array.from({ length: 50 }, (_, index) => [`host-${index}.example:4096`])
    expect(CommunitySeeds.parse(many).length).toBe(CommunitySeeds.MAX_SEEDS)
    expect(CommunitySeeds.parse([["a.example:1"], ["a.example:1"]])).toEqual(["a.example:1"])
  })

  test("⚠️ junk is dropped rather than dialled", () => {
    // Nothing here is validated as REACHABLE — a seed is a hint, and `learn` refuses anything that
    // is not a public key when the peer answers. What is refused is text that could not be an
    // address at all, so it never reaches a dialler.
    expect(CommunitySeeds.parse([["<script>alert(1)</script>"], ["ok.example:1"]])).toEqual(["ok.example:1"])
    expect(CommunitySeeds.parse([[""], ["   "]])).toEqual([])
  })
})

describe("CommunitySeeds.resolve", () => {
  test("🔴 a DNS failure answers NO SEEDS, never an error", async () => {
    const thrown = await run(
      CommunitySeeds.resolve({
        host: "nowhere.invalid",
        lookup: () => Promise.reject(new Error("ENOTFOUND")),
      }),
    )
    expect(thrown).toEqual([])
  })

  test("🔴 a HANGING resolver does not hold the join open", async () => {
    /**
     * ⚠️ The failure that matters most and is easiest to miss: a name that neither answers nor
     * refuses. Without the timeout a join would sit there, and the user would be told nothing while
     * a network they could have reached went unjoined.
     */
    const started = Date.now()
    const answered = await run(CommunitySeeds.resolve({ host: "slow.invalid", lookup: () => new Promise(() => {}) }))
    expect(answered).toEqual([])
    expect(Date.now() - started).toBeLessThan(CommunitySeeds.LOOKUP_TIMEOUT_MS + 2_000)
  })

  test("🔴 turning seeds OFF asks nothing at all", async () => {
    let asked = 0
    const answered = await run(
      CommunitySeeds.resolve({
        settings: { enabled: false },
        lookup: () => {
          asked += 1
          return Promise.resolve([["should-never-be-read.example:1"]])
        },
      }),
    )
    /**
     * ⚠️ The point is the LOOKUP, not the list. A DNS query tells whoever runs that zone this
     * machine runs NovaClaw — so "off" has to mean no question was asked, not that the answer was
     * discarded afterwards.
     */
    expect(answered).toEqual([])
    expect(asked).toBe(0)
  })

  test("🔴 with NO host configured, nothing is asked at all", async () => {
    let asked = 0
    const answered = await run(
      CommunitySeeds.resolve({
        settings: {},
        lookup: () => {
          asked += 1
          return Promise.resolve([["never-read.example:1"]])
        },
      }),
    )

    /**
     * 🔴 The owner's ruling (2026-08-17): **novaclaw.app is a static page about Nova and must not
     * be responsible for the network.** So there is no default host, and an instance that configured
     * nothing asks NOBODY — it does not quietly fall back to a zone the project controls.
     *
     * ⚠️ This test previously asserted the opposite ("absence is ON"), because I had shipped a
     * default pointing at our own domain before being told not to. The assertion is inverted rather
     * than deleted so the change of mind stays visible.
     *
     * ⚠️ What fills the automatic slot is a public Kademlia DHT, not us. Until then the automatic
     * door is the LAN and the guarantee is a typed doorman address.
     */
    expect(asked).toBe(0)
    expect(answered).toEqual([])
  })

  test("a host of your own is used instead of the project's", async () => {
    let sawHost = ""
    await run(
      CommunitySeeds.resolve({
        settings: { host: "my-own-zone.example" },
        lookup: (host) => {
          sawHost = host
          return Promise.resolve([])
        },
      }),
    )
    expect(sawHost).toBe("my-own-zone.example")
    expect(sawHost).not.toBe(CommunitySeeds.DEFAULT_SEED_HOST)
  })

  test("records that resolve become addresses", async () => {
    const found = await run(
      CommunitySeeds.resolve({
        host: "seed.example",
        lookup: () => Promise.resolve([["one.example:4096"], ["two.example:4096"]]),
      }),
    )
    expect(found).toEqual(["one.example:4096", "two.example:4096"])
  })
})
