import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { mergePeer } from "./peer-token"
import { dict as en } from "@/i18n/en"

/**
 * A STORED PEER TOKEN MUST SURVIVE AN EDIT THAT DOES NOT MENTION IT.
 *
 * The falsification: *re-adding an existing peer with the token field left blank must leave the
 * stored token intact.* Before the fix it did not — adding REPLACES the same-name peer wholesale and
 * the config write omits a falsy token, so the secret was gone with nothing on screen saying so, and
 * the next agent run against that instance simply failed to authenticate.
 *
 * ⚠️ That is the shape the product's own scan picker produces: it fills name and url from the
 * discovered instance and leaves the token blank. The bug was one click away from a normal workflow.
 */

const SAVED = { name: "spark", url: "http://spark:4096", token: "sk-stored" }

describe("merging a peer edit", () => {
  test("🔴 a BLANK token keeps the stored one", () => {
    expect(mergePeer({ draft: { name: "spark", url: "http://spark:4096", token: "" }, existing: SAVED })).toEqual(SAVED)
  })

  test("…whitespace is blank too", () => {
    expect(
      mergePeer({ draft: { name: "spark", url: "http://spark:4096", token: "   " }, existing: SAVED })?.token,
    ).toBe("sk-stored")
  })

  test("…as is an absent field", () => {
    expect(mergePeer({ draft: { name: "spark", url: "http://spark:4096" }, existing: SAVED })?.token).toBe("sk-stored")
  })

  test("🔴 a TYPED token replaces the stored one", () => {
    // The control. Without it, a merge that ignored the draft's token entirely would pass every test
    // above — "keeps the secret" and "cannot change the secret" look identical from the other three.
    expect(mergePeer({ draft: { name: "spark", url: "http://spark:4096", token: "sk-new" }, existing: SAVED })).toEqual(
      {
        name: "spark",
        url: "http://spark:4096",
        token: "sk-new",
      },
    )
  })

  test("a NEW peer with no token stores none — not an empty string", () => {
    // The stored shape must not depend on which path produced it.
    const merged = mergePeer({ draft: { name: "fresh", url: "http://fresh:4096", token: "" } })
    expect(merged).toEqual({ name: "fresh", url: "http://fresh:4096" })
    expect("token" in merged!).toBe(false)
  })

  test("an existing peer that never had a token still gets none", () => {
    expect(
      mergePeer({ draft: { name: "bare", url: "http://bare:4096" }, existing: { name: "bare", url: "u" } }),
    ).toEqual({ name: "bare", url: "http://bare:4096" })
  })

  test("the url comes from the DRAFT — only the secret is inherited", () => {
    // A peer that moved must be reachable at its new address.
    expect(mergePeer({ draft: { name: "spark", url: "http://moved:5000" }, existing: SAVED })).toEqual({
      name: "spark",
      url: "http://moved:5000",
      token: "sk-stored",
    })
  })

  test("name and url are trimmed", () => {
    expect(mergePeer({ draft: { name: "  spark  ", url: "  http://spark:4096  " } })).toEqual({
      name: "spark",
      url: "http://spark:4096",
    })
  })

  test("an incomplete draft stores NOTHING", () => {
    // Not a peer with an empty url: a half-written row that silently became a broken peer would be
    // worse than the button appearing to do nothing.
    expect(mergePeer({ draft: { name: "", url: "http://x" } })).toBeUndefined()
    expect(mergePeer({ draft: { name: "x", url: "  " } })).toBeUndefined()
  })
})

/**
 * …AND THE SCREEN ACTUALLY USES IT.
 *
 * 🔴 The rule above can be perfectly right while the component never calls it — a correct half joined
 * to nothing, which is a failure mode this programme has shipped before. These assert the JOIN: that
 * `addPeer` passes the stored peer as `existing`, that a saved peer can be loaded into the form at
 * all, and that the token is revealable. Source-text assertions in the house style of
 * `dialog-model-config.test.ts`, because no render harness reaches this component.
 */
describe("the screen is wired to the rule", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, "instances-access.tsx"), "utf8")

  test("🔴 addPeer passes the STORED peer as `existing`", () => {
    // Calling `mergePeer` without it would keep nothing — the bug, with the fix's shape.
    expect(source).toContain("existing: peers().find((peer) => peer.name === value.name.trim())")
  })

  test("🔴 a saved peer can be loaded into the form — the only way to SEE its token", () => {
    expect(source).toContain('token: peer.token ?? ""')
    expect(source).toContain('data-action="instances-peer-edit"')
    expect(source).toContain("onClick={() => editPeer(peer)}")
  })

  test("the token field is revealable, and masked until asked", () => {
    expect(source).toContain('type={revealPeerToken() ? "text" : "password"}')
    expect(source).toContain("createSignal(false)")
    expect(source).toContain('data-action="instances-peer-token-reveal"')
  })

  test("the reveal control is an EYE, and it changes with the state", () => {
    // An icon rather than a word: the control sits beside the field it acts on, so its meaning is
    // positional. A single unchanging icon would be worse than the text it replaced — the whole
    // point is that you can see, at a glance, which state the field is in.
    expect(source).toContain('icon={<Icon name={revealPeerToken() ? "eye-off" : "eye"} size="normal" />}')
    // The word survives for screen readers, which have no "beside" to read.
    expect(source).toContain("aria-label={language.t(")
  })

  test("editing one peer does not carry another's reveal state", () => {
    // Opening a second peer with the first still revealed would show a secret nobody asked to see.
    expect(source).toContain("setRevealPeerToken(false)")
  })

  test("every label it renders exists in `en`", () => {
    for (const key of ["settings.instances.peers.token.reveal", "settings.instances.peers.token.hide", "common.edit"]) {
      expect(typeof (en as Record<string, unknown>)[key], key).toBe("string")
    }
  })
})
