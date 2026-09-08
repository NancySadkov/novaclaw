import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { CommunityDht } from "@novaclaw/core/community/dht"
import { httpRoutes, typedRoutes } from "@novaclaw/core/community/transport"

/**
 * 🔴 **Every discovery source must survive `learnFrom`, whatever shape its addresses arrive in.**
 *
 * Measured 2026-08-17 by having one instance ask another: an address learned a moment earlier came
 * back as `no-route`. `learnFrom` filtered its input through `httpRoutes`, which requires a parseable
 * URL — right for mDNS and peer exchange, where a scheme always rides along, and **wrong for the
 * DHT**, whose records carry a bare `host:port`.
 *
 * ⚠️ So every address the public directory found was discarded before a single dial. The sidecar
 * could work perfectly, the room could be full, and no peer would ever be added — while
 * `community/dht.ts` said in as many words that its result was *"exactly what `learnFrom` already
 * consumes"*. Nothing was red anywhere.
 */

describe("the shapes an address arrives in", () => {
  test("🔴 a bare host:port survives — this is what the DHT returns", () => {
    // `CommunityDht.parse` validates to exactly this shape, so it is not an edge case: it is the
    // entire output of one of the three discovery sources.
    expect(httpRoutes(["203.0.113.9:4096"]), "httpRoutes drops it, which is why learnFrom must not use it").toEqual([])
    expect(typedRoutes("203.0.113.9:4096")).toEqual(["https://203.0.113.9:4096", "http://203.0.113.9:4096"])
  })

  test("⚠️ HTTPS is tried FIRST, so a pasted public host is never silently downgraded", () => {
    const [first] = typedRoutes("nova.example.com:443")
    /**
     * ⚠️ The DEFAULT port is dropped, because routes are canonicalised since review 1.3:
     * `https://host:443` and `https://host` are one address, and storing both spellings would make
     * every route-keyed check (de-duplication, `learn`'s uniqueness rule, the dial list) per-
     * spelling — the same defect as a `nid_` that was really a spelling.
     */
    expect(first).toBe("https://nova.example.com")
  })

  test("an address that already carries a scheme is passed through UNCHANGED", () => {
    // The LAN and peer-exchange cases, which must not become two dials each.
    expect(typedRoutes("http://192.168.1.9:4096")).toEqual(["http://192.168.1.9:4096"])
    expect(typedRoutes("https://nova.example.com")).toEqual(["https://nova.example.com"])
  })

  test("⚠️ junk is still refused — this widened what is accepted, not what is dialled", () => {
    expect(typedRoutes("")).toEqual([])
    expect(typedRoutes("   ")).toEqual([])
    expect(typedRoutes("not a host at all")).toEqual([])
    expect(typedRoutes("http://[not a host]")).toEqual([])
  })

  test("⚠️ a PATH is allowed here, and refused one layer up — where it matters", () => {
    /**
     * `typedRoutes` serves a human pasting an address, who may well paste a full URL with a path, so
     * it keeps one. That is not a hole the DHT can reach through: `CommunityDht.parse` accepts
     * `host:port` and nothing else, so a provider record cannot smuggle a path in at all.
     *
     * Worth pinning because the two now share a door — a later edit that loosened the DHT's parser
     * would be relying on this function to catch what it no longer catches.
     */
    expect(typedRoutes("nova.example:4096/status")).toEqual([
      "https://nova.example:4096/status",
      "http://nova.example:4096/status",
    ])
    expect(CommunityDht.parse(JSON.stringify({ peers: ["evil.example:4096/../etc"] }))).toEqual([])
  })
})

describe("learnFrom uses the forgiving one", () => {
  const source = readFileSync(new URL("../src/community/sync.ts", import.meta.url), "utf8")
  const learnFrom = source.slice(source.indexOf('learnFrom: Effect.fn("CommunitySync.learnFrom")'))
  const body = learnFrom.slice(0, learnFrom.indexOf("discover: Effect.fn"))

  test("🔴 it normalises each address rather than filtering the list", () => {
    expect(body).toContain("typedRoutes(address)")
    // The exact call that dropped every DHT address before any dial.
    expect(body, "httpRoutes(addresses) discards everything the DHT returns").not.toContain("httpRoutes(addresses)")
  })

  test("🔴 the route STORED is the one that answered, scheme and all", () => {
    /**
     * Otherwise the defect simply moves one step later: `sendDirect` and `askPeer` both filter the
     * peer's stored routes with `httpRoutes`, so a bare form kept in the table would be dropped
     * there instead — the same silence, further from its cause.
     */
    expect(body).toContain("peers.learn(health.networkID, [route], source)")
    expect(body).not.toContain("peers.learn(health.networkID, [address], source)")
  })
})
