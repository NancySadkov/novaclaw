import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dict as en } from "@/i18n/en"

/**
 * 🔴 **What a person must be told BEFORE they join — pinned, because a person cannot consent to what
 * they were not told.**
 *
 * `notes/spec/honesty-ledger.md` §5(k) makes one of these a release condition in as many words: the
 * consent warning must have gained its disclosure *"by the time any of this ships"*. The rest are the
 * architecture's own costs, and `AGENTS.md` says they are stated plainly rather than made to sound
 * smaller.
 *
 * ⚠️ A ledger of SENTENCES, not of components. Each line here is a distinct thing the user is
 * exposed to, and each was added when the capability behind it shipped — so a capability that
 * arrives later without its sentence fails here, which is the only mechanism that keeps the screen
 * honest as the feature grows.
 */

const source = readFileSync(new URL("./community-network.tsx", import.meta.url), "utf8")

/**
 * The screen's copy, read from the DICTIONARY now that it is translatable.
 *
 * ⚠️ It used to be scraped out of the TSX with comments stripped, which stopped working the moment
 * the strings became `t()` keys — and a ledger that silently starts matching nothing is worse than
 * no ledger. Reading `en` is also the more honest source: it is what the screen actually renders for
 * an English reader, and every other locale falls back to it key by key.
 */
const copy = Object.entries(en)
  .filter(([key]) => key.startsWith("community.consent") || key.startsWith("community.off") || key.startsWith("community.airgap"))
  .map(([, value]) => value)
  .join("\n")

// The bullet COUNT is still a fact about the markup, so it is still read from the component.
const markup = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "")

describe("the consent screen states every cost", () => {
  test("🔴 the preamble COUNTS the bullets it introduces", () => {
    /**
     * It said "three things to know first" over four bullets for as long as the fourth existed
     * (review 1.15). A miscount reads as carelessness on the one screen whose whole job is that a
     * person can trust what it says, and it is the cheapest possible thing to get right.
     */
    expect(copy).toContain("four things to know first")
    const bullets = markup.split("<li").length - 1
    expect(bullets, "four bullets, and the preamble says four").toBe(4)
  })

  test("🔴 nobody moderates it, and blocking is the only power anyone has", () => {
    expect(copy).toContain("Nobody moderates this")
    expect(copy).toContain("no one")
  })

  test("🔴 peers learn this machine's IP, because there is no server in between", () => {
    expect(copy).toContain("Other people will see your IP address")
  })

  test("🔴 an address travels onward, and being LISTED is a separate decision", () => {
    /**
     * A different sentence from the IP one: "the people you speak to know where you are" is the cost
     * of a direct connection; "your address travels onward through peer exchange" is the cost of a
     * network with no directory server.
     *
     * 🔴 **This used to assert the copy said instances "announce themselves in a shared public
     * directory", which was FALSE for the default install** (review 1.15). Nothing is published
     * unless the user sets an address; the config's own comment calls that the strongest of the four
     * decisions and ships it off. Overstating a cost is its own dishonesty — somebody who declined
     * over a consequence that was never going to happen was misled too.
     */
    expect(copy, "what is true by default: addresses spread through the peers you meet").toContain(
      "address spreads to the people you meet",
    )
    expect(copy, "and what is not: being listed for strangers is the user's own switch").toContain("separate switch")
    expect(copy, "…which is OFF until they set it").toContain("stays off")
    // The old claim must not come back: it is the sentence the review measured as untrue.
    expect(copy, "the default install announces nothing").not.toContain("Instances announce themselves")
  })

  test("🔴 the instance keeps AI-WRITTEN notes about identifiable people — §5(k)", () => {
    /**
     * The only disclosure that is about the user's OWN machine rather than about what leaves it, and
     * the one the honesty spec makes a release condition. It was missing until 2026-08-17, by which
     * time the store, the agent's operations and the automatic recording of every question asked had
     * all shipped.
     */
    expect(copy).toContain("keeps notes about people")
    // ⚠️ Three specifics, because the general sentence is the easy half. Who wrote them, that they
    // are about identifiable people, and that they never leave — each is a separate question a
    // reasonable person would ask, and a summary that dropped one would be the wrong summary.
    expect(copy, "who writes them").toContain("written by the AI")
    /**
     * 🔴 "Nothing is published or shared" was the first wording, and it was a promise the software
     * cannot keep on its own. Nothing SENDS the notes — verified: no peer door serves them, and `sync`
     * only ever writes them — but the user's own agent reads them, which is their entire purpose, and
     * an agent that can also speak could quote one into a room.
     *
     * ⚠️ So the screen says the part that is true of the SOFTWARE and names the part that is true
     * of the AGENT, rather than a sentence a careful reader could catch us out on. A consent screen
     * is the last place to be approximately right.
     */
    expect(copy, "and that nothing sends them").toContain("no peer can ask for them")
    expect(copy, "while naming who does read them").toContain("agent does read them")
    expect(copy, "and that forgetting is real — the code now keeps this promise").toContain("Forgetting")
  })

  test("⚠️ and the control: this file is reading the RENDERED copy, not a comment", () => {
    /**
     * Every assertion above would pass just as well against the explanatory comments beside the
     * markup, which is exactly the failure mode of a source-scanning test. Stripping them first is
     * what makes this about what a user sees.
     */
    expect(source, "the fixture must contain comments to strip, or stripping proves nothing").toContain("/*")
    // A promise made in a comment is not a promise: the dictionary carries no commentary at all, and
    // the markup is read with comments removed.
    expect(copy).not.toContain("a person cannot consent to what they were not told")
    expect(markup).not.toContain("a person cannot consent to what they were not told")
    // ⚠️ And the dictionary really is the source now — if this ever reads empty, every assertion
    // above passes vacuously.
    expect(copy.length, "the consent keys must exist in the dictionary").toBeGreaterThan(500)
  })
})
