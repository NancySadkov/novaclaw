import { describe, expect, test } from "bun:test"
import { CommunityRoute } from "@novaclaw/core/community/route"
import { CommunityTransport } from "@novaclaw/core/community/transport"

/**
 * 🔴 P2P review 2026-08-17, finding 1.3 — **SSRF: a route learned by peer exchange picked the exact
 * URL we dialled, from inside the user's LAN, on six paths.**
 *
 * `peers.learn` stored whatever strings a PX answer carried and the only filter checked the SCHEME.
 * Every dialler composes `` `${route}${path}` ``, so a route ending in `#` or `?x=` puts our path in
 * the fragment or query and the request goes where the attacker said instead. Observed with a fake
 * PX peer: `discover` → `GET /admin/reboot`, `sync` → `POST /admin/reboot`, and `search`,
 * `channelsNearby`, `successions` and `transport.publish` all dialled the injected URL. Loopback,
 * RFC1918, `169.254.169.254`, `0.0.0.0`, decimal IPs and userinfo were all accepted, and
 * `peers.sample` re-served them to everyone who PXed from us.
 *
 * ⚠️ The composition test below is the one that matters, and it is the check the old ledger never
 * made: it is not enough that the route "looks wrong" — the property is that the URL we END UP
 * DIALLING has the API path we intended, for every shape.
 */

/** Every peer path is composed this way, in six diallers. */
const API = "/api/community/identity"

describe("CommunityRoute.dialable — what may be dialled", () => {
  test("🔴 the injected shapes, and the property that makes them injections", () => {
    for (const injected of [
      "https://evil.example/#",
      "https://evil.example/?x=",
      "https://evil.example/admin?",
      "https://evil.example#fragment",
      "https://real.example@evil.example",
      "https://evil.example/a/../..",
      // The encoded spellings of the same two characters, which `new URL` leaves alone.
      "https://evil.example/%2e%2e/admin",
      "https://evil.example/a%2Fb",
      "ftp://evil.example",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url at all",
      "",
    ]) {
      expect(CommunityRoute.dialable(injected), `${injected} must not be dialable`).toBeUndefined()
    }
  })

  test("🔴 whatever survives, composing it with an API path yields THAT path", () => {
    /**
     * The report's own falsifier: feed the composed URL through `new URL` and assert the pathname
     * ends with the API path. A validator that merely rejected a list of known-bad strings would
     * pass the test above and fail this one on the next spelling somebody invents.
     */
    for (const candidate of [
      "https://peer.example",
      "https://peer.example/",
      "https://peer.example:4096",
      "http://192.168.1.5:4096",
      "https://peer.example/nova",
      "https://peer.example/nova/",
      "HTTPS://Peer.Example:4096",
      "https://evil.example/#",
      "https://evil.example/?x=",
      "https://real.example@evil.example",
    ]) {
      const route = CommunityRoute.dialable(candidate)
      if (route === undefined) continue
      const composed = new URL(`${route}${API}`)
      expect(composed.pathname.endsWith(API), `${candidate} composed to ${composed.href}`).toBe(true)
      expect(composed.search, `${candidate} must not smuggle a query`).toBe("")
      expect(composed.hash, `${candidate} must not smuggle a fragment`).toBe("")
      expect(composed.username, `${candidate} must not smuggle userinfo`).toBe("")
    }
  })

  test("🔴 the control: an honest route survives, and a subpath mount survives WHOLE", () => {
    // A validator that refused everything would pass every negative assertion above and take the
    // network off the air.
    expect(CommunityRoute.dialable("https://peer.example")).toBe("https://peer.example")
    expect(CommunityRoute.dialable("https://peer.example:4096/")).toBe("https://peer.example:4096")
    expect(CommunityRoute.dialable("http://192.168.1.5:4096")).toBe("http://192.168.1.5:4096")
    // A reverse proxy may legitimately mount an instance under a path, and every dialler appends to
    // it — so the prefix is kept rather than stripped.
    expect(CommunityRoute.dialable("https://peer.example/nova/")).toBe("https://peer.example/nova")
    // Two spellings of one address become one string, so route-keyed checks stay per-address.
    expect(CommunityRoute.dialable("HTTPS://Peer.Example/")).toBe(CommunityRoute.dialable("https://peer.example"))
  })

  test("🔴 HEARSAY may not name an address that only means something to US", () => {
    /**
     * ⚠️ The distinction is the SOURCE, not the address class, and that tie is resolved from
     * AGENTS.md: *discovery is the LAN*, so a private address is a first-class peer address and
     * refusing RFC1918 outright would break the product. What a remote stranger can never
     * legitimately name is loopback (their `127.0.0.1` is not ours), link-local (`169.254.169.254`
     * is a cloud metadata service) or the unspecified address.
     */
    for (const local of [
      "http://127.0.0.1:4096",
      "http://localhost:4096",
      "http://sub.localhost:4096",
      "http://0.0.0.0:4096",
      "http://169.254.169.254",
      "http://[::1]:4096",
      "http://[fe80::1]:4096",
      "http://[::ffff:127.0.0.1]",
      // Integer and hex spellings of 127.0.0.1 — refused rather than decoded, because a validator
      // that re-implements the resolver's parsing is a second resolver.
      "http://2130706433",
      "http://0x7f000001",
      "http://255.255.255.255",
    ]) {
      expect(
        CommunityRoute.dialable(local, { hearsay: true }),
        `${local} is not reachable from elsewhere`,
      ).toBeUndefined()
      // …and the same string from a source that CAN mean it is kept: this is what LAN discovery,
      // the DHT and a typed address all depend on.
      expect(CommunityRoute.dialable(local), `${local} must still be dialable when we found it ourselves`).toBeDefined()
    }
    // The control: ordinary hearsay is still learned, including a LAN neighbour's private address.
    expect(CommunityRoute.dialable("https://peer.example", { hearsay: true })).toBe("https://peer.example")
    expect(CommunityRoute.dialable("http://192.168.1.5:4096", { hearsay: true })).toBe("http://192.168.1.5:4096")
    expect(CommunityRoute.dialable("http://10.0.0.9:4096", { hearsay: true })).toBe("http://10.0.0.9:4096")
  })

  test("🔴 a TYPED address goes through the same door", () => {
    // `typedRoutes` exists because a person types `192.168.1.5:4096` with no scheme — and its host
    // regex accepts anything after a slash, so without this the one door meant for humans was the
    // one door with no validation.
    expect(CommunityTransport.typedRoutes("example.com/a?x=")).toEqual([])
    expect(CommunityTransport.typedRoutes("192.168.1.5:4096")).toEqual([
      "https://192.168.1.5:4096",
      "http://192.168.1.5:4096",
    ])
    expect(CommunityTransport.typedRoutes("https://peer.example/")).toEqual(["https://peer.example"])
  })

  test("dialableAll de-duplicates by the CANONICAL form", () => {
    expect(
      CommunityRoute.dialableAll(["https://peer.example", "https://peer.example/", "HTTPS://PEER.EXAMPLE", "nope"]),
    ).toEqual(["https://peer.example"])
  })
})
