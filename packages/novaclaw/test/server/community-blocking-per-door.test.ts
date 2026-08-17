import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { CommunityPeerPaths } from "../../src/server/routes/instance/httpapi/groups/community"

/**
 * 🔴 **Blocking, DERIVED per door — the meta-rule from `notes/spec/community-p2p.md`'s new-peer-door
 * checklist: *"Derive, never list by hand. Blocking missed two doors."***
 *
 * It has now missed three. The third was `ask`, the newest door and the only one that costs the user
 * MONEY: a blocked peer could not reach them in a room, could not reach them by direct message, and
 * could still make them pay for an answer. Each time the rule existed, was correct, and was not
 * applied at the new place — which is precisely the failure a hand-kept list cannot prevent.
 *
 * ⚠️ So this ledger is derived from `CommunityPeerPaths` itself. A door added later is not merely
 * unchecked here; it FAILS here until somebody says which kind it is. That is the only mechanism that
 * makes the next door answer the question instead of inheriting an answer nobody gave.
 */

/**
 * Every registered peer door, and whether it attributes what it receives to an AUTHOR.
 *
 * `blocks` — it acts on something a specific peer said or asked, so the user's block must apply.
 * `anonymous` — it answers about this instance's own public state, and the caller's identity does not
 * change what is stored or spent. Blocking cannot apply to a question that has no author.
 */
const DOORS: Record<keyof typeof CommunityPeerPaths, "blocks" | "anonymous"> = {
  /** A message with a signed author, stored in a room. */
  inbound: "blocks",
  /** A sealed message from one named peer to this user. */
  dm: "blocks",
  /** A question that SPENDS THIS USER'S TOKENS, signed by whoever asked. */
  ask: "blocks",
  /**
   * ⚠️ `anonymous` for a reason worth stating: these serve or summarise what this instance already
   * holds publicly, and answer identically whoever asks. Blocking a peer does not un-publish a room
   * they can read, and pretending otherwise would be security theatre — the honest bound on these is
   * the rate limit and the proof-of-work, not the block list.
   */
  syncSummary: "anonymous",
  syncIds: "anonymous",
  syncMessages: "anonymous",
  peers: "anonymous",
  listedChannels: "anonymous",
  search: "anonymous",
  offer: "anonymous",
  identity: "anonymous",
  /** A succession statement is self-verifying and about the sender's OWN key; refusing it from a
   *  blocked peer would only leave us attributing their old messages to a key they abandoned. */
  succession: "anonymous",
}

const handlers = readFileSync(
  new URL("../../src/server/routes/instance/httpapi/handlers/community.ts", import.meta.url),
  "utf8",
)
const stores = ["dm", "channels", "answer", "contacts"].map((name) => ({
  name,
  text: readFileSync(new URL(`../../../core/src/community/${name}.ts`, import.meta.url), "utf8"),
}))

describe("every peer door is classified for blocking", () => {
  test("🔴 the classification covers the registered doors EXACTLY", () => {
    /**
     * Both directions. A missing key is the case that matters — a new door must not default to
     * "blocking does not apply" — and an extra key means a door was removed while its claim stayed,
     * which is how a ledger starts describing a program that no longer exists.
     */
    expect(Object.keys(DOORS).sort()).toEqual(Object.keys(CommunityPeerPaths).sort())
  })

  test("🔴 every `blocks` door has a blocking check somewhere on its path", () => {
    /**
     * ⚠️ Deliberately coarse: it asserts that the check EXISTS on the path, not where. `inbound` and
     * `dm` check inside their stores, `ask` checks in the handler, and demanding one shape would
     * force the wrong one somewhere.
     *
     * ⚠️ Comments stripped first — the standing rule here, and it earned its place twice: a guard
     * fired on prose explaining why a call was absent, and before that a comment described a blocking
     * check on the DM door that had never been implemented. **A comment is not evidence.**
     */
    const strip = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    const surfaces = [strip(handlers), ...stores.map((store) => strip(store.text))].join("\n")

    for (const [door, kind] of Object.entries(DOORS)) {
      if (kind !== "blocks") continue
      expect(surfaces, `${door} attributes to an author, so a block must be able to stop it`).toContain("blocked")
    }
    // The specific one that was missing until 2026-08-17, pinned by its own shape so a later edit
    // cannot delete it and still satisfy the loop above through a sibling door's check.
    expect(strip(handlers), "the ask door checks the asker").toContain("asking?.blocked === true")
  })

  test("⚠️ and the control: the scan can tell a stripped comment from code", () => {
    const strip = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    expect(strip("/* blocked */ const x = 1")).not.toContain("blocked")
    expect(strip("if (contact?.blocked === true) return")).toContain("blocked")
  })
})
