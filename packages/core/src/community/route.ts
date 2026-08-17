export * as CommunityRoute from "./route"

/**
 * 🔴 **What may be dialled — one validator, used at STORE time and again at DIAL time.**
 *
 * P2P review 2026-08-17, finding 1.3. `peers.learn` stored whatever route strings a peer-exchange
 * answer carried, and the only filter (`httpRoutes`) checked the SCHEME. Every dialler then composes
 * `` `${route}${path}` `` — so a route ending in `#` or `?x=` puts our path in the fragment or the
 * query and the request goes wherever the string says instead. Observed with a fake PX peer:
 * `discover` → `GET /admin/reboot`; `sync` → `POST /admin/reboot`; `search`, `channelsNearby`,
 * `successions` and `transport.publish` all dialled the injected URL. Loopback, RFC1918,
 * link-local (`169.254.169.254`), `0.0.0.0`, decimal IPs and userinfo were all accepted, and
 * `peers.sample` re-served them to everyone who PXed from us — up to 128 peers × 8 routes per
 * answer, no proof-of-work, from inside the user's LAN.
 *
 * ⚠️ **Store AND dial, deliberately both.** Validating only on the way in leaves every row written
 * before this existed; validating only on the way out leaves the poison in the table for `sample` to
 * hand onwards. Neither alone is the fix, and the two are the same function so they cannot drift.
 */

/**
 * A route we are willing to dial, rebuilt canonically — or `undefined`.
 *
 * ⚠️ Path prefixes SURVIVE and that is deliberate: an instance may legitimately be mounted under a
 * subpath by a reverse proxy, and every dialler composes `route + "/api/community/…"`. What cannot
 * survive is anything that makes the composition mean something else — a query, a fragment,
 * userinfo, or a `..` segment. An honest peer never sends one, so refusing is free.
 *
 * ⚠️ Rebuilt rather than passed through: the value stored is `origin + pathname`, so two spellings
 * of one address become one string. (The same lesson as canonical `nid_` — a route that is really a
 * spelling makes every route-keyed check per-spelling, and `peers.learn` de-duplicates by route.)
 */
export const dialable = (
  route: string,
  options?: {
    /**
     * 🔴 The route was TOLD to us by another peer rather than typed by the user, discovered on the
     * LAN, or found in the DHT. Hearsay may not name an address that is meaningful only to US.
     */
    readonly hearsay?: boolean
  },
): string | undefined => {
  let url: URL
  try {
    url = new URL(route.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  // Userinfo: `https://real.example@evil.example/` reads as the first host and dials the second.
  if (url.username !== "" || url.password !== "") return undefined
  if (url.search !== "" || url.hash !== "") return undefined
  // A raw `#` or `?` with nothing after it parses to an empty search/hash, so the STRING is checked
  // too — that shape is exactly what put our path into the fragment.
  if (route.includes("#") || route.includes("?")) return undefined
  // ⚠️ The RAW string, not `url.pathname`: `new URL` has already collapsed `/a/../..` to `/`, so a
  // check on the parsed path can never fire. The collapse happens to be safe — but a route carrying
  // a traversal is not honest, and reading the value the parser produced instead of the value the
  // peer sent is how the peer door came to disagree with its own router.
  if (/(^|\/)\.\.(\/|$)/.test(route)) return undefined
  /**
   * ⚠️ And the ENCODED spellings of the same two characters, read off the RAW string again.
   * `new URL` keeps `%2f` in the pathname and silently DECODES `%2e%2e` into a traversal it then
   * applies — so one of the two survives a check on the parsed value and the other has already
   * changed the path by the time you could look. An honest route contains neither, which makes
   * refusing free. (Same shape as finding 1.2: a spelling that decodes to something else.)
   */
  if (/%2e|%2f/i.test(route)) return undefined
  if (url.hostname === "") return undefined
  if (options?.hearsay === true && !reachableFromElsewhere(url.hostname)) return undefined
  const path = url.pathname.replace(/\/+$/, "")
  return `${url.origin}${path}`
}

/**
 * 🔴 Whether an address from this SOURCE is a stranger's claim.
 *
 * ⚠️ Everything except `lan` and `manual`. Peer exchange is the obvious one, but a public Kademlia
 * DHT and a DNS seed are filled by strangers on exactly the same terms — the review named PX
 * because that is where it ran the probe, not because the others are different. `lan` is an address
 * WE saw on the network we are attached to, and `manual` is one the user typed; only those two can
 * legitimately mean something local.
 */
export const isHearsay = (source: string): boolean => source !== "lan" && source !== "manual"

/** Every route in `routes` we are willing to dial, canonical and de-duplicated. */
export const dialableAll = (routes: readonly string[], options?: { readonly hearsay?: boolean }): string[] => {
  const out: string[] = []
  for (const route of routes) {
    const clean = dialable(route, options)
    if (clean !== undefined && !out.includes(clean)) out.push(clean)
  }
  return out
}

/**
 * 🔴 Whether a host a STRANGER named could mean anything to us.
 *
 * ⚠️ Private ranges stay ALLOWED, and that is the tie resolved from `AGENTS.md`: discovery *is* the
 * LAN, so a peer on one telling us about its neighbour is the network working. What a remote peer
 * can never legitimately name is an address whose meaning is local to the machine that resolves it —
 * loopback (their `127.0.0.1` is not ours), link-local (`169.254.169.254` is a cloud metadata
 * service), or the unspecified address.
 *
 * ⚠️ Integer and hex spellings of an IP are refused outright rather than decoded. `2130706433` and
 * `0x7f000001` both resolve to `127.0.0.1`, and a validator that has to re-implement the resolver's
 * parsing is a second resolver — the mistake the peer door made about the router.
 */
const reachableFromElsewhere = (hostname: string): boolean => {
  const host = hostname.toLowerCase()
  // An IPv6 literal arrives bracketed from `new URL`. ULA (`fc00::/7`) is the v6 private range and
  // stays allowed for the same reason RFC1918 does.
  if (host.startsWith("[")) {
    const inner = host.slice(1, -1)
    if (inner === "" || inner === "::1" || inner === "::" || inner.startsWith("fe80:")) return false
    /**
     * IPv4-mapped (`::ffff:127.0.0.1`) is the same trick one syntax over — and `new URL` REWRITES it
     * to `::ffff:7f00:1`, so the dotted form never reaches this branch. Measured by the test: a
     * check that only knew the dotted spelling let loopback straight through.
     */
    if (inner.startsWith("::ffff:")) {
      const rest = inner.slice("::ffff:".length)
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest)
      if (hex === null) return reachableFromElsewhere(rest)
      const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)]
      return reachableFromElsewhere(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
    }
    return true
  }
  // A bare integer or hex number is an IP in disguise; a name never looks like this.
  if (/^(\d+|0x[0-9a-f]+)$/.test(host)) return false
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (quad === null) return host !== "localhost" && !host.endsWith(".localhost")
  const [a, b] = [Number(quad[1]), Number(quad[2])]
  if (a === 127 || a === 0) return false
  if (a === 169 && b === 254) return false
  // Anything above 223 is multicast or reserved — not somewhere a peer answers.
  if (a > 223) return false
  return true
}
