export * as CommunityAddress from "./address"

/**
 * 🔴 **The announce address rule, in a LEAF module with no runtime imports.**
 *
 * It lived in `dht.ts`, which reaches the settings store and therefore `bun:sqlite` — so the moment
 * the Community panel imported this one function to validate what a user typed, Vite pulled the whole
 * chain into the browser bundle and the app failed to boot with *"Module bun:sqlite has been
 * externalized for browser compatibility"*. Typecheck was green and every unit test passed; only
 * loading the page showed it.
 *
 * ⚠️ Split rather than duplicated. A second copy of this rule in the app would agree with the
 * sidecar's until one of them changed — the same mistake the peer-door guard made against the router,
 * where a check that re-derived somebody else's decision drifted from it silently.
 */

/**
 * Whether an address is worth publishing.
 *
 * 🔴 The announce address is TYPED BY A USER, and the whole point of publishing is that strangers
 * act on it. A malformed one still announces the room — the sidecar simply fails to attach an
 * address to it — which puts a record in the commons that names nobody. Refused here so the junk
 * never leaves this machine.
 *
 * ⚠️ This says the address is well FORMED, never that it is reachable. Nothing on this machine can
 * know that, which is why the setting exists for a person to answer.
 */
export const isAnnounceable = (address: string): boolean => splitAnnounce(address) !== undefined

/**
 * `host:port`, PARSED — the host and the port, or `undefined` if it is neither.
 *
 * 🔴 This was a regex, and it was wrong in both directions (Codex review P3). It accepted any one to
 * five digits, so `example.com:99999` passed validation, reached the sidecar, failed to convert to a
 * multiaddr, and the room was announced anyway with no address attached — the UI reporting a
 * successful publish of a door nobody can open. And it rejected `[2001:db8::1]:4096`, so an
 * IPv6-only instance could not publish at all, while the address parser on the other side of the
 * pipe has understood IPv6 the whole time.
 *
 * ⚠️ Parse rather than match, because the bound that matters is arithmetic (1..65535) and a regex
 * cannot state it. The bracket form is required for IPv6 for the reason it exists at all: without
 * brackets the last colon is ambiguous, and guessing which colon is the port separator is how a
 * validator ends up disagreeing with the parser it feeds.
 */
export const splitAnnounce = (address: string): { host: string; port: number } | undefined => {
  const trimmed = address.trim()
  if (trimmed === "") return undefined

  const bracketed = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(trimmed)
  const plain = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(trimmed)
  const match = bracketed ?? plain
  if (match === null) return undefined

  const host = match[1]!
  const port = Number(match[2]!)
  // ⚠️ The whole point of parsing: a port is a 16-bit number, and 0 is not a port anyone answers on.
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  if (bracketed !== null && !host.includes(":")) return undefined
  return { host, port }
}

