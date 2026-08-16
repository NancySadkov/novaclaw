export * as CommunitySeeds from "./seeds"

import { Effect } from "effect"

/**
 * Community — the DEFAULT way in, for a user who knows nobody (`AGENTS.md`, "Joining is
 * doorman-FREE").
 *
 * 🔴 Clicking Community must join the network. Not "may, if you were given an address" — LAN
 * discovery already needs no seed, and this is the same promise for everyone not sitting beside
 * another instance. A network you can only enter by invitation is an invitation-only club.
 *
 * ⚠️ **This is a CONVENIENCE and must never become a dependency**, which is the whole reason it is
 * allowed to be centralised and ours. libp2p's public bootstrap servers are the cautionary tale:
 * when they went, networks with no other door became unreachable while every instance in them was
 * alive and talking. What keeps that from happening here is the MANUAL door — a user typing an
 * address they trust — and it is the manual door, not this file, that makes "there is no list to
 * seize" true.
 *
 * ⚠️ So every failure here is silent and total: no seeds, no error, join anyway. A seed lookup that
 * could fail a join would have converted the convenience into the dependency.
 */

/**
 * TXT rather than A/AAAA, and a hostname rather than shipped IPs.
 *
 * 🔴 Addresses shipped in a binary are a promise about a machine, kept for as long as one release
 * lives. A zone the project controls can be repointed the day a host moves, without asking anybody
 * to upgrade — and a TXT record carries a PORT, which an A record cannot.
 *
 * ⚠️ Several records, deliberately: the spec's own warning is that *if everyone ships the same three
 * seeds and they die, new users cannot join a network that is perfectly alive.* Plurality is cheap
 * here — it is a DNS edit — and it is the only thing standing between one dead host and a closed
 * front door.
 */
/**
 * 🔴 NO DEFAULT, and that is the owner's ruling (2026-08-17): **novaclaw.app is a static page
 * about Nova and must not be responsible for the network.** A hostname shipped here would have made
 * the project's own domain the thing every instance asks permission of — which is the shape this
 * whole design refuses, and I built it before being told.
 *
 * ⚠️ What fills this slot is libp2p's public bootstrap provisions, not us. Until that lands the
 * automatic door is the LAN, and a typed doorman address is the guarantee it always was.
 *
 * ⚠️ The mechanism stays because it costs nothing and belongs to the USER: point `community.
 * seeds.host` at a zone you control and this bootstraps from your own hosts. What it will never do
 * is default to ours.
 */
export const DEFAULT_SEED_HOST: string | undefined = undefined

/**
 * How many seeds we take. A bound, not a preference: this list is supplied by whoever controls the
 * zone, and peer exchange only needs ONE live entry to reach everything else.
 */
export const MAX_SEEDS = 8

/** How long a join will wait on DNS before going without it. */
export const LOOKUP_TIMEOUT_MS = 3_000

/**
 * Turn TXT records into addresses.
 *
 * ⚠️ Pure, and separate from the lookup, so the parsing and the bound can be exercised without a
 * network — the part most likely to be wrong is not the resolver.
 *
 * ⚠️ TXT strings arrive CHUNKED: a record is an array of 255-byte pieces that a publisher may have
 * split anywhere, so they are joined before anything is read. Treating each chunk as an address
 * works until somebody publishes one long enough to split, which is the kind of bug that appears
 * only in production.
 */
export const parse = (records: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  for (const record of records) {
    const joined = record.join("").trim()
    // One address per record, or several separated by whitespace or commas — a zone editor's choice.
    for (const candidate of joined.split(/[\s,]+/)) {
      const address = candidate.trim()
      if (address === "") continue
      // ⚠️ Nothing is validated as reachable here. A seed is a HINT: `learn` refuses anything that is
      // not a public key when the peer answers, and an address that answers nothing costs one dial.
      if (!/^[A-Za-z0-9._:\-[\]/]+$/.test(address)) continue
      seen.add(address)
      if (seen.size >= MAX_SEEDS) return [...seen]
    }
  }
  return [...seen]
}

/**
 * Ask DNS where to start. Answers `[]` for every failure — no host, no records, no network, timeout.
 *
 * ⚠️ The resolver is injectable so the caller's tests do not depend on a zone existing, and so the
 * one in production can be swapped for a DoH client later without touching this logic.
 */
export const resolve = Effect.fn("CommunitySeeds.resolve")(function* (input?: {
  readonly host?: string
  readonly lookup?: (host: string) => Promise<ReadonlyArray<ReadonlyArray<string>>>
  /**
   * ⚠️ The user's own setting, read by the CALLER and passed in rather than reached for here.
   * This module has no business resolving configuration, and a lookup that consulted a gate would
   * be a second place answering "may we go out", which is how the two drift apart.
   */
  readonly settings?: { readonly enabled?: boolean; readonly host?: string }
}) {
  // OFF is explicit only. Absence means the default door, which is what makes joining work for
  // somebody who has never configured anything.
  if (input?.settings?.enabled === false) return []
  const host = input?.host ?? input?.settings?.host ?? DEFAULT_SEED_HOST
  // No host configured is the ORDINARY state now, not a failure: nothing is asked and nothing is
  // learned, exactly as if the zone were empty.
  if (host === undefined) return []
  const lookup =
    input?.lookup ??
    ((name: string) => import("node:dns/promises").then((dns) => dns.resolveTxt(name) as Promise<string[][]>))
  const records = yield* Effect.tryPromise(() => lookup(host)).pipe(
    Effect.timeoutOption(LOOKUP_TIMEOUT_MS),
    // 🔴 Silent by construction. A join must not fail, or be slower to fail, because a name did not
    // resolve — see the file comment: this is the convenience, never the dependency.
    Effect.catchCause(() => Effect.succeedNone),
  )
  if (records._tag === "None") return []
  return parse(records.value)
})
