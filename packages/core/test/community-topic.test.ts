import { describe, expect, test } from "bun:test"
import { CommunityTopic } from "@novaclaw/core/community/topic"

/**
 * Community P4 — channel name ↔ topic (`notes/spec/community-p2p.md`).
 *
 * A gossip network addresses by topic id; people speak in names. The hazard this module exists to
 * prevent is the one nobody sees: two spellings of a name hashing to two topics, so a user sits
 * alone in a room that looks correct, posting to nobody, with nothing anywhere to tell them.
 */

describe("CommunityTopic", () => {
  test("🔴 spellings of one name are ONE channel", () => {
    const canonical = CommunityTopic.topicOf("#NovaClaw")
    // Hashing the literal string would be simpler and would silently create parallel rooms. In a
    // network with no directory, nothing would ever report the mistake.
    for (const spelling of ["#novaclaw", "NovaClaw", " #NovaClaw ", "#NOVACLAW", "novaclaw"])
      expect(CommunityTopic.topicOf(spelling)).toBe(canonical)
  })

  test("different names are different topics", () => {
    expect(CommunityTopic.topicOf("#NovaClaw")).not.toBe(CommunityTopic.topicOf("#novaclaw-dev"))
    expect(CommunityTopic.topicOf("#a")).not.toBe(CommunityTopic.topicOf("#b"))
  })

  test("a topic is a 32-byte hex id, stable across calls", () => {
    const topic = CommunityTopic.topicOf("#NovaClaw")
    expect(topic).toHaveLength(64)
    expect(topic).toMatch(/^[0-9a-f]+$/)
    // Deterministic, because two instances must derive the same id without coordinating.
    expect(CommunityTopic.topicOf("#NovaClaw")).toBe(topic)
  })

  test("🔴 the topic is DOMAIN-SEPARATED from other hashes this program computes", () => {
    // Message ids are `sha256(canonical bytes)`. Without a prefix, a topic id and a message id share
    // a space, and an id from one could be mistaken for the other.
    const bare = require("node:crypto").createHash("sha256").update("novaclaw").digest("hex")
    expect(CommunityTopic.topicOf("#novaclaw")).not.toBe(bare)
  })

  test("🔴 a topic resolves ONLY to a channel we joined", () => {
    const joined = ["#NovaClaw", "#recipes"]
    expect(CommunityTopic.channelFor(CommunityTopic.topicOf("#NovaClaw"), joined)).toBe("#NovaClaw")
    // Case-insensitively, because the topic is what identifies the channel, not the spelling.
    expect(CommunityTopic.channelFor(CommunityTopic.topicOf("#novaclaw"), joined)).toBe("#NovaClaw")

    // A hash cannot be inverted, so a topic for a channel we never joined is UNRESOLVABLE — which
    // makes "not subscribed" a fact of arithmetic rather than a check somebody could forget.
    expect(CommunityTopic.channelFor(CommunityTopic.topicOf("#elsewhere"), joined)).toBeUndefined()
    expect(CommunityTopic.channelFor("not-a-topic", joined)).toBeUndefined()
    expect(CommunityTopic.channelFor(CommunityTopic.topicOf("#NovaClaw"), [])).toBeUndefined()
  })
})
