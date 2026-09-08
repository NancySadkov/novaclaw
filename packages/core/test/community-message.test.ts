import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * Community P4 — the signed channel message (`notes/spec/community-p2p.md`).
 *
 * There is no moderator and no server, so the signature is the only thing that makes "who said this"
 * mean anything. These pin the ways that guarantee gets quietly lost: an ambiguous encoding, a
 * message replayed into another channel, and an author field the sender gets to choose.
 */

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, InstanceIdentityStore.node])))

describe("CommunityMessage", () => {
  it.effect("a signed message verifies, and any edit breaks it", () =>
    Effect.gen(function* () {
      const message = yield* CommunityMessage.sign({ channel: "#NovaClaw", body: "hello" })
      expect(CommunityMessage.verify(message)).toBe(true)
      expect(message.author).toStartWith("nid_")

      // Every signed field is actually covered — a signature over only some of them would let the
      // rest be rewritten in flight.
      expect(CommunityMessage.verify({ ...message, body: "hellp" })).toBe(false)
      expect(CommunityMessage.verify({ ...message, channel: "#other" })).toBe(false)
      expect(CommunityMessage.verify({ ...message, at: message.at + 1 })).toBe(false)
      expect(CommunityMessage.verify({ ...message, author: `nid_${Buffer.alloc(32, 9).toString("base64url")}` })).toBe(
        false,
      )
    }),
  )

  it.effect("🔴 field boundaries are unambiguous — the concatenation attack", () =>
    Effect.gen(function* () {
      // ⚠️ This test was WRONG on its first writing and passed with the length prefixes removed. It
      // shifted a character between `channel` and `body`, which are not adjacent — `body` sits
      // behind the fixed-width timestamp, so no concatenation could confuse them. The property is
      // only at risk between two ADJACENT VARIABLE-LENGTH fields, here `channel` and `author`.
      const base = { at: 1_700_000_000_000, body: "b", signature: "" }
      const left = CommunityMessage.canonicalBytes({ ...base, channel: "#a", author: "bc" })
      const right = CommunityMessage.canonicalBytes({ ...base, channel: "#ab", author: "c" })

      // Concatenated, both are "…#abc…" and one signature would validate a message its author never
      // wrote. Length prefixes are the whole defence.
      expect(Buffer.from(left).equals(Buffer.from(right))).toBe(false)

      // And the same for the domain/channel boundary.
      const shiftedDomain = CommunityMessage.canonicalBytes({ ...base, channel: "a", author: "bc" })
      expect(Buffer.from(shiftedDomain).equals(Buffer.from(left))).toBe(false)
    }),
  )

  it.effect("🔴 a valid message from another channel is REFUSED on this one", () =>
    Effect.gen(function* () {
      // A hostile peer can rebroadcast a genuinely-signed message onto a different topic. The
      // signature still checks out; only comparing the channel catches it.
      const elsewhere = yield* CommunityMessage.sign({ channel: "#elsewhere", body: "out of context" })
      expect(CommunityMessage.verify(elsewhere)).toBe(true)
      expect(CommunityMessage.verifyOn("#NovaClaw", elsewhere)).toBe(false)
      expect(CommunityMessage.verifyOn("#elsewhere", elsewhere)).toBe(true)
    }),
  )

  it.effect("the author is taken from OUR identity, not from the caller", () =>
    Effect.gen(function* () {
      const identity = yield* InstanceIdentityStore.Service.pipe(Effect.flatMap((s) => s.identity()))
      const message = yield* CommunityMessage.sign({ channel: "#NovaClaw", body: "x" })
      // A signing helper that accepted an `author` parameter would produce messages signed by us and
      // attributed to someone else — detectable, but only after broadcast.
      expect(message.author).toBe(identity.networkID)
    }),
  )

  it.effect("hostile nonsense returns false rather than throwing", () =>
    Effect.gen(function* () {
      const good = yield* CommunityMessage.sign({ channel: "#NovaClaw", body: "x" })
      const broken: CommunityMessage.Signed[] = [
        { ...good, signature: "" },
        { ...good, signature: "!!!!" },
        { ...good, signature: Buffer.alloc(8).toString("base64url") },
        { ...good, author: "alice" },
        { ...good, at: Number.NaN },
        { ...good, body: undefined as unknown as string },
      ]
      // A channel reader loops over whatever strangers send; a throw here is a crash in the loop.
      for (const message of broken) expect(CommunityMessage.verify(message)).toBe(false)
    }),
  )

  it.effect("the domain tag is inside the signed bytes", () =>
    Effect.gen(function* () {
      const message = yield* CommunityMessage.sign({ channel: "#NovaClaw", body: "x" })
      const bytes = Buffer.from(CommunityMessage.canonicalBytes(message)).toString("utf8")
      // So a signature made here cannot be replayed as some other NovaClaw message type that
      // happens to sign the same fields.
      expect(bytes).toContain("novaclaw/community/channel-message/1")
    }),
  )
})
