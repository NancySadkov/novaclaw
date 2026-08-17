import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

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

/** The screen's own rendered copy, comments stripped — a promise made in a comment is not a promise. */
const copy = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "")

describe("the consent screen states every cost", () => {
  test("🔴 nobody moderates it, and blocking is the only power anyone has", () => {
    expect(copy).toContain("Nobody moderates this")
    expect(copy).toContain("no one")
  })

  test("🔴 peers learn this machine's IP, because there is no server in between", () => {
    expect(copy).toContain("Other people will see your IP address")
  })

  test("🔴 being findable is public — the price of a directory nobody runs", () => {
    // Added when the DHT shipped. A different sentence from the IP one: "the people you speak to
    // know where you are" is the cost of a direct connection; "this software's users are a public
    // list" is the cost of a public directory, and somebody in a country where the second is
    // dangerous deserves to be told the second.
    expect(copy).toContain("Being findable is public")
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
    expect(copy).not.toContain("a person cannot consent to what they were not told")
  })
})
